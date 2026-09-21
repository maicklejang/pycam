"""A small dependency free PDF writer for scanned pages.

Colour and grayscale pages are embedded as JPEG (``DCTDecode``), bi-level
pages as deflated one-bit-per-pixel data (``FlateDecode``), which keeps pure
black and white scans very small and lossless.

Copyright 2026 PyCAM contributors

This file is part of the docscan document scanner.  It is free software:
you can redistribute it and/or modify it under the terms of the GNU General
Public License as published by the Free Software Foundation, either version 3
of the License, or (at your option) any later version.
"""

import datetime
import zlib

import numpy as np

import cv2


#: paper sizes in PostScript points (1/72 inch), portrait orientation
PAPER_SIZES = {
    "a3": (841.89, 1190.55),
    "a4": (595.28, 841.89),
    "a5": (419.53, 595.28),
    "letter": (612.0, 792.0),
    "legal": (612.0, 1008.0),
}


def _pdf_text(text):
    """Encode a string as a PDF text object.

    Plain ASCII is written as a literal string, everything else (Korean file
    names for example) as a UTF-16BE hex string, which every PDF reader
    understands.
    """
    text = str(text)
    try:
        ascii_text = text.encode("ascii").decode("ascii")
    except UnicodeEncodeError:
        return "<FEFF" + text.encode("utf-16-be").hex().upper() + ">"
    escaped = ascii_text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
    return "({})".format(escaped)


def _is_bilevel(image):
    """True for images that only contain pure black and pure white pixels."""
    if image.ndim != 2:
        return False
    values = np.unique(image)
    return values.size <= 2 and bool(np.all(np.isin(values, (0, 255))))


def _encode_image(image, quality):
    """Return (data, filter, colour space, bits per component) for one page."""
    if _is_bilevel(image):
        bits = (image > 127).astype(np.uint8)
        packed = np.packbits(bits, axis=1)
        return zlib.compress(packed.tobytes(), 9), "FlateDecode", "DeviceGray", 1
    if image.ndim == 2:
        colour_space = "DeviceGray"
        encoded = image
    else:
        colour_space = "DeviceRGB"
        encoded = image
    success, buffer = cv2.imencode(".jpg", encoded,
                                   [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)])
    if not success:
        raise RuntimeError("failed to JPEG-encode a page for the PDF")
    return buffer.tobytes(), "DCTDecode", colour_space, 8


def _page_box(image, dpi, page_size):
    """Return (page width, page height, draw width, draw height, x, y) in points."""
    height, width = image.shape[:2]
    natural_width = width * 72.0 / dpi
    natural_height = height * 72.0 / dpi
    if page_size in (None, "auto", "fit"):
        return natural_width, natural_height, natural_width, natural_height, 0.0, 0.0
    try:
        paper_width, paper_height = PAPER_SIZES[page_size]
    except KeyError:
        raise ValueError("unknown page size {!r}, expected one of auto, {}".format(
            page_size, ", ".join(sorted(PAPER_SIZES)))) from None
    if natural_width > natural_height:
        # landscape pages are printed on a rotated sheet
        paper_width, paper_height = paper_height, paper_width
    scale = min(paper_width / natural_width, paper_height / natural_height)
    draw_width = natural_width * scale
    draw_height = natural_height * scale
    return (paper_width, paper_height, draw_width, draw_height,
            (paper_width - draw_width) / 2.0, (paper_height - draw_height) / 2.0)


def pdf_bytes(images, dpi=300, quality=92, title=None, page_size="auto"):
    """Serialise a list of page images (numpy arrays) into a PDF document."""
    pages = [np.asarray(image) for image in images]
    if not pages:
        raise ValueError("at least one page is required")
    if dpi <= 0:
        raise ValueError("dpi must be positive")

    objects = []  # each entry is the body of an object, without the "N 0 obj" wrapper

    def add_object(body):
        objects.append(body)
        return len(objects)  # object numbers are 1 based

    catalog_number = add_object(b"")  # 1: placeholder, filled in below
    pages_number = add_object(b"")  # 2: placeholder

    page_numbers = []
    for index, image in enumerate(pages):
        if image.ndim == 3 and image.shape[2] == 3:
            # OpenCV keeps images in BGR order while PDF expects RGB
            image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        elif image.ndim == 3 and image.shape[2] == 4:
            image = cv2.cvtColor(image, cv2.COLOR_BGRA2RGB)
        data, filter_name, colour_space, bits = _encode_image(image, quality)
        height, width = image.shape[:2]
        (page_width, page_height, draw_width, draw_height,
         offset_x, offset_y) = _page_box(image, dpi, page_size)

        image_number = add_object(
            "<< /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace /{} "
            "/BitsPerComponent {} /Filter /{} /Length {} >>\nstream\n".format(
                width, height, colour_space, bits, filter_name, len(data)).encode("ascii")
            + data + b"\nendstream")

        content = "q\n{:.4f} 0 0 {:.4f} {:.4f} {:.4f} cm\n/Im{} Do\nQ\n".format(
            draw_width, draw_height, offset_x, offset_y, index).encode("ascii")
        content_number = add_object(
            "<< /Length {} >>\nstream\n".format(len(content)).encode("ascii")
            + content + b"\nendstream")

        page_numbers.append(add_object(
            "<< /Type /Page /Parent {} 0 R /MediaBox [0 0 {:.4f} {:.4f}] "
            "/Resources << /XObject << /Im{} {} 0 R >> >> /Contents {} 0 R >>".format(
                pages_number, page_width, page_height, index, image_number,
                content_number).encode("ascii")))

    objects[catalog_number - 1] = "<< /Type /Catalog /Pages {} 0 R >>".format(
        pages_number).encode("ascii")
    objects[pages_number - 1] = "<< /Type /Pages /Count {} /Kids [{}] >>".format(
        len(page_numbers),
        " ".join("{} 0 R".format(number) for number in page_numbers)).encode("ascii")

    timestamp = datetime.datetime.now().strftime("D:%Y%m%d%H%M%S")
    info_entries = ["/Producer (docscan)", "/CreationDate ({})".format(timestamp)]
    if title:
        info_entries.insert(0, "/Title {}".format(_pdf_text(title)))
    info_number = add_object("<< {} >>".format(" ".join(info_entries)).encode("ascii"))

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += "{} 0 obj\n".format(number).encode("ascii") + body + b"\nendobj\n"

    xref_offset = len(out)
    out += "xref\n0 {}\n".format(len(objects) + 1).encode("ascii")
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += "{:010d} 00000 n \n".format(offset).encode("ascii")
    out += "trailer\n<< /Size {} /Root {} 0 R /Info {} 0 R >>\nstartxref\n{}\n%%EOF\n".format(
        len(objects) + 1, catalog_number, info_number, xref_offset).encode("ascii")
    return bytes(out)


def write_pdf(path, images, dpi=300, quality=92, title=None, page_size="auto"):
    """Write the given page images to ``path`` as a single PDF document."""
    data = pdf_bytes(images, dpi=dpi, quality=quality, title=title, page_size=page_size)
    with open(path, "wb") as pdf_file:
        pdf_file.write(data)
    return len(data)
