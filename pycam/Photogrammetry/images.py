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


Loading and scaling of photos.

Either OpenCV ("python3-opencv") or Pillow ("python3-pil") is used for decoding image files.
Everything else in this package works on plain numpy arrays.
"""

import os
import re

import numpy as np

from pycam.errors import LoadFileError, MissingDependencyError

IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp", ".heic", ".heif")
# the format of recent iPhones - it needs an additional decoder
HEIF_EXTENSIONS = (".heic", ".heif")
_HEIF_HINT = ("HEIF/HEIC photos need the additional module 'pillow-heif' (pip install "
              "pillow-heif). Alternatively let your phone store photos as JPEG ('most "
              "compatible' in the camera settings of iOS).")

_MISSING_BACKEND_HINT = ("no image library is available - please install either "
                         "'python3-opencv' (recommended) or 'python3-pil'")


def _get_opencv():
    try:
        import cv2
    except ImportError:
        return None
    return cv2


def _get_pillow():
    try:
        from PIL import Image
    except ImportError:
        return None
    return Image


def available_backends():
    """ return the names of all usable image backends """
    backends = []
    if _get_opencv() is not None:
        backends.append("opencv")
    if _get_pillow() is not None:
        backends.append("pillow")
    return tuple(backends)


def _register_heif():
    """ teach Pillow to open the HEIF/HEIC photos of recent phones (if possible) """
    try:
        import pillow_heif
    except ImportError:
        return False
    pillow_heif.register_heif_opener()
    return True


def load_image(filename):
    """ load an image file and return it as an RGB array of bytes (shape: height x width x 3) """
    filename = os.path.expanduser(str(filename))
    if not os.path.isfile(filename):
        raise LoadFileError("image file does not exist: {}".format(filename))
    is_heif = filename.lower().endswith(HEIF_EXTENSIONS)
    if is_heif:
        # OpenCV cannot decode this format - Pillow can, as soon as it knows the decoder
        if not _register_heif() or _get_pillow() is None:
            raise MissingDependencyError("cannot read '{}': {}".format(filename, _HEIF_HINT))
        return _load_via_pillow(filename)
    cv2 = _get_opencv()
    if cv2 is not None:
        # "imread" does not handle non-ASCII filenames on all platforms - read the bytes here
        with open(filename, "rb") as source:
            data = np.frombuffer(source.read(), dtype=np.uint8)
        image = cv2.imdecode(data, cv2.IMREAD_COLOR)
        if image is None:
            raise LoadFileError("failed to decode image: {}".format(filename))
        return np.ascontiguousarray(image[:, :, ::-1])
    if _get_pillow() is not None:
        return _load_via_pillow(filename)
    raise MissingDependencyError("{} (while loading {})"
                                 .format(_MISSING_BACKEND_HINT, filename))


def _load_via_pillow(filename):
    from PIL import ImageOps
    pillow = _get_pillow()
    try:
        with pillow.open(filename) as handle:
            # phone cameras store the orientation in the EXIF header instead of rotating the
            # pixels - OpenCV applies it while decoding, Pillow has to be asked for it
            return np.asarray(ImageOps.exif_transpose(handle).convert("RGB"), dtype=np.uint8)
    except OSError as exc:
        raise LoadFileError("failed to decode image ({}): {}".format(filename, exc))


def save_image(filename, image):
    """ store an RGB array or a boolean mask as an image file """
    filename = os.path.expanduser(str(filename))
    image = np.asarray(image)
    if image.dtype == bool:
        image = np.where(image, np.uint8(255), np.uint8(0))
    if image.dtype != np.uint8:
        image = np.clip(image, 0, 255).astype(np.uint8)
    cv2 = _get_opencv()
    if cv2 is not None:
        if image.ndim == 3:
            image = image[:, :, ::-1]
        if not cv2.imwrite(filename, image):
            raise IOError("failed to write image: {}".format(filename))
        return filename
    pillow = _get_pillow()
    if pillow is not None:
        pillow.fromarray(image).save(filename)
        return filename
    raise MissingDependencyError("{} (while writing {})"
                                 .format(_MISSING_BACKEND_HINT, filename))


def to_gray(image):
    """ convert an RGB array into a grayscale array of bytes """
    image = np.asarray(image)
    if image.ndim == 2:
        return image.astype(np.uint8, copy=False)
    weights = np.array((0.299, 0.587, 0.114))
    return (image[:, :, :3].astype(np.float32) @ weights).astype(np.uint8)


def resize_to_max(image, max_dimension):
    """ shrink an image until neither of its dimensions exceeds "max_dimension"

    @returns: a tuple of the (possibly unchanged) image and the applied scale factor
    """
    image = np.asarray(image)
    height, width = image.shape[:2]
    longest = max(height, width)
    if (max_dimension is None) or (longest <= max_dimension):
        return image, 1.0
    scale = float(max_dimension) / longest
    new_height = max(int(round(height * scale)), 1)
    new_width = max(int(round(width * scale)), 1)
    cv2 = _get_opencv()
    if cv2 is not None:
        resized = cv2.resize(image, (new_width, new_height), interpolation=cv2.INTER_AREA)
    else:
        rows = (np.arange(new_height) * (height / new_height)).astype(int)
        columns = (np.arange(new_width) * (width / new_width)).astype(int)
        resized = image[np.clip(rows, 0, height - 1)][:, np.clip(columns, 0, width - 1)]
    return resized, new_width / width


def _natural_sort_key(text):
    return [int(part) if part.isdigit() else part.lower()
            for part in re.split(r"(\d+)", str(text))]


def list_images(directory, exclude=()):
    """ return the sorted paths of all images in a directory """
    directory = os.path.expanduser(str(directory))
    if not os.path.isdir(directory):
        raise LoadFileError("image directory does not exist: {}".format(directory))
    excluded = {os.path.basename(str(item)) for item in exclude}
    names = [name for name in os.listdir(directory)
             if name.lower().endswith(IMAGE_EXTENSIONS) and name not in excluded]
    names.sort(key=_natural_sort_key)
    return [os.path.join(directory, name) for name in names]
