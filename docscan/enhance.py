"""Image clean-up: shadow removal, colour modes and sharpening.

Copyright 2026 PyCAM contributors

This file is part of the docscan document scanner.  It is free software:
you can redistribute it and/or modify it under the terms of the GNU General
Public License as published by the Free Software Foundation, either version 3
of the License, or (at your option) any later version.
"""

import numpy as np

import cv2


#: available output looks, in the order used by the "cycle mode" key of the camera UI
MODES = ("color", "magic", "gray", "bw", "none")

MODE_DESCRIPTIONS = {
    "none": "no processing, only the perspective correction",
    "color": "colour photo with even lighting and a white background",
    "magic": "boosted colour document (the classic scanner app look)",
    "gray": "neutral grayscale",
    "bw": "hard black and white, smallest files, best for plain text",
}


def _odd(value, minimum=3):
    value = int(round(value))
    if value % 2 == 0:
        value += 1
    return max(minimum, value)


def _background(channel, kernel_size, blur_size):
    """Estimate the illumination of a channel by growing its bright areas."""
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    dilated = cv2.dilate(channel, kernel)
    return cv2.medianBlur(dilated, blur_size)


def remove_shadows(image, strength=1.0):
    """Flatten uneven lighting by dividing the image by its own background.

    This is what turns a photo taken under a desk lamp into something that
    looks like it came out of a flatbed scanner.
    """
    if strength <= 0:
        return image
    longest = max(image.shape[:2])
    kernel_size = _odd(longest * 0.012, 3)
    blur_size = _odd(longest * 0.02, 3)
    if image.ndim == 2:
        channels = [image]
    else:
        channels = cv2.split(image)
    flattened = []
    for channel in channels:
        background = _background(channel, kernel_size, blur_size)
        normalised = cv2.divide(channel, background, scale=255)
        if strength < 1.0:
            normalised = cv2.addWeighted(normalised, strength, channel, 1.0 - strength, 0)
        flattened.append(normalised)
    if len(flattened) == 1:
        return flattened[0]
    return cv2.merge(flattened)


def stretch_levels(image, low_percentile=1.0, high_percentile=99.0):
    """Push the darkest and brightest percentiles to pure black and white."""
    result = image.astype(np.float32)
    reference = image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    low = float(np.percentile(reference, low_percentile))
    high = float(np.percentile(reference, high_percentile))
    if high - low < 1e-3:
        return image
    result = (result - low) * (255.0 / (high - low))
    return np.clip(result, 0, 255).astype(np.uint8)


def unsharp_mask(image, amount=0.6, radius=1.4):
    """Sharpen edges without amplifying noise too much."""
    if amount <= 0:
        return image
    blurred = cv2.GaussianBlur(image, (0, 0), radius)
    return cv2.addWeighted(image, 1.0 + amount, blurred, -amount, 0)


def auto_white_balance(image, percentile=97.0):
    """Scale each channel so that its bright pixels become neutral white."""
    if image.ndim != 3:
        return image
    channels = []
    for channel in cv2.split(image):
        reference = float(np.percentile(channel, percentile))
        gain = 255.0 / reference if reference > 1.0 else 1.0
        gain = min(gain, 3.0)
        channels.append(np.clip(channel.astype(np.float32) * gain, 0, 255).astype(np.uint8))
    return cv2.merge(channels)


def boost_saturation(image, factor=1.15):
    if image.ndim != 3 or factor == 1.0:
        return image
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV).astype(np.float32)
    hsv[:, :, 1] = np.clip(hsv[:, :, 1] * factor, 0, 255)
    return cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)


def whiten(image, white_point=225):
    """Map near-white pixels to pure white with a smooth lightness curve.

    Paper is never perfectly uniform, and the local contrast step happily
    amplifies that leftover texture.  Pulling everything above ``white_point``
    up to white removes it again without touching the ink.
    """
    white_point = int(np.clip(white_point, 32, 255))
    table = np.clip(np.arange(256, dtype=np.float32) * (255.0 / white_point),
                    0, 255).astype(np.uint8)
    if image.ndim == 2:
        return cv2.LUT(image, table)
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    lab[:, :, 0] = cv2.LUT(lab[:, :, 0], table)
    return cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)


def local_contrast(image, clip_limit=2.0, tile=8):
    """Apply CLAHE on the lightness channel only, so colours stay intact."""
    clahe = cv2.createCLAHE(clipLimit=clip_limit, tileGridSize=(tile, tile))
    if image.ndim == 2:
        return clahe.apply(image)
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    lab[:, :, 0] = clahe.apply(lab[:, :, 0])
    return cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)


def to_grayscale(image, shadow=1.0):
    gray = image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = remove_shadows(gray, shadow)
    return whiten(stretch_levels(gray), 235)


def to_black_white(image, shadow=1.0, offset=10, block_ratio=0.025, denoise=True):
    """Produce a crisp bi-level page using a locally adaptive threshold.

    The parameters were picked by measuring how much of the text survives (and
    how much speckle is added) on rendered pages at several resolutions and
    noise levels: blurring first costs thin strokes, while the median filter
    afterwards is what keeps a noisy photo from turning into confetti.
    """
    gray = image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = remove_shadows(gray, shadow)
    block_size = _odd(max(image.shape[:2]) * block_ratio, 15)
    binary = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                   cv2.THRESH_BINARY, block_size, offset)
    if denoise:
        # remove isolated speckles created by the threshold in empty areas
        binary = cv2.medianBlur(binary, 3)
    return binary


def to_magic_colour(image, shadow=1.0):
    """The typical scanner app look: white paper, saturated ink, crisp edges."""
    result = remove_shadows(image, shadow)
    result = auto_white_balance(result)
    result = stretch_levels(result, 2.0, 99.5)
    result = local_contrast(result, clip_limit=1.3)
    result = whiten(result, 225)
    result = boost_saturation(result, 1.2)
    return unsharp_mask(result, amount=0.5)


def to_colour(image, shadow=1.0):
    """A faithful colour scan: even lighting, neutral white, no heavy grading."""
    result = remove_shadows(image, shadow)
    result = auto_white_balance(result, percentile=98.0)
    result = whiten(result, 240)
    return unsharp_mask(result, amount=0.3)


def enhance(image, mode="color", shadow=1.0, sharpen=None):
    """Apply the requested colour mode to an already rectified page."""
    if mode not in MODES:
        raise ValueError("unknown mode {!r}, expected one of {}".format(mode, ", ".join(MODES)))
    if mode == "none":
        result = image
    elif mode == "gray":
        result = to_grayscale(image, shadow)
    elif mode == "bw":
        result = to_black_white(image, shadow)
    elif mode == "magic":
        result = to_magic_colour(image, shadow)
    else:
        result = to_colour(image, shadow)
    if sharpen and mode != "bw":
        result = unsharp_mask(result, amount=sharpen)
    return result
