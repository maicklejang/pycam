"""Tests for the scanning pipeline and the file helpers."""

import tempfile
import unittest
from pathlib import Path

from docscan.tests import HAVE_OPENCV, requires_opencv

if HAVE_OPENCV:
    import numpy as np

    from docscan.io_utils import (ImageReadError, collect_images, human_size, imread,
                                  imwrite, unique_path)
    from docscan.scanner import ScanOptions, scan_image
    from docscan.tests.synthetic import photograph, render_background

A4_RATIO = 210.0 / 297.0


@requires_opencv
class TestScanImage(unittest.TestCase):

    def test_crops_and_straightens_the_page(self):
        photo, _ = photograph(rotation=(0.3, 0.4, 0.15), lighting=0.5)
        result = scan_image(photo, ScanOptions(mode="color"))
        self.assertTrue(result.cropped)
        self.assertIsNotNone(result.detection)
        width, height = result.size
        self.assertAlmostEqual(width / height, A4_RATIO, delta=0.05)
        self.assertLess(width * height, photo.shape[0] * photo.shape[1])

    def test_lighting_is_evened_out(self):
        photo, _ = photograph(lighting=0.6)
        result = scan_image(photo, ScanOptions(mode="gray"))
        page = result.image
        columns = [float(page[:, index:index + 20].mean())
                   for index in range(0, page.shape[1] - 20, 20)]
        self.assertLess(max(columns) - min(columns), 25.0)

    def test_without_a_page_the_photo_is_kept(self):
        photo = render_background("wood", (480, 640))
        result = scan_image(photo, ScanOptions(mode="none"))
        self.assertFalse(result.cropped)
        self.assertIsNone(result.detection)
        self.assertEqual(result.image.shape, photo.shape)

    def test_crop_can_be_switched_off(self):
        photo, _ = photograph()
        result = scan_image(photo, ScanOptions(crop=False, mode="none"))
        self.assertFalse(result.cropped)
        np.testing.assert_array_equal(result.image, photo)

    def test_rotation_is_applied_to_the_result(self):
        photo, _ = photograph()
        upright = scan_image(photo, ScanOptions(mode="none"))
        turned = scan_image(photo, ScanOptions(mode="none", rotate=90))
        self.assertEqual(turned.size, tuple(reversed(upright.size)))

    def test_max_side_limits_the_resolution(self):
        photo, _ = photograph()
        result = scan_image(photo, ScanOptions(mode="none", max_side=200))
        self.assertLessEqual(max(result.size), 200)

    def test_a_known_detection_is_reused(self):
        photo, _ = photograph()
        quad = [[100, 100], [400, 110], [395, 500], [105, 480]]
        from docscan.detect import Detection
        detection = Detection(quad=np.array(quad, dtype=float), score=1.0, method="manual")
        result = scan_image(photo, ScanOptions(mode="none"), detection=detection)
        self.assertIs(result.detection, detection)
        self.assertTrue(result.cropped)

    def test_empty_input_is_rejected(self):
        with self.assertRaises(ValueError):
            scan_image(None, ScanOptions())
        with self.assertRaises(ValueError):
            scan_image(np.zeros((0, 0, 3), np.uint8), ScanOptions())


@requires_opencv
class TestScanOptions(unittest.TestCase):

    def test_defaults_are_valid(self):
        self.assertIs(ScanOptions().validate().__class__, ScanOptions)

    def test_invalid_values_are_reported(self):
        for options in (ScanOptions(mode="sepia"), ScanOptions(shadow=2.0),
                        ScanOptions(margin=3.0), ScanOptions(rotate=45)):
            with self.subTest(options=options):
                with self.assertRaises(ValueError):
                    options.validate()


@requires_opencv
class TestFileHelpers(unittest.TestCase):

    def test_reads_and_writes_non_ascii_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "한글 이름.png"
            image = np.full((20, 30, 3), 128, np.uint8)
            imwrite(path, image)
            self.assertTrue(path.exists())
            np.testing.assert_array_equal(imread(path), image)

    def test_jpeg_quality_changes_the_file_size(self):
        with tempfile.TemporaryDirectory() as directory:
            image = (np.random.default_rng(0)
                     .integers(0, 255, (200, 200, 3), dtype=np.uint8))
            low = Path(directory) / "low.jpg"
            high = Path(directory) / "high.jpg"
            imwrite(low, image, quality=20)
            imwrite(high, image, quality=95)
            self.assertLess(low.stat().st_size, high.stat().st_size)

    def test_missing_and_broken_files_are_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            broken = Path(directory) / "broken.png"
            broken.write_bytes(b"this is not an image")
            with self.assertRaises(ImageReadError):
                imread(broken)
            with self.assertRaises(ImageReadError):
                imread(Path(directory) / "missing.png")

    def test_path_without_suffix_is_rejected(self):
        with self.assertRaises(ValueError):
            imwrite(Path("output"), np.zeros((4, 4), np.uint8))

    def test_collect_images_expands_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "sub").mkdir()
            for name in ("b.jpg", "a.png", "notes.txt"):
                (root / name).write_bytes(b"x")
            (root / "sub" / "c.jpg").write_bytes(b"x")
            flat = collect_images([root])
            self.assertEqual([path.name for path in flat], ["a.png", "b.jpg"])
            deep = collect_images([root], recursive=True)
            self.assertEqual([path.name for path in deep], ["a.png", "b.jpg", "c.jpg"])
            # explicitly named files are used even with an unknown suffix
            self.assertEqual(collect_images([root / "notes.txt"]), [root / "notes.txt"])

    def test_collect_images_reports_missing_entries(self):
        with self.assertRaises(ImageReadError):
            collect_images(["/definitely/not/here"])

    def test_unique_path_avoids_overwriting(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "scan.pdf"
            self.assertEqual(unique_path(path), path)
            path.write_bytes(b"x")
            self.assertEqual(unique_path(path).name, "scan-2.pdf")

    def test_human_size(self):
        self.assertEqual(human_size(512), "512 B")
        self.assertEqual(human_size(2048), "2.0 kB")
        self.assertEqual(human_size(5 * 1024 * 1024), "5.0 MB")
