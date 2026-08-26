"""
Copyright 2026 PyCAM contributors

This file is part of PyCAM.

PyCAM is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

PyCAM is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with PyCAM.  If not, see <http://www.gnu.org/licenses/>.


Tests for the Android scanner application below "android/".

The parts that do not draw anything are tested everywhere.  The test of the complete
application needs Kivy and a display - run it via "xvfb-run -a python3 -m pytest" on a
machine without a screen.
"""

import os
import sys
import unittest

import pycam.Test

ANDROID_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.realpath(__file__)))), "android")

try:
    import numpy as np
except ImportError:
    np = None

if ANDROID_DIR not in sys.path:
    sys.path.insert(0, ANDROID_DIR)

os.environ.setdefault("KIVY_NO_ARGS", "1")
os.environ.setdefault("KIVY_NO_CONSOLELOG", "1")

try:
    import kivy  # noqa: F401 (just a probe)
    HAS_KIVY = True
except ImportError:
    HAS_KIVY = False

HAS_DISPLAY = bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))

requires_app = unittest.skipUnless(
    HAS_KIVY and np is not None and os.path.isdir(ANDROID_DIR),
    "the Android application needs Kivy and numpy")
requires_display = unittest.skipUnless(HAS_DISPLAY, "no display for the user interface test")


@requires_app
class TestAppSupport(pycam.Test.PycamTestCase):
    """ the parts of the application that work without a window """

    def test_demo_camera_delivers_photos_and_a_background(self):
        from photo3d.camera_provider import DemoCameraProvider
        from pycam.Photogrammetry.session import TurntableRig
        provider = DemoCameraProvider(resolution=(240, 320), rig=TurntableRig(), count=8)
        background = provider.capture_background()
        photos = [provider.capture() for _ in range(8)]
        self.assertEqual(background.shape, (320, 240, 3))
        for photo in photos:
            self.assertEqual(photo.shape, background.shape)
        # the reference photo shows the empty scene, the others contain the object
        self.assertLess(np.abs(background.astype(int) - photos[0].astype(int)).mean(), 60)
        self.assertGreater(np.abs(background.astype(int) - photos[0].astype(int)).max(), 60)
        # the turntable moves on with every photo
        self.assertGreater(np.abs(photos[0].astype(int) - photos[2].astype(int)).max(), 30)

    def test_outline_overlay_marks_the_object(self):
        from photo3d.analysis import outline_overlay
        from photo3d.camera_provider import DemoCameraProvider
        provider = DemoCameraProvider(resolution=(240, 320), count=8)
        background = provider.capture_background()
        photo = provider.capture()
        overlay, coverage = outline_overlay(photo, background)
        self.assertEqual(overlay.shape[2], 3)
        self.assertGreater(coverage, 0.005)
        self.assertLess(coverage, 0.5)
        # without a reference photo the color distance has to find the object as well
        _, plain_coverage = outline_overlay(photo)
        self.assertAlmostEqual(plain_coverage, coverage, delta=0.05)

    def test_storage_creates_separate_directories(self):
        from photo3d import storage
        first = storage.new_scan_directory("unittest")
        second = storage.new_scan_directory("unittest")
        try:
            self.assertNotEqual(first, second)
            self.assertTrue(os.path.isdir(first))
            self.assertIn("unittest", storage.describe_location(first))
        finally:
            for directory in (first, second):
                os.rmdir(directory)

    def test_the_packaged_modules_are_complete(self):
        """ "prepare_package.py" has to know every module that the application imports

        Whenever a module of "pycam.Photogrammetry" starts to import another part of PyCAM,
        the APK has to contain that part as well - otherwise the application fails on the
        phone only.
        """
        import subprocess
        import prepare_package
        repository = os.path.dirname(ANDROID_DIR)
        for module in prepare_package.MODULES:
            self.assertTrue(os.path.isfile(os.path.join(repository, "pycam", module)),
                            "unknown module: {}".format(module))
        probe = ("import sys, pycam.Photogrammetry\n"
                 "print('\\n'.join(sorted(name for name, module in sys.modules.items()\n"
                 "                        if name.startswith('pycam')\n"
                 "                        and getattr(module, '__file__', None))))")
        result = subprocess.run((sys.executable, "-c", probe), cwd=repository,
                                capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
        needed = set(result.stdout.decode("utf-8", "replace").split())
        packaged = {"pycam." + module[:-3].replace("/", ".").replace(".__init__", "")
                    for module in prepare_package.MODULES}
        packaged.add("pycam")
        self.assertTrue(needed.issubset(packaged),
                        "not packaged: {}".format(sorted(needed - packaged)))


@requires_app
@requires_display
class TestApplicationFlow(pycam.Test.PycamTestCase):
    """ drive the complete application: setup, photos, reconstruction and export """

    def test_a_complete_scan(self):
        from kivy.clock import Clock
        from photo3d.app import Photo3DApp
        application = Photo3DApp(camera_mode="demo")
        state = {"result": None, "headline": "", "files": [], "directory": None}

        def script():
            manager = application.root
            yield
            manager.get_screen("home")._demo_scan()
            yield
            setup = manager.get_screen("setup")
            setup.count.text = "8"
            setup.detail.text = "fast"
            setup.fields["object_diameter"].input.text = "120"
            setup._start()
            yield
            capture = manager.get_screen("capture")
            capture._capture_background()
            yield
            for _ in range(8):
                capture._capture_shot()
                yield
            state["directory"] = application.session.directory
            state["photos"] = len(application.session)
            capture._build()
            yield
            result = manager.get_screen("result")
            for _ in range(2000):
                if result._result is not None or "could not" in result.headline.text:
                    break
                yield
            state["headline"] = result.headline.text
            state["result"] = result._result
            if result._result is not None:
                result._save()
                yield
                state["files"] = sorted(os.listdir(application.session.directory))
            application.stop()

        def step(dt, iterator=[None]):
            if iterator[0] is None:
                iterator[0] = script()
            try:
                next(iterator[0])
            except StopIteration:
                application.stop()

        application.on_start = lambda: Clock.schedule_interval(step, 0)
        application.run()
        self.assertEqual(state["photos"], 8)
        self.assertIsNotNone(state["result"], "the model was not built: {}"
                             .format(state["headline"]))
        mesh = state["result"].mesh
        self.assertTrue(mesh.is_watertight())
        # the virtual object of the demo camera is 60 x 60 x 90 mm
        self.assertAlmostEqual(mesh.size[0], 60.0, delta=8.0)
        self.assertAlmostEqual(mesh.size[2], 90.0, delta=10.0)
        self.assertIn("model.stl", state["files"])
        self.assertIn("session.json", state["files"])


if __name__ == "__main__":
    pycam.Test.main()
