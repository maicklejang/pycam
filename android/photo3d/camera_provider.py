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


Access to the camera of the device.

Three implementations are available and the first usable one is selected:

  * "camera4kivy": the modern camera of Android (CameraX) - used as soon as the package is
    part of the APK (see android/README.md), it is not installed by default
  * "kivy": the camera provider that is built into Kivy - on Android it talks to the camera
    via pyjnius, on a desktop computer it uses the webcam
  * "demo": a virtual camera that shows a rotating test object - it needs no hardware and
    makes it possible to try out the whole application anywhere

Every provider delivers a widget for the live preview and a photo as an RGB array.
"""

import os

import numpy as np

from kivy.graphics.texture import Texture
from kivy.uix.image import Image as ImageWidget
from kivy.uix.label import Label


class CameraError(Exception):
    """ the camera could not be used """


class BaseCameraProvider:

    name = "none"
    description = "no camera"

    def create_widget(self):
        """ return the widget that shows the live image """
        raise NotImplementedError

    def start(self):
        pass

    def stop(self):
        pass

    def capture(self):
        """ return the current image as an RGB array (shape: height x width x 3) """
        raise NotImplementedError

    def capture_background(self):
        """ return a photo of the scene without the object

        The user is asked to remove the object first, so the current image is used.
        """
        return self.capture()


def texture_to_array(texture):
    """ convert a Kivy texture into an RGB array of bytes """
    if texture is None:
        raise CameraError("the camera did not deliver an image yet")
    size = texture.size
    pixels = np.frombuffer(texture.pixels, dtype=np.uint8)
    image = pixels.reshape(int(size[1]), int(size[0]), 4)
    # Kivy textures start at the lower left corner, images at the upper left one
    return np.ascontiguousarray(image[::-1, :, :3])


def array_to_texture(image):
    """ convert an RGB array into a Kivy texture """
    image = np.ascontiguousarray(np.asarray(image, dtype=np.uint8)[::-1])
    texture = Texture.create(size=(image.shape[1], image.shape[0]), colorfmt="rgb")
    texture.blit_buffer(image.tobytes(), colorfmt="rgb", bufferfmt="ubyte")
    return texture


class Camera4KivyProvider(BaseCameraProvider):
    """ the camera of Android, provided by the "camera4kivy" package """

    name = "camera4kivy"
    description = "camera of the device"

    def __init__(self, resolution=(1280, 720)):
        from camera4kivy import Preview
        self.resolution = resolution
        self._preview_class = Preview
        self._preview = None
        self._last_image = None

    @classmethod
    def is_available(cls):
        try:
            import camera4kivy  # noqa: F401 (just a probe)
        except ImportError:
            return False
        return True

    def create_widget(self):
        self._preview = self._preview_class(aspect_ratio="4:3")
        return self._preview

    def start(self):
        if self._preview is not None:
            self._preview.connect_camera(enable_analyze_pixels=True,
                                         enable_video=False,
                                         analyze_pixels_resolution=max(self.resolution))
            self._preview.analyze_pixels_callback = self._on_pixels

    def stop(self):
        if self._preview is not None:
            self._preview.disconnect_camera()

    def _on_pixels(self, pixels, image_size, image_pos, scale, mirror):
        """ camera4kivy hands over every frame as RGBA bytes """
        try:
            width, height = int(image_size[0]), int(image_size[1])
            frame = np.frombuffer(pixels, dtype=np.uint8).reshape(height, width, 4)
            image = frame[:, :, :3]
            if mirror:
                image = image[:, ::-1]
            self._last_image = np.ascontiguousarray(image)
        except Exception:
            # a single broken frame must not stop the preview
            pass

    def capture(self):
        if self._last_image is None:
            raise CameraError("the camera did not deliver an image yet")
        return self._last_image.copy()


class KivyCameraProvider(BaseCameraProvider):
    """ the camera provider of Kivy (used on the desktop and as a fallback on Android) """

    name = "kivy"
    description = "camera of the device"

    def __init__(self, index=0, resolution=(640, 480)):
        self.index = index
        self.resolution = resolution
        self._camera = None

    @classmethod
    def is_available(cls):
        try:
            from kivy.core.camera import Camera
        except Exception:
            return False
        # the name exists even when Kivy found no usable provider for this system
        return Camera is not None

    def create_widget(self):
        from kivy.core.camera import Camera as CoreCamera
        if CoreCamera is None:
            raise CameraError("Kivy found no camera on this device")
        from kivy.uix.camera import Camera
        try:
            self._camera = Camera(index=self.index, resolution=self.resolution, play=False)
        except Exception as exc:
            raise CameraError("camera {} could not be opened ({})".format(self.index, exc))
        return self._camera

    def start(self):
        if self._camera is not None:
            self._camera.play = True

    def stop(self):
        if self._camera is not None:
            self._camera.play = False

    def capture(self):
        if self._camera is None:
            raise CameraError("the camera is not open")
        return texture_to_array(self._camera.texture)


class DemoCameraProvider(BaseCameraProvider):
    """ a virtual camera that shows a test object on a turntable

    It allows trying out the complete application without any hardware - and it is used by the
    automated tests of the user interface.
    """

    name = "demo"
    description = "virtual test object (no camera needed)"

    def __init__(self, resolution=(480, 640), rig=None, count=24):
        from pycam.Photogrammetry import synthetic
        from pycam.Photogrammetry.camera import CameraIntrinsics, turntable_angles
        from pycam.Photogrammetry.camera import turntable_cameras
        self.resolution = resolution
        self._widget = None
        self._index = 0
        width, height = resolution
        intrinsics = CameraIntrinsics.from_fov(width, height, 50.0)
        distance = rig.distance if rig else 350.0
        camera_height = rig.height if rig else 200.0
        # the virtual camera has to use exactly the setup that the reconstruction assumes
        target_z = rig.effective_target_z if rig else 60.0
        cameras = turntable_cameras(intrinsics, turntable_angles(count), distance=distance,
                                    height=camera_height, target_z=target_z)
        shape = synthetic.demo_object(height=90.0, base_radius=30.0)
        points = synthetic.sample_solid(shape, (-60.0, -60.0, 0.0), (60.0, 60.0, 120.0),
                                        resolution=70)
        masks = synthetic.render_masks(cameras, points)
        self._photos = synthetic.render_photos(masks, object_color=(150, 60, 45),
                                               background_color=(238, 236, 230), noise=6)
        # the virtual turntable without the object - used as the reference photo
        empty = np.zeros_like(masks[0])
        self._background = synthetic.render_photos([empty],
                                                   background_color=(238, 236, 230),
                                                   noise=6)[0]

    @classmethod
    def is_available(cls):
        return True

    def create_widget(self):
        self._widget = ImageWidget(allow_stretch=True, keep_ratio=True)
        self._update_widget()
        return self._widget

    def _update_widget(self):
        if self._widget is not None:
            self._widget.texture = array_to_texture(self._photos[self._index])

    def capture(self):
        image = self._photos[self._index]
        # the virtual turntable moves on to the next position
        self._index = (self._index + 1) % len(self._photos)
        self._update_widget()
        return image.copy()

    def capture_background(self):
        """ the virtual turntable without the object (the position is not advanced) """
        return self._background.copy()


def create_provider(preferred=None, **kwargs):
    """ return the first usable camera provider

    @param preferred: the name of a provider ("camera4kivy", "kivy" or "demo")
    @raises CameraError: if no real camera can be used
    """
    if preferred == DemoCameraProvider.name:
        candidates = [DemoCameraProvider]
    else:
        # The virtual camera is never used as a fallback.  Scanning a virtual object instead
        # of the real one would look like a working camera, which is worse than an error.
        candidates = [Camera4KivyProvider, KivyCameraProvider]
        if preferred:
            candidates.sort(key=lambda item: item.name != preferred)
    errors = []
    for candidate in candidates:
        if not candidate.is_available():
            errors.append("{}: not available".format(candidate.name))
            continue
        try:
            return candidate(**_matching_arguments(candidate, kwargs))
        except Exception as exc:
            errors.append("{}: {}".format(candidate.name, exc))
    raise CameraError("; ".join(errors) if errors else "no camera provider was found")


def _matching_arguments(candidate, arguments):
    """ pass only the arguments that the provider understands """
    import inspect
    accepted = inspect.signature(candidate.__init__).parameters
    return {key: value for key, value in arguments.items() if key in accepted}


def missing_camera_widget(message):
    """ return a placeholder for a missing camera """
    return Label(text=message, halign="center", valign="middle")


def default_provider_name():
    """ return the provider that should be used on this device """
    if "ANDROID_ARGUMENT" in os.environ:
        return "camera4kivy"
    return "kivy"
