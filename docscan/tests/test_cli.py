"""Tests for the command line interface."""

import contextlib
import io
import tempfile
import unittest
from pathlib import Path

from docscan.tests import HAVE_OPENCV, requires_opencv

if HAVE_OPENCV:
    from docscan.cli import main
    from docscan.io_utils import imwrite
    from docscan.tests.synthetic import photograph


@contextlib.contextmanager
def _captured():
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        yield out, err


def _sample_photos(directory, names=("문서-1.jpg", "page2.png")):
    paths = []
    for index, name in enumerate(names):
        photo, _ = photograph(rotation=(0.3 + 0.1 * index, 0.35, 0.1), lighting=0.4,
                              seed=index)
        path = Path(directory) / name
        imwrite(path, photo)
        paths.append(path)
    return paths


@requires_opencv
class TestScanCommand(unittest.TestCase):

    def test_writes_one_pdf_for_a_folder_of_photos(self):
        with tempfile.TemporaryDirectory() as directory:
            _sample_photos(directory)
            output = Path(directory) / "결과.pdf"
            with _captured() as (out, _):
                code = main(["scan", directory, "-o", str(output), "-m", "bw"])
            self.assertEqual(code, 0)
            self.assertTrue(output.exists())
            self.assertTrue(output.read_bytes().startswith(b"%PDF"))
            self.assertIn("2 pages", out.getvalue())

    def test_writes_one_image_per_photo_into_a_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = _sample_photos(directory)
            output = Path(directory) / "out"
            with _captured():
                code = main(["scan", directory, "-o", str(output), "-f", "png"])
            self.assertEqual(code, 0)
            for path in paths:
                self.assertTrue((output / "{}_scan.png".format(path.stem)).exists())

    def test_writes_next_to_the_input_without_an_output_option(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = _sample_photos(directory, names=("문서-1.jpg",))
            with _captured():
                code = main(["scan", str(paths[0])])
            self.assertEqual(code, 0)
            self.assertTrue((Path(directory) / "문서-1_scan.jpg").exists())

    def test_existing_files_are_not_overwritten_by_default(self):
        with tempfile.TemporaryDirectory() as directory:
            _sample_photos(directory, names=("page.jpg",))
            output = Path(directory) / "scan.pdf"
            for _ in range(2):
                with _captured():
                    self.assertEqual(main(["scan", directory, "-o", str(output)]), 0)
            self.assertTrue(output.exists())
            self.assertTrue((Path(directory) / "scan-2.pdf").exists())

    def test_overwrite_option_reuses_the_same_file(self):
        with tempfile.TemporaryDirectory() as directory:
            _sample_photos(directory, names=("page.jpg",))
            output = Path(directory) / "scan.pdf"
            for _ in range(2):
                with _captured():
                    main(["scan", directory, "-o", str(output), "--overwrite"])
            self.assertFalse((Path(directory) / "scan-2.pdf").exists())

    def test_debug_directory_gets_the_detected_outline(self):
        with tempfile.TemporaryDirectory() as directory:
            _sample_photos(directory, names=("page.jpg",))
            debug = Path(directory) / "debug"
            with _captured():
                main(["scan", directory, "-o", str(Path(directory) / "s.pdf"),
                      "--debug-dir", str(debug), "-v"])
            self.assertTrue((debug / "page_detected.jpg").exists())

    def test_additional_pdf_next_to_the_images(self):
        with tempfile.TemporaryDirectory() as directory:
            _sample_photos(directory)
            output = Path(directory) / "out"
            pdf = Path(directory) / "all.pdf"
            with _captured():
                main(["scan", directory, "-o", str(output), "--pdf", str(pdf)])
            self.assertTrue(pdf.exists())
            self.assertTrue(any(output.glob("*_scan.jpg")))

    def test_missing_input_is_an_error(self):
        with _captured() as (_, err):
            code = main(["scan", "/definitely/not/here"])
        self.assertEqual(code, 1)
        self.assertIn("no such file", err.getvalue())

    def test_folder_without_images_is_an_error(self):
        with tempfile.TemporaryDirectory() as directory:
            with _captured() as (_, err):
                code = main(["scan", directory])
            self.assertEqual(code, 1)
            self.assertIn("no image files", err.getvalue())

    def test_unreadable_file_is_reported_but_others_are_processed(self):
        with tempfile.TemporaryDirectory() as directory:
            _sample_photos(directory, names=("good.jpg",))
            (Path(directory) / "broken.png").write_bytes(b"not an image")
            with _captured() as (_, err):
                code = main(["scan", directory, "-o", str(Path(directory) / "s.pdf")])
            self.assertEqual(code, 1)
            self.assertIn("cannot decode", err.getvalue())
            self.assertTrue((Path(directory) / "s.pdf").exists())

    def test_invalid_option_value_is_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            _sample_photos(directory, names=("page.jpg",))
            with _captured() as (_, err):
                code = main(["scan", directory, "--shadow", "5"])
            self.assertEqual(code, 1)
            self.assertIn("shadow", err.getvalue())

    def test_quiet_suppresses_the_progress_output(self):
        with tempfile.TemporaryDirectory() as directory:
            _sample_photos(directory, names=("page.jpg",))
            with _captured() as (out, _):
                main(["scan", directory, "-o", str(Path(directory) / "s.pdf"), "-q"])
            self.assertEqual(out.getvalue(), "")


@requires_opencv
class TestOtherCommands(unittest.TestCase):

    def test_modes_lists_every_mode(self):
        from docscan.enhance import MODES
        with _captured() as (out, _):
            self.assertEqual(main(["modes"]), 0)
        for mode in MODES:
            self.assertIn(mode, out.getvalue())

    def test_without_a_command_the_help_is_shown(self):
        with _captured() as (out, _):
            self.assertEqual(main([]), 2)
        self.assertIn("usage:", out.getvalue())

    def test_version(self):
        from docscan import VERSION
        with _captured() as (out, _):
            with self.assertRaises(SystemExit):
                main(["--version"])
        self.assertIn(VERSION, out.getvalue())

    def test_camera_reports_a_missing_device(self):
        with _captured() as (_, err):
            code = main(["camera", "--device", "99", "--no-preview"])
        self.assertEqual(code, 1)
        self.assertIn("camera", err.getvalue())
