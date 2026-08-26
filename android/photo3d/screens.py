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


The screens of the scanner application.

  home -> setup -> capture -> result
"""

import threading
import traceback

from kivy.clock import Clock, mainthread
from kivy.metrics import dp, sp
from kivy.uix.boxlayout import BoxLayout
from kivy.uix.image import Image as ImageWidget
from kivy.uix.label import Label
from kivy.uix.progressbar import ProgressBar
from kivy.uix.screenmanager import Screen
from kivy.uix.slider import Slider
from kivy.uix.spinner import Spinner

from photo3d import storage
from photo3d.camera_provider import CameraError, array_to_texture
from photo3d.widgets import (ACCENT, MUTED, WARNING, LabeledInput, action_button, body_label,
                             show_message, title_label)

HELP_TEXT = """How a scan works

1. Put the object in the middle of a turntable (a plate, a lazy susan, a cake stand).
2. Place a sheet of white paper behind and below the object.
3. Prop up the phone so that it does not move any more and let it look down onto the object
   at an angle of about 20 to 40 degrees.
4. Take one photo of the empty turntable first ("reference photo").
5. Put the object back, take a photo, turn the table by one step, take the next photo - until
   the table has made one full turn.
6. Build the model and save it as an STL file.

Important: the phone has to stay in place - only the object may move.

The result is the "visual hull" of the object: dents and holes that never show up in an
outline (the inside of a cup for example) are filled up.
"""

DETAIL_LEVELS = {"fast": (90, 640), "normal": (130, 800), "fine": (180, 1000)}


class HomeScreen(Screen):

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        layout = BoxLayout(orientation="vertical", padding=dp(18), spacing=dp(10))
        layout.add_widget(title_label("PyCAM 3D scanner"))
        layout.add_widget(body_label(
            "Photograph an object on a turntable and turn the photos into a 3D model "
            "(STL) for milling or printing.", size_hint_y=None, height=dp(60)))
        layout.add_widget(action_button("new scan", self._new_scan, primary=True))
        layout.add_widget(action_button("try it without a camera", self._demo_scan))
        layout.add_widget(action_button("how it works", self._show_help))
        self.status = body_label("", size_hint_y=None, height=dp(80))
        layout.add_widget(self.status)
        layout.add_widget(BoxLayout())
        self.add_widget(layout)

    def on_pre_enter(self):
        self.status.text = "scans are stored in\n{}".format(
            storage.describe_location(storage.scans_root()))

    def _new_scan(self):
        self.manager.app.camera_mode = None
        self.manager.current = "setup"

    def _demo_scan(self):
        self.manager.app.camera_mode = "demo"
        self.manager.current = "setup"

    def _show_help(self):
        show_message("how it works", HELP_TEXT)


class SetupScreen(Screen):

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        layout = BoxLayout(orientation="vertical", padding=dp(18), spacing=dp(8))
        layout.add_widget(title_label("capture setup"))
        layout.add_widget(body_label(
            "Measure the distance and the height of the phone - they define the size of the "
            "model. The object size describes the volume that is searched.",
            size_hint_y=None, height=dp(58)))
        self.fields = {}
        for key, caption, value in (("distance", "phone distance", 350),
                                    ("height", "phone height", 200),
                                    ("object_diameter", "object diameter", 120),
                                    ("object_height", "object height", 120),
                                    ("fov", "field of view", 50)):
            field = LabeledInput(caption, value, unit="deg" if key == "fov" else "mm")
            self.fields[key] = field
            layout.add_widget(field)
        row = BoxLayout(orientation="horizontal", size_hint_y=None, height=dp(44),
                        spacing=dp(6))
        row.add_widget(Label(text="photos per turn", font_size=sp(14), size_hint_x=0.55,
                             halign="left"))
        self.count = Spinner(text="24", values=("12", "16", "24", "36"), size_hint_x=0.45,
                             font_size=sp(16))
        row.add_widget(self.count)
        layout.add_widget(row)
        row = BoxLayout(orientation="horizontal", size_hint_y=None, height=dp(44),
                        spacing=dp(6))
        row.add_widget(Label(text="detail", font_size=sp(14), size_hint_x=0.55, halign="left"))
        self.detail = Spinner(text="normal", values=tuple(DETAIL_LEVELS), size_hint_x=0.45,
                              font_size=sp(16))
        row.add_widget(self.detail)
        layout.add_widget(row)
        layout.add_widget(BoxLayout())
        layout.add_widget(action_button("start", self._start, primary=True))
        layout.add_widget(action_button("back", self._back))
        self.add_widget(layout)

    def _back(self):
        self.manager.current = "home"

    def _start(self):
        values = {key: field.value for key, field in self.fields.items()}
        missing = [key for key, value in values.items() if value is None or value <= 0]
        if missing:
            show_message("please check the setup",
                         "these values have to be positive numbers: {}"
                         .format(", ".join(sorted(missing))))
            return
        application = self.manager.app
        application.start_session(values, int(self.count.text), self.detail.text)
        self.manager.current = "capture"


class CaptureScreen(Screen):

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.layout = BoxLayout(orientation="vertical", padding=dp(12), spacing=dp(8))
        self.headline = Label(text="", font_size=sp(18), bold=True, size_hint_y=None,
                              height=dp(30))
        self.layout.add_widget(self.headline)
        self.hint = body_label("", size_hint_y=None, height=dp(38))
        self.layout.add_widget(self.hint)
        self.preview_area = BoxLayout(orientation="vertical")
        self.layout.add_widget(self.preview_area)
        self.background_button = action_button("reference photo (empty turntable)",
                                               self._capture_background)
        self.layout.add_widget(self.background_button)
        self.shot_button = action_button("take photo", self._capture_shot, primary=True)
        self.layout.add_widget(self.shot_button)
        row = BoxLayout(orientation="horizontal", size_hint_y=None, height=dp(48),
                        spacing=dp(8))
        row.add_widget(action_button("undo", self._undo, height=dp(48)))
        row.add_widget(action_button("check outline", self._check_outline, height=dp(48)))
        self.layout.add_widget(row)
        self.build_button = action_button("build 3D model", self._build)
        self.layout.add_widget(self.build_button)
        self.layout.add_widget(action_button("cancel", self._cancel, height=dp(44)))
        self.add_widget(self.layout)
        self._widget = None

    def on_pre_enter(self):
        application = self.manager.app
        self.preview_area.clear_widgets()
        try:
            application.open_camera()
            self._widget = application.provider.create_widget()
            self.preview_area.add_widget(self._widget)
            application.provider.start()
        except CameraError as exc:
            self._widget = None
            self.preview_area.add_widget(body_label(
                "the camera could not be opened:\n{}\n\nUse 'try it without a camera' on the "
                "start screen to test the application.".format(exc)))
        self._update_state()

    def on_leave(self):
        application = self.manager.app
        if application.provider is not None:
            application.provider.stop()

    def _update_state(self):
        application = self.manager.app
        taken = len(application.session)
        total = application.shot_count
        self.headline.text = "photo {} of {}".format(min(taken + 1, total), total)
        step = 360.0 / total
        if application.session.background:
            self.background_button.text = "reference photo stored"
            self.background_button.background_color = ACCENT
        if taken == 0:
            self.hint.text = ("Take the reference photo of the empty turntable first, then "
                              "put the object in the middle and take the first photo.")
        elif taken < total:
            self.hint.text = ("Turn the table by {:.0f} degrees and take the next photo. "
                              "Do not move the phone.".format(step))
        else:
            self.hint.text = "The turn is complete - build the model now."
        self.shot_button.disabled = (self._widget is None) or (taken >= total)
        self.build_button.disabled = taken < 6
        self.build_button.text = ("build 3D model" if taken >= 6
                                  else "build 3D model (at least 6 photos)")

    def _grab(self):
        application = self.manager.app
        try:
            return application.provider.capture()
        except CameraError as exc:
            show_message("no image", str(exc))
            return None

    def _capture_background(self):
        application = self.manager.app
        try:
            image = application.provider.capture_background()
        except CameraError as exc:
            show_message("no image", str(exc))
            return
        self.manager.app.store_background(image)
        self._update_state()

    def _capture_shot(self):
        image = self._grab()
        if image is None:
            return
        self.manager.app.store_shot(image)
        self._update_state()

    def _undo(self):
        self.manager.app.remove_last_shot()
        self._update_state()

    def _check_outline(self):
        """ show what the application currently recognizes as the object """
        image = self._grab()
        if image is None:
            return
        from photo3d.analysis import outline_overlay
        try:
            overlay, coverage = outline_overlay(image, self.manager.app.background_image)
        except Exception as exc:
            show_message("check failed", str(exc))
            return
        content = BoxLayout(orientation="vertical", spacing=dp(8), padding=dp(10))
        picture = ImageWidget(allow_stretch=True, keep_ratio=True)
        picture.texture = array_to_texture(overlay)
        content.add_widget(picture)
        if coverage <= 0.005:
            message = "no object was found - try a background with more contrast"
            color = WARNING
        elif coverage < 0.04:
            message = ("the object fills only {:.0f}% of the photo - move the phone closer, "
                       "otherwise the model stays coarse".format(100 * coverage))
            color = WARNING
        elif coverage > 0.6:
            message = "almost the whole photo is marked - the background is not uniform"
            color = WARNING
        else:
            message = "the marked area is used for the model ({:.0f}% of the photo)".format(
                100 * coverage)
            color = MUTED
        content.add_widget(body_label(message, color=color, size_hint_y=None, height=dp(46)))
        from kivy.uix.popup import Popup
        popup = Popup(title="recognized outline", content=content, size_hint=(0.95, 0.8))
        content.add_widget(action_button("close", popup.dismiss))
        popup.open()

    def _build(self):
        self.manager.current = "result"

    def _cancel(self):
        self.manager.current = "home"


class ResultScreen(Screen):

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        layout = BoxLayout(orientation="vertical", padding=dp(14), spacing=dp(8))
        self.headline = Label(text="building the model", font_size=sp(18), bold=True,
                              size_hint_y=None, height=dp(30))
        layout.add_widget(self.headline)
        self.progress = ProgressBar(max=100.0, size_hint_y=None, height=dp(16))
        layout.add_widget(self.progress)
        self.status = body_label("", size_hint_y=None, height=dp(38))
        layout.add_widget(self.status)
        self.picture = ImageWidget(allow_stretch=True, keep_ratio=True)
        layout.add_widget(self.picture)
        self.slider = Slider(min=0.0, max=360.0, value=35.0, size_hint_y=None, height=dp(34))
        self.slider.bind(value=lambda widget, value: self._render())
        self.slider.disabled = True
        layout.add_widget(self.slider)
        self.details = body_label("", size_hint_y=None, height=dp(60))
        layout.add_widget(self.details)
        self.save_button = action_button("save STL", self._save, primary=True)
        self.save_button.disabled = True
        layout.add_widget(self.save_button)
        layout.add_widget(action_button("back to the photos", self._back, height=dp(44)))
        self.add_widget(layout)
        self._result = None
        self._render_pending = False

    def on_pre_enter(self):
        self._result = None
        self.save_button.disabled = True
        self.slider.disabled = True
        self.progress.value = 0
        self.details.text = ""
        self.status.text = "starting"
        self.headline.text = "building the model"
        thread = threading.Thread(target=self._run, daemon=True)
        thread.start()

    def _run(self):
        application = self.manager.app
        try:
            result = application.reconstruct(self._report)
        except Exception as exc:
            self._failed("{}: {}".format(type(exc).__name__, exc), traceback.format_exc())
        else:
            self._finished(result)

    @mainthread
    def _report(self, message, ratio):
        self.status.text = message
        self.progress.value = 100.0 * ratio

    @mainthread
    def _failed(self, message, details):
        self.headline.text = "the model could not be built"
        self.status.text = message
        self.details.text = details.strip().splitlines()[-1]
        self.progress.value = 0

    @mainthread
    def _finished(self, result):
        self._result = result
        self.headline.text = "the model is ready"
        self.progress.value = 100
        size = result.mesh.size
        self.status.text = "{:.0f} x {:.0f} x {:.0f} mm, {} triangles".format(
            size[0], size[1], size[2], len(result.mesh.faces))
        self.details.text = ("\n".join(result.warnings[:2]) if result.warnings
                             else "the surface is closed and ready for machining")
        self.save_button.disabled = False
        self.slider.disabled = False
        self._render()

    def _render(self):
        if self._result is None or self._render_pending:
            return
        self._render_pending = True
        Clock.schedule_once(lambda dt: self._render_now(), 0)

    def _render_now(self):
        self._render_pending = False
        from pycam.Photogrammetry.preview import render_mesh
        image = render_mesh(self._result.mesh, azimuth=float(self.slider.value),
                            size=(420, 420))
        self.picture.texture = array_to_texture(image)

    def _save(self):
        try:
            paths = self.manager.app.save_result(self._result)
        except Exception as exc:
            show_message("saving failed", str(exc))
            return
        show_message("saved", "\n\n".join(storage.describe_location(path) for path in paths)
                     + "\n\nCopy the STL file to your computer to use it with PyCAM.")

    def _back(self):
        self.manager.current = "capture"
