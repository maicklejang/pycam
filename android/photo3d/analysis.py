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


Feedback about the recognized outline while taking the photos.
"""

import numpy as np

from pycam.Photogrammetry.images import resize_to_max
from pycam.Photogrammetry.silhouette import SilhouetteConfig, extract_mask

HIGHLIGHT = np.array((255, 90, 60), dtype=np.float32)


def outline_overlay(image, background=None, max_size=480):
    """ mark the recognized object inside a photo

    @returns: a tuple of the marked image and the fraction of the photo that was recognized
    """
    small, _ = resize_to_max(image, max_size)
    reference = None
    if background is not None:
        reference, _ = resize_to_max(background, max_size)
        if reference.shape != small.shape:
            reference = None
    method = "background" if reference is not None else "chroma"
    mask = extract_mask(small, background=reference, config=SilhouetteConfig(method=method))
    overlay = small.astype(np.float32)
    overlay[mask] = 0.45 * overlay[mask] + 0.55 * HIGHLIGHT
    return np.clip(overlay, 0, 255).astype(np.uint8), float(mask.mean())
