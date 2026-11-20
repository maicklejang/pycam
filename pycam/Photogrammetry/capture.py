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


Taking photos with a locally connected camera (webcam, USB camera, ...).

This module needs OpenCV ("python3-opencv").  Everything else in this package works without a
camera, e.g. with photos that were taken with a phone.
"""

import os

import numpy as np

from pycam.errors import InitializationError, MissingDependencyError
from pycam.Photogrammetry.images import save_image
from pycam.Photogrammetry.session import CaptureSession

DEFAULT_SHOT_PATTERN = "shot_{index:03d}.png"
BACKGROUND_FILENAME = "background.png"
_MISSING_OPENCV = ("taking photos requires OpenCV - please install 'python3-opencv' or use "
                   "photos that were taken with another camera")


def _get_opencv():
    try:
        import cv2
    except ImportError:
        raise MissingDependencyError(_MISSING_OPENCV)
    return cv2


def is_available():
    """ check whether a camera can be used at all """
    try:
        _get_opencv()
    except MissingDependencyError:
        return False
    return True


def sharpness(image):
    """ return a focus measure (the variance of a Laplacian filter)

    Bigger values indicate a sharper image.  Blurry photos ruin the silhouette detection, thus
    it is worth checking this value before keeping a photo.
    """
    from pycam.Photogrammetry.images import to_gray
    gray = to_gray(image).astype(np.float32)
    if min(gray.shape) < 3:
        return 0.0
    laplacian = (gray[:-2, 1:-1] + gray[2:, 1:-1] + gray[1:-1, :-2] + gray[1:-1, 2:]
                 - 4 * gray[1:-1, 1:-1])
    return float(laplacian.var())


def list_devices(maximum=6):
    """ return the indexes of all cameras that deliver an image """
    cv2 = _get_opencv()
    found = []
    for index in range(maximum):
        device = cv2.VideoCapture(index)
        try:
            if device.isOpened() and device.read()[0]:
                found.append(index)
        finally:
            device.release()
    return found


class CameraDevice:
    """ a camera that delivers RGB frames """

    def __init__(self, index=0, width=None, height=None, warmup_frames=8):
        self.index = int(index)
        self.width = width
        self.height = height
        self.warmup_frames = int(warmup_frames)
        self._device = None

    def open(self):
        cv2 = _get_opencv()
        device = cv2.VideoCapture(self.index)
        if not device.isOpened():
            device.release()
            raise InitializationError("failed to open camera {}".format(self.index))
        if self.width:
            device.set(cv2.CAP_PROP_FRAME_WIDTH, int(self.width))
        if self.height:
            device.set(cv2.CAP_PROP_FRAME_HEIGHT, int(self.height))
        self._device = device
        # the first frames of many cameras are black or badly exposed
        for _ in range(self.warmup_frames):
            device.read()
        return self

    def close(self):
        if self._device is not None:
            self._device.release()
            self._device = None

    def __enter__(self):
        return self.open()

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()

    @property
    def is_open(self):
        return self._device is not None

    def grab(self):
        """ return the current camera image as an RGB array """
        if self._device is None:
            raise InitializationError("the camera is not open")
        success, frame = self._device.read()
        if not success or frame is None:
            raise InitializationError("failed to read an image from camera {}".format(self.index))
        return np.ascontiguousarray(frame[:, :, ::-1])

    def grab_stable(self, frames=3):
        """ return the average of a few frames (reduces the noise of cheap cameras) """
        frames = max(int(frames), 1)
        accumulator = None
        for _ in range(frames):
            image = self.grab().astype(np.float32)
            accumulator = image if accumulator is None else accumulator + image
        return np.clip(accumulator / frames, 0, 255).astype(np.uint8)


class CaptureController:
    """ store the photos of a turntable run inside a session directory """

    def __init__(self, session=None, directory=None, shot_pattern=DEFAULT_SHOT_PATTERN):
        if session is None:
            if directory is None:
                raise ValueError("either a session or a directory is required")
            session = CaptureSession(directory)
        self.session = session
        self.shot_pattern = shot_pattern
        os.makedirs(self.session.directory, exist_ok=True)

    def store_background(self, image):
        """ store a reference photo of the empty turntable """
        filename = os.path.join(self.session.directory, BACKGROUND_FILENAME)
        save_image(filename, image)
        self.session.background = BACKGROUND_FILENAME
        return filename

    def store_shot(self, image, angle):
        """ store a single photo together with its turntable angle """
        name = self.shot_pattern.format(index=len(self.session))
        filename = os.path.join(self.session.directory, name)
        save_image(filename, image)
        self.session.add_shot(name, angle)
        return filename

    def remove_last_shot(self):
        """ drop the most recent photo (including its file) """
        if not self.session.shots:
            return None
        shot = self.session.shots.pop()
        filename = os.path.join(self.session.directory, shot.filename)
        if os.path.exists(filename):
            os.remove(filename)
        return shot

    def save(self):
        return self.session.save()
