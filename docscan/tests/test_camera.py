"""Tests for the live capture logic, using a fake camera device."""

import contextlib
import io
import unittest
from unittest import mock

from docscan.tests import HAVE_OPENCV, requires_opencv

if HAVE_OPENCV:
    import numpy as np

    from docscan.camera import (CameraError, CameraOptions, CameraScanner, HeadlessError,
                                _fit_preview, capture_single, open_camera, probe_devices)
    from docscan.enhance import MODES
    from docscan.scanner import ScanOptions
    from docscan.tests.synthetic import photograph


class FakeCapture:
    """The small part of ``cv2.VideoCapture`` that docscan actually uses."""

    def __init__(self, frames=None, opened=True, fails_after=None):
        self.frames = frames or []
        self.opened = opened
        self.fails_after = fails_after
        self.reads = 0
        self.released = False
        self.properties = {}

    def isOpened(self):
        return self.opened

    def set(self, prop, value):
        self.properties[prop] = value
        return True

    def read(self):
        self.reads += 1
        if self.fails_after is not None and self.reads > self.fails_after:
            return False, None
        if not self.frames:
            return False, None
        return True, self.frames[(self.reads - 1) % len(self.frames)]

    def release(self):
        self.released = True


@contextlib.contextmanager
def fake_camera(capture):
    with mock.patch("docscan.camera.cv2.VideoCapture", return_value=capture):
        yield capture


@requires_opencv
class TestCameraOptions(unittest.TestCase):

    def test_numeric_devices_become_indices(self):
        self.assertEqual(CameraOptions(device="0").resolve_device(), 0)
        self.assertEqual(CameraOptions(device=2).resolve_device(), 2)

    def test_other_devices_stay_strings(self):
        self.assertEqual(CameraOptions(device="/dev/video1").resolve_device(), "/dev/video1")
        self.assertEqual(CameraOptions(device="rtsp://host/stream").resolve_device(),
                         "rtsp://host/stream")


@requires_opencv
class TestOpenCamera(unittest.TestCase):

    def test_applies_the_requested_resolution(self):
        capture = FakeCapture(frames=[photograph()[0]])
        with fake_camera(capture):
            opened = open_camera(CameraOptions(width=1280, height=720))
        self.assertIs(opened, capture)
        self.assertEqual(sorted(capture.properties.values()), [720, 1280])

    def test_unavailable_device_is_reported(self):
        capture = FakeCapture(opened=False)
        with fake_camera(capture):
            with self.assertRaises(CameraError):
                open_camera(CameraOptions(device="7"))
        self.assertTrue(capture.released)

    def test_probe_devices_lists_working_cameras(self):
        photo = photograph()[0]

        def factory(index, *args, **kwargs):
            return FakeCapture(frames=[photo] if index == 0 else [], opened=index < 2)

        with mock.patch("docscan.camera.cv2.VideoCapture", side_effect=factory):
            devices = probe_devices(maximum=3)
        self.assertEqual(devices, [(0, photo.shape[1], photo.shape[0])])


@requires_opencv
class TestPreviewFrame(unittest.TestCase):

    def test_preview_never_shares_the_capture_buffer(self):
        # the overlay is drawn onto the preview while the same frame is used
        # for the capture, so it must be a separate buffer
        photo, _ = photograph()
        for width in (photo.shape[1] * 2, photo.shape[1] // 2):
            with self.subTest(preview_width=width):
                preview, scale = _fit_preview(photo, width)
                preview[:] = 0
                self.assertTrue(np.any(photo != 0))
                self.assertAlmostEqual(preview.shape[1] * 1.0 / scale, photo.shape[1],
                                       delta=1.0)


@requires_opencv
class TestCaptureSession(unittest.TestCase):

    def _scanner(self, **kwargs):
        return CameraScanner(ScanOptions(mode="none"), CameraOptions(**kwargs))

    def test_capture_detects_and_stores_a_page(self):
        photo, _ = photograph()
        scanner = self._scanner()
        result = scanner.capture(photo)
        self.assertEqual(len(scanner.pages), 1)
        self.assertTrue(result.cropped)
        self.assertLess(result.size[0] * result.size[1], photo.shape[0] * photo.shape[1])

    def test_undo_removes_the_last_page(self):
        photo, _ = photograph()
        scanner = self._scanner()
        scanner.capture(photo)
        self.assertIsNotNone(scanner.undo())
        self.assertEqual(scanner.pages, [])
        self.assertIsNone(scanner.undo())

    def test_cycling_walks_through_every_mode(self):
        scanner = CameraScanner(ScanOptions(mode=MODES[0]), CameraOptions())
        seen = [scanner.cycle_mode() for _ in range(len(MODES))]
        self.assertEqual(sorted(seen), sorted(MODES))
        self.assertEqual(scanner.scan_options.mode, MODES[0])

    def test_rotation_wraps_around(self):
        scanner = self._scanner()
        self.assertEqual([scanner.rotate() for _ in range(4)], [90, 180, 270, 0])

    def test_callback_is_informed_about_every_page(self):
        photo, _ = photograph()
        seen = []
        scanner = CameraScanner(ScanOptions(mode="none"), CameraOptions(),
                                on_capture=lambda result, count: seen.append(count))
        scanner.capture(photo)
        scanner.capture(photo)
        self.assertEqual(seen, [1, 2])


@requires_opencv
class TestTerminalSession(unittest.TestCase):

    def _run(self, answers, frames=None):
        photo, _ = photograph()
        capture = FakeCapture(frames=frames or [photo])
        scanner = CameraScanner(ScanOptions(mode="none"), CameraOptions())
        replies = iter(answers)
        with fake_camera(capture):
            pages = scanner.run_without_preview(prompt=lambda _: next(replies),
                                                echo=lambda *args: None)
        self.assertTrue(capture.released)
        return scanner, pages

    def test_capture_and_quit(self):
        _, pages = self._run(["", "", "q"])
        self.assertEqual(len(pages), 2)

    def test_undo_inside_the_session(self):
        _, pages = self._run(["", "u", "q"])
        self.assertEqual(pages, [])

    def test_discard_drops_everything(self):
        _, pages = self._run(["", "", "x"])
        self.assertEqual(pages, [])

    def test_mode_can_be_changed(self):
        scanner, _ = self._run(["m", "q"])
        self.assertNotEqual(scanner.scan_options.mode, "none")

    def test_end_of_input_finishes_the_session(self):
        def prompt(_):
            raise EOFError

        photo, _ = photograph()
        capture = FakeCapture(frames=[photo])
        scanner = CameraScanner(ScanOptions(mode="none"), CameraOptions())
        with fake_camera(capture):
            pages = scanner.run_without_preview(prompt=prompt, echo=lambda *args: None)
        self.assertEqual(pages, [])

    def test_a_broken_camera_is_reported(self):
        photo, _ = photograph()
        capture = FakeCapture(frames=[photo], fails_after=0)
        scanner = CameraScanner(ScanOptions(mode="none"), CameraOptions())
        replies = iter([""])
        with fake_camera(capture):
            with self.assertRaises(CameraError):
                scanner.run_without_preview(prompt=lambda _: next(replies),
                                            echo=lambda *args: None)
        self.assertTrue(capture.released)


@requires_opencv
class TestSingleShot(unittest.TestCase):

    def test_returns_a_scanned_page(self):
        photo, _ = photograph()
        capture = FakeCapture(frames=[photo])
        with fake_camera(capture):
            result = capture_single(CameraOptions(), ScanOptions(mode="gray"))
        self.assertTrue(result.cropped)
        self.assertEqual(result.image.ndim, 2)
        self.assertTrue(capture.released)

    def test_a_camera_without_frames_is_reported(self):
        capture = FakeCapture(frames=[])
        with fake_camera(capture):
            with self.assertRaises(CameraError):
                capture_single(CameraOptions())


@requires_opencv
class TestHeadlessReporting(unittest.TestCase):

    def test_the_command_line_explains_a_missing_gui(self):
        from docscan.cli import main
        error = HeadlessError("no GUI support, install opencv-python")
        with mock.patch("docscan.camera.CameraScanner.run", side_effect=error):
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                code = main(["camera"])
        self.assertEqual(code, 1)
        self.assertIn("opencv-python", stderr.getvalue())
