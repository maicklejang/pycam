#!/usr/bin/env python3
"""Render the app icons.

Run from the repository root::

    python3 docscan/web/icons/make-icons.py

Keeping the icons generated (instead of hand drawn binaries) makes it easy to
change the colours without a graphics program.
"""

import os

import numpy as np

import cv2

BACKGROUND = (21, 17, 15)       # BGR of #0f1115
PAPER = (245, 244, 242)
ACCENT = (106, 194, 53)         # BGR of #35c26a
HERE = os.path.dirname(os.path.abspath(__file__))


def rounded_rectangle(image, colour, radius_ratio=0.22):
    size = image.shape[0]
    radius = int(size * radius_ratio)
    mask = np.zeros((size, size), np.uint8)
    cv2.rectangle(mask, (radius, 0), (size - radius, size), 255, -1)
    cv2.rectangle(mask, (0, radius), (size, size - radius), 255, -1)
    for centre in ((radius, radius), (size - radius, radius),
                   (radius, size - radius), (size - radius, size - radius)):
        cv2.circle(mask, centre, radius, 255, -1)
    image[mask > 0] = colour
    return image


def draw_icon(size, padding_ratio=0.18, rounded=True):
    """A tilted page with the detected corners marked."""
    scale = 4  # render large and downsample: cheap anti aliasing
    canvas = np.zeros((size * scale, size * scale, 3), np.uint8)
    canvas[:] = BACKGROUND
    if rounded:
        canvas = rounded_rectangle(canvas, BACKGROUND)
    big = size * scale
    padding = int(big * padding_ratio)

    # a page seen slightly from the side
    page = np.array([[padding * 1.35, padding * 0.9],
                     [big - padding * 0.95, padding * 1.5],
                     [big - padding * 1.35, big - padding * 0.9],
                     [padding * 0.95, big - padding * 1.5]], np.int32)
    cv2.fillConvexPoly(canvas, page, PAPER, cv2.LINE_AA)

    # text lines on the page
    top = page[0] * 0.5 + page[3] * 0.5
    for index in range(4):
        offset = (index + 1) / 5.0
        start = page[0] * (1 - offset) + page[3] * offset
        end = page[1] * (1 - offset) + page[2] * offset
        left = start + (end - start) * 0.16
        right = start + (end - start) * (0.86 if index % 2 == 0 else 0.62)
        cv2.line(canvas, tuple(left.astype(int)), tuple(right.astype(int)),
                 (90, 90, 90), max(2, int(big * 0.022)), cv2.LINE_AA)
    del top

    # corner brackets, like the detection overlay
    length = int(big * 0.1)
    thickness = max(3, int(big * 0.03))
    for index, corner in enumerate(page):
        for neighbour in (page[(index + 1) % 4], page[(index + 3) % 4]):
            direction = (neighbour - corner).astype(float)
            norm = np.linalg.norm(direction)
            if norm < 1:
                continue
            end = corner + direction / norm * length
            cv2.line(canvas, tuple(corner.astype(int)), tuple(end.astype(int)),
                     ACCENT, thickness, cv2.LINE_AA)

    return cv2.resize(canvas, (size, size), interpolation=cv2.INTER_AREA)


def main():
    for size in (192, 512, 180):
        cv2.imwrite(os.path.join(HERE, "icon-{}.png".format(size)), draw_icon(size))
    # maskable icons need their content inside the safe zone (80% circle)
    cv2.imwrite(os.path.join(HERE, "icon-maskable-512.png"),
                draw_icon(512, padding_ratio=0.28, rounded=False))
    print("wrote icons to {}".format(HERE))


if __name__ == "__main__":
    main()
