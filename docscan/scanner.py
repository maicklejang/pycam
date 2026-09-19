"""The scanning pipeline: detect the page, rectify it and clean it up.

Copyright 2026 PyCAM contributors

This file is part of the docscan document scanner.  It is free software:
you can redistribute it and/or modify it under the terms of the GNU General
Public License as published by the Free Software Foundation, either version 3
of the License, or (at your option) any later version.
"""

from dataclasses import dataclass, field
from typing import Optional

import numpy as np

import cv2

from docscan.detect import Detection, find_document
from docscan.enhance import MODES, enhance
from docscan.transform import four_point_transform, rotate_image


@dataclass
class ScanOptions:
    """Everything that controls how a photo is turned into a scanned page."""

    mode: str = "color"
    aspect: str = "auto"
    margin: float = -0.004
    shadow: float = 1.0
    sharpen: Optional[float] = None
    rotate: int = 0
    crop: bool = True
    min_area_ratio: float = 0.08
    working_size: int = 720
    max_side: Optional[int] = None

    def validate(self):
        if self.mode not in MODES:
            raise ValueError("unknown colour mode {!r}, expected one of {}".format(
                self.mode, ", ".join(MODES)))
        if not 0.0 <= self.shadow <= 1.0:
            raise ValueError("shadow strength must be between 0 and 1")
        if self.margin < -0.2 or self.margin > 0.5:
            raise ValueError("margin must be between -0.2 and 0.5")
        if self.rotate % 90:
            raise ValueError("rotation must be a multiple of 90 degrees")
        return self


@dataclass
class ScanResult:
    """The finished page plus what the detector made of the input."""

    image: np.ndarray
    detection: Optional[Detection] = None
    cropped: bool = False
    source_shape: tuple = field(default_factory=tuple)

    @property
    def quad(self):
        return None if self.detection is None else self.detection.quad

    @property
    def size(self):
        height, width = self.image.shape[:2]
        return width, height


def _limit_resolution(image, max_side):
    if not max_side:
        return image
    height, width = image.shape[:2]
    longest = max(height, width)
    if longest <= max_side:
        return image
    scale = max_side / float(longest)
    return cv2.resize(image, (max(1, int(round(width * scale))),
                              max(1, int(round(height * scale)))),
                      interpolation=cv2.INTER_AREA)


def scan_image(image, options=None, detection=None):
    """Run the full pipeline on a photo and return the finished page.

    ``detection`` can be passed in when the outline is already known (the live
    camera preview detects on the small preview frame and reuses the result).
    When no page outline is found the photo is processed without cropping, so
    the caller always gets a usable result.
    """
    options = (options or ScanOptions()).validate()
    if image is None or not getattr(image, "size", 0):
        raise ValueError("empty input image")

    if detection is None and options.crop:
        detection = find_document(image, min_area_ratio=options.min_area_ratio,
                                  working_size=options.working_size)

    cropped = False
    page = image
    if options.crop and detection is not None:
        page = four_point_transform(image, detection.quad, aspect=options.aspect,
                                    margin=options.margin)
        cropped = True

    page = _limit_resolution(page, options.max_side)
    page = enhance(page, mode=options.mode, shadow=options.shadow, sharpen=options.sharpen)
    page = rotate_image(page, options.rotate)
    return ScanResult(image=page, detection=detection, cropped=cropped,
                      source_shape=image.shape[:2])
