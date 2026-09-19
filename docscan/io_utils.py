"""Reading and writing image files, including non-ASCII (e.g. Korean) paths.

``cv2.imread`` and ``cv2.imwrite`` go through the C locale on Windows and fail
silently for paths that are not representable there, so every file access in
docscan goes through the helpers below instead.

Copyright 2026 PyCAM contributors

This file is part of the docscan document scanner.  It is free software:
you can redistribute it and/or modify it under the terms of the GNU General
Public License as published by the Free Software Foundation, either version 3
of the License, or (at your option) any later version.
"""

import os
import pathlib

import numpy as np

import cv2


#: file types that OpenCV can read out of the box
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".jpe", ".png", ".bmp", ".dib", ".tif", ".tiff",
                  ".webp", ".ppm", ".pgm", ".pbm", ".jp2", ".avif"}


class ImageReadError(Exception):
    """Raised when an image file cannot be read or decoded."""


def imread(path, flags=cv2.IMREAD_COLOR):
    """Read an image file; EXIF orientation is applied by the decoder."""
    path = pathlib.Path(path)
    try:
        raw = np.fromfile(str(path), dtype=np.uint8)
    except OSError as exc:
        raise ImageReadError("cannot read {}: {}".format(path, exc)) from exc
    if raw.size == 0:
        raise ImageReadError("cannot read {}: file is empty".format(path))
    image = cv2.imdecode(raw, flags)
    if image is None:
        raise ImageReadError("cannot decode {}: unsupported or broken image".format(path))
    return image


def imwrite(path, image, quality=92, png_compression=6):
    """Write an image file, choosing sensible encoder parameters by suffix."""
    path = pathlib.Path(path)
    suffix = path.suffix.lower()
    if not suffix:
        raise ValueError("output path {} has no file extension".format(path))
    parameters = []
    if suffix in (".jpg", ".jpeg", ".jpe"):
        parameters = [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)]
    elif suffix == ".png":
        parameters = [int(cv2.IMWRITE_PNG_COMPRESSION), int(png_compression)]
    elif suffix == ".webp":
        parameters = [int(cv2.IMWRITE_WEBP_QUALITY), int(quality)]
    success, buffer = cv2.imencode(suffix, image, parameters)
    if not success:
        raise OSError("failed to encode image as {}".format(suffix))
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as image_file:
        image_file.write(buffer.tobytes())
    return path


def collect_images(paths, recursive=False):
    """Expand files and directories into a sorted list of image paths."""
    collected = []
    for entry in paths:
        entry = pathlib.Path(entry)
        if entry.is_dir():
            pattern = "**/*" if recursive else "*"
            collected.extend(sorted(child for child in entry.glob(pattern)
                                    if child.is_file()
                                    and child.suffix.lower() in IMAGE_SUFFIXES))
        elif entry.is_file():
            collected.append(entry)
        else:
            raise ImageReadError("no such file or directory: {}".format(entry))
    return collected


def unique_path(path):
    """Return ``path`` or, if it exists, the first free ``name-2.ext`` variant."""
    path = pathlib.Path(path)
    if not path.exists():
        return path
    for counter in range(2, 1000):
        candidate = path.with_name("{}-{}{}".format(path.stem, counter, path.suffix))
        if not candidate.exists():
            return candidate
    raise OSError("cannot find a free file name next to {}".format(path))


def human_size(byte_count):
    """Format a byte count for log output."""
    size = float(byte_count)
    for unit in ("B", "kB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            if unit == "B":
                return "{:.0f} {}".format(size, unit)
            return "{:.1f} {}".format(size, unit)
        size /= 1024
    return "{:.1f} GB".format(size)


def default_scan_name(prefix="scan", suffix=".pdf", when=None):
    """Build a timestamped output name such as ``scan-20260919-143002.pdf``."""
    import datetime
    when = when or datetime.datetime.now()
    return "{}-{}{}".format(prefix, when.strftime("%Y%m%d-%H%M%S"), suffix)


def describe_path(path):
    """Return a short, printable form of a path (relative when possible)."""
    path = pathlib.Path(path)
    try:
        return str(path.relative_to(pathlib.Path(os.getcwd())))
    except ValueError:
        return str(path)
