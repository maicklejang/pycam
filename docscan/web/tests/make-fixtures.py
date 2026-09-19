#!/usr/bin/env python3
"""Render the fixtures used by the browser tests.

The images and the reference results come from the python implementation, so
the browser tests can check that the JavaScript port still agrees with it.

Run from the repository root::

    python3 docscan/web/tests/make-fixtures.py
"""

import json
import os
import sys

import numpy as np

import cv2

# the repository root, so that "docscan" can be imported without installing it
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                os.pardir, os.pardir, os.pardir)))

from docscan.detect import find_document  # noqa: E402  (needs the path above)
from docscan.enhance import MODES  # noqa: E402  (needs the path above)
from docscan.scanner import ScanOptions, scan_image  # noqa: E402  (needs the path above)
from docscan.tests.synthetic import photograph  # noqa: E402  (needs the path above)
from docscan.transform import order_corners  # noqa: E402  (needs the path above)

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")

CASES = [
    ("wood", (0.35, 0.4, 0.12), 1.7),
    ("wood", (0.05, 0.05, 0.0), 1.9),
    ("dark", (0.6, -0.5, 0.2), 1.9),
    ("dark", (-0.4, 0.3, -0.3), 2.2),
    ("cloth", (0.3, 0.35, 0.1), 1.8),
    ("cloth", (-0.35, -0.3, 0.25), 2.0),
]


def write_video(path, image, frames=8, fps=15):
    """A Y4M clip of a still document photo, for Chromium's fake camera."""
    height, width = image.shape[:2]
    planar = cv2.cvtColor(image, cv2.COLOR_BGR2YUV_I420).tobytes()
    with open(path, "wb") as video:
        video.write("YUV4MPEG2 W{} H{} F{}:1 Ip A1:1 C420mpeg2\n".format(
            width, height, fps).encode("ascii"))
        for _ in range(frames):
            video.write(b"FRAME\n")
            video.write(planar)


def main():
    os.makedirs(FIXTURES, exist_ok=True)
    cases = []
    for index, (background, rotation, distance) in enumerate(CASES):
        image, quad = photograph(background=background, rotation=rotation, distance=distance,
                                 lighting=0.4, noise=3, seed=index)
        name = "case{:02d}_{}.jpg".format(index, background)
        cv2.imwrite(os.path.join(FIXTURES, name), image, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
        # detect on the stored file, so python and the browser see the same pixels
        stored = cv2.imread(os.path.join(FIXTURES, name))
        detection = find_document(stored)
        truth = order_corners(quad)
        error = (None if detection is None
                 else float(np.max(np.linalg.norm(detection.quad - truth, axis=1))))
        cases.append({
            "name": name,
            "truth": truth.tolist(),
            "python": {
                "method": None if detection is None else detection.method,
                "error": None if error is None else round(error, 2),
            },
        })

    # one case through every colour mode, as a reference for the enhancement port
    reference = cv2.imread(os.path.join(FIXTURES, cases[0]["name"]))
    modes = {}
    for mode in MODES:
        result = scan_image(reference, ScanOptions(mode=mode))
        filename = "python_{}.png".format(mode)
        cv2.imwrite(os.path.join(FIXTURES, filename), result.image)
        modes[mode] = {"file": filename, "width": result.size[0], "height": result.size[1]}

    write_video(os.path.join(FIXTURES, "fakecam.y4m"),
                cv2.imread(os.path.join(FIXTURES, cases[0]["name"])))

    with open(os.path.join(FIXTURES, "fixtures.json"), "w") as handle:
        json.dump({"cases": cases, "modes": modes, "source": cases[0]["name"]}, handle, indent=1)
    print("wrote {} cases to {}".format(len(cases), FIXTURES))


if __name__ == "__main__":
    main()
