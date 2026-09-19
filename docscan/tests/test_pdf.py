"""Tests for the built-in PDF writer.

The PDF is parsed back with plain regular expressions: the cross reference
table has to point at the right objects and the embedded image data has to
decode to the pages that went in.
"""

import re
import tempfile
import unittest
import zlib
from pathlib import Path

from docscan.tests import HAVE_OPENCV, requires_opencv

if HAVE_OPENCV:
    import numpy as np

    import cv2

    from docscan.pdf import PAPER_SIZES, pdf_bytes, write_pdf

IMAGE_PATTERN = re.compile(
    rb"/Width (\d+) /Height (\d+) /ColorSpace /(\w+) /BitsPerComponent (\d+) "
    rb"/Filter /(\w+) /Length (\d+) >>\nstream\n")


def _parse_xref(data):
    """Return the object offsets listed in the cross reference table."""
    start = int(re.search(rb"startxref\s+(\d+)", data).group(1))
    header = re.match(rb"xref\s+0 (\d+)\s+", data[start:])
    count = int(header.group(1))
    table = start + header.end()
    return [int(data[table + index * 20:table + index * 20 + 10]) for index in range(count)]


def _streams(data):
    """Yield (attributes, raw stream bytes) for every embedded image."""
    for match in IMAGE_PATTERN.finditer(data):
        width, height, colour_space, bits, filter_name, length = match.groups()
        payload = data[match.end():match.end() + int(length)]
        yield {"width": int(width), "height": int(height),
               "colour_space": colour_space.decode(), "bits": int(bits),
               "filter": filter_name.decode()}, payload


def _colour_page(width=400, height=600):
    page = np.full((height, width, 3), 245, np.uint8)
    cv2.rectangle(page, (40, 40), (width - 40, height - 40), (20, 20, 200), 6)
    return page


@requires_opencv
class TestPdfStructure(unittest.TestCase):

    def test_cross_reference_table_points_at_the_objects(self):
        data = pdf_bytes([_colour_page(), _colour_page()])
        self.assertTrue(data.startswith(b"%PDF-1.4"))
        self.assertTrue(data.rstrip().endswith(b"%%EOF"))
        offsets = _parse_xref(data)
        self.assertEqual(offsets[0], 0)
        for number, offset in enumerate(offsets[1:], start=1):
            expected = "{} 0 obj".format(number).encode("ascii")
            self.assertEqual(data[offset:offset + len(expected)], expected)

    def test_page_count_matches(self):
        for count in (1, 3, 7):
            data = pdf_bytes([_colour_page(100, 150)] * count)
            self.assertEqual(int(re.search(rb"/Count (\d+)", data).group(1)), count)
            self.assertEqual(len(re.findall(rb"/Type /Page\b", data)), count)

    def test_empty_document_is_rejected(self):
        with self.assertRaises(ValueError):
            pdf_bytes([])

    def test_invalid_dpi_is_rejected(self):
        with self.assertRaises(ValueError):
            pdf_bytes([_colour_page()], dpi=0)

    def test_unknown_page_size_is_rejected(self):
        with self.assertRaises(ValueError):
            pdf_bytes([_colour_page()], page_size="a0")


@requires_opencv
class TestPdfImages(unittest.TestCase):

    def test_colour_pages_are_stored_as_rgb_jpeg(self):
        page = _colour_page()
        attributes, payload = next(iter(_streams(pdf_bytes([page]))))
        self.assertEqual(attributes["filter"], "DCTDecode")
        self.assertEqual(attributes["colour_space"], "DeviceRGB")
        self.assertEqual((attributes["width"], attributes["height"]),
                         (page.shape[1], page.shape[0]))
        decoded = cv2.imdecode(np.frombuffer(payload, np.uint8), cv2.IMREAD_COLOR)
        # the decoder returns BGR again, so it must match the input closely
        self.assertLess(float(np.mean(np.abs(decoded.astype(float) - page.astype(float)))), 6.0)

    def test_grayscale_pages_stay_grayscale(self):
        page = cv2.cvtColor(_colour_page(), cv2.COLOR_BGR2GRAY)
        attributes, _ = next(iter(_streams(pdf_bytes([page]))))
        self.assertEqual(attributes["colour_space"], "DeviceGray")
        self.assertEqual(attributes["bits"], 8)

    def test_black_and_white_pages_are_stored_losslessly(self):
        page = (cv2.cvtColor(_colour_page(), cv2.COLOR_BGR2GRAY) > 200).astype(np.uint8) * 255
        attributes, payload = next(iter(_streams(pdf_bytes([page]))))
        self.assertEqual(attributes["filter"], "FlateDecode")
        self.assertEqual(attributes["bits"], 1)
        raw = zlib.decompress(payload)
        bits = np.unpackbits(np.frombuffer(raw, np.uint8).reshape(page.shape[0], -1),
                             axis=1)[:, :page.shape[1]]
        np.testing.assert_array_equal(bits * 255, page)

    def test_bi_level_pages_are_much_smaller_than_jpeg(self):
        page = (cv2.cvtColor(_colour_page(), cv2.COLOR_BGR2GRAY) > 200).astype(np.uint8) * 255
        bilevel = len(pdf_bytes([page]))
        as_gray = len(pdf_bytes([np.where(page > 0, 254, 1).astype(np.uint8)]))
        self.assertLess(bilevel, as_gray)


@requires_opencv
class TestPdfGeometry(unittest.TestCase):

    def _media_boxes(self, data):
        return [[float(value) for value in box.split()]
                for box in re.findall(rb"/MediaBox \[([^\]]+)\]", data)]

    def test_dpi_controls_the_page_size(self):
        page = _colour_page(300, 600)
        box = self._media_boxes(pdf_bytes([page], dpi=300))[0]
        self.assertAlmostEqual(box[2], 300 * 72 / 300, places=2)
        self.assertAlmostEqual(box[3], 600 * 72 / 300, places=2)
        box = self._media_boxes(pdf_bytes([page], dpi=150))[0]
        self.assertAlmostEqual(box[2], 300 * 72 / 150, places=2)

    def test_fixed_paper_size_is_used(self):
        box = self._media_boxes(pdf_bytes([_colour_page(400, 600)], page_size="a4"))[0]
        self.assertAlmostEqual(box[2], PAPER_SIZES["a4"][0], places=2)
        self.assertAlmostEqual(box[3], PAPER_SIZES["a4"][1], places=2)

    def test_landscape_pages_use_a_rotated_sheet(self):
        box = self._media_boxes(pdf_bytes([_colour_page(600, 400)], page_size="a4"))[0]
        self.assertAlmostEqual(box[2], PAPER_SIZES["a4"][1], places=2)
        self.assertAlmostEqual(box[3], PAPER_SIZES["a4"][0], places=2)

    def test_content_stream_scales_the_image_onto_the_sheet(self):
        data = pdf_bytes([_colour_page(400, 600)], page_size="a4")
        matrix = re.search(rb"q\n([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm", data)
        draw_width, draw_height = float(matrix.group(1)), float(matrix.group(2))
        offset_x, offset_y = float(matrix.group(3)), float(matrix.group(4))
        paper_width, paper_height = PAPER_SIZES["a4"]
        self.assertLessEqual(draw_width, paper_width + 0.01)
        self.assertLessEqual(draw_height, paper_height + 0.01)
        self.assertAlmostEqual(draw_width / draw_height, 400 / 600, places=3)
        self.assertAlmostEqual(offset_x * 2 + draw_width, paper_width, places=2)
        self.assertAlmostEqual(offset_y * 2 + draw_height, paper_height, places=2)


@requires_opencv
class TestPdfMetadata(unittest.TestCase):

    def test_ascii_title_is_written_as_a_literal_string(self):
        data = pdf_bytes([_colour_page()], title="Invoice (2026)")
        self.assertIn(rb"/Title (Invoice \(2026\))", data)

    def test_non_ascii_title_is_written_as_utf16(self):
        title = "테스트 스캔 문서"
        data = pdf_bytes([_colour_page()], title=title)
        encoded = re.search(rb"/Title <FEFF([0-9A-F]+)>", data).group(1)
        self.assertEqual(bytes.fromhex(encoded.decode()).decode("utf-16-be"), title)


@requires_opencv
class TestWritePdf(unittest.TestCase):

    def test_writes_a_file_and_reports_its_size(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "스캔.pdf"
            size = write_pdf(path, [_colour_page(), _colour_page()])
            self.assertTrue(path.exists())
            self.assertEqual(path.stat().st_size, size)
            self.assertTrue(path.read_bytes().startswith(b"%PDF"))
