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


The scanner application itself: it keeps the state of a scan and connects the screens with
the reconstruction of "pycam.Photogrammetry".
"""

import os

from kivy.app import App
from kivy.core.window import Window
from kivy.uix.screenmanager import ScreenManager, SlideTransition

from pycam.Photogrammetry.capture import CaptureController
from pycam.Photogrammetry.images import save_image
from pycam.Photogrammetry.pipeline import ReconstructionConfig, reconstruct
from pycam.Photogrammetry.preview import render_mesh
from pycam.Photogrammetry.session import CaptureSession, TurntableRig
from pycam.Photogrammetry.silhouette import SilhouetteConfig

from photo3d import storage
from photo3d.camera_provider import CameraError, create_provider, default_provider_name
from photo3d.screens import (DETAIL_LEVELS, CaptureScreen, HomeScreen, ResultScreen,
                             SetupScreen)
from photo3d.widgets import BACKGROUND


class Photo3DApp(App):
    """ turn photos of an object on a turntable into a 3D model """

    title = "PyCAM 3D scanner"

    def __init__(self, camera_mode=None, **kwargs):
        super().__init__(**kwargs)
        self.camera_mode = camera_mode
        self.provider = None
        self.session = None
        self.controller = None
        self.background_image = None
        self.shot_count = 24
        self.detail = "normal"

    def build(self):
        Window.clearcolor = BACKGROUND
        manager = ScreenManager(transition=SlideTransition(duration=0.15))
        manager.app = self
        manager.add_widget(HomeScreen(name="home"))
        manager.add_widget(SetupScreen(name="setup"))
        manager.add_widget(CaptureScreen(name="capture"))
        manager.add_widget(ResultScreen(name="result"))
        return manager

    def on_start(self):
        self._request_android_permissions()

    def on_stop(self):
        self.close_camera()

    @staticmethod
    def _request_android_permissions():
        if not storage.is_android():
            return
        try:
            from android.permissions import Permission, request_permissions
            request_permissions([Permission.CAMERA])
        except Exception:
            # an old Android version does not need the request at runtime
            pass

    # -- the state of one scan -----------------------------------------------------------

    def start_session(self, values, count, detail):
        """ prepare a new capture session with the given setup """
        self.close_camera()
        rig = TurntableRig(distance=values["distance"], height=values["height"],
                           object_diameter=values["object_diameter"],
                           object_height=values["object_height"])
        session = CaptureSession(storage.new_scan_directory(), rig=rig,
                                 field_of_view=values["fov"])
        self.session = session
        self.controller = CaptureController(session=session)
        self.background_image = None
        self.shot_count = int(count)
        self.detail = detail
        session.save()

    def open_camera(self):
        if self.provider is not None:
            return self.provider
        preferred = self.camera_mode or default_provider_name()
        rig = self.session.rig if self.session else None
        self.provider = create_provider(preferred, rig=rig, count=self.shot_count)
        return self.provider

    def close_camera(self):
        if self.provider is not None:
            try:
                self.provider.stop()
            except Exception:
                pass
            self.provider = None

    def store_background(self, image):
        self.controller.store_background(image)
        self.background_image = image
        self.controller.save()

    def store_shot(self, image):
        from pycam.Photogrammetry.camera import turntable_angles
        angles = turntable_angles(self.shot_count)
        index = min(len(self.session), len(angles) - 1)
        self.controller.store_shot(image, angles[index])
        self.controller.save()

    def remove_last_shot(self):
        if self.controller is not None:
            self.controller.remove_last_shot()
            self.controller.save()

    # -- the reconstruction ---------------------------------------------------------------

    def reconstruction_config(self):
        resolution, image_size = DETAIL_LEVELS.get(self.detail, DETAIL_LEVELS["normal"])
        return ReconstructionConfig(resolution=resolution, max_image_size=image_size,
                                    silhouette=SilhouetteConfig(method="auto"),
                                    center_model=True)

    def reconstruct(self, progress=None):
        if self.session is None:
            raise CameraError("there is no scan yet")
        return reconstruct(self.session, config=self.reconstruction_config(), progress=progress)

    def save_result(self, result):
        """ store the model next to the photos and return the written paths """
        directory = self.session.directory
        paths = [result.mesh.write_stl(os.path.join(directory, "model.stl"))]
        try:
            preview_path = os.path.join(directory, "model.png")
            save_image(preview_path, render_mesh(result.mesh))
            paths.append(preview_path)
        except Exception:
            # a missing image backend must not prevent the export of the model
            pass
        return paths


def run(camera_mode=None):
    Photo3DApp(camera_mode=camera_mode).run()
