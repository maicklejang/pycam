"""Rendering of synthetic document photos used by the tests.

A page is rendered, projected into a virtual camera with a known pose and
pasted onto a background.  That gives the tests photos with exactly known
page corners, so detection and rectification can be checked numerically.
"""

import numpy as np

import cv2

BACKGROUNDS = ("wood", "dark", "light", "cloth")


def render_page(width=620, ratio=210.0 / 297.0, lines=14, seed=0):
    """Render a sheet of paper with a few lines of "text"."""
    generator = np.random.default_rng(seed)
    height = int(round(width / ratio))
    page = np.full((height, width, 3), 250, np.uint8)
    for index in range(lines):
        position = 40 + index * int((height - 80) / lines)
        end = width - 40 - int(generator.integers(0, width // 4))
        cv2.line(page, (40, position), (end, position), (40, 40, 40), 3)
    return page


def render_background(kind, size, seed=0):
    generator = np.random.default_rng(seed + 11)
    height, width = size
    if kind == "wood":
        image = np.full((height, width, 3), (60, 90, 130), np.uint8)
        image = cv2.add(image, generator.integers(0, 35, (height, width, 3),
                                                  dtype=np.int16).astype(np.uint8))
        for row in range(0, height, 23):
            cv2.line(image, (0, row), (width, row), (45, 70, 110), 2)
        return image
    if kind == "dark":
        return np.full((height, width, 3), (25, 25, 28), np.uint8)
    if kind == "cloth":
        image = np.full((height, width, 3), (110, 120, 140), np.uint8)
        return cv2.add(image, generator.integers(0, 60, (height, width, 3),
                                                 dtype=np.int16).astype(np.uint8))
    return np.full((height, width, 3), (200, 200, 205), np.uint8)


def project_quad(ratio, rotation, distance, focal, size):
    """Return the image corners of a rectangle seen by a virtual camera."""
    height, width = size
    camera = np.array([[focal, 0, width / 2], [0, focal, height / 2], [0, 0, 1.0]])
    corners = np.array([[-ratio / 2, -0.5, 0], [ratio / 2, -0.5, 0],
                        [ratio / 2, 0.5, 0], [-ratio / 2, 0.5, 0]], dtype=float)
    projected, _ = cv2.projectPoints(corners, np.asarray(rotation, dtype=float),
                                     np.array([0.0, 0.0, distance]), camera, None)
    return projected.reshape(-1, 2).astype(np.float32)


def photograph(background="wood", rotation=(0.35, 0.4, 0.12), distance=1.7, focal=900.0,
               size=(720, 1280), ratio=210.0 / 297.0, lighting=0.0, noise=0.0, seed=0):
    """Return (photo, true page corners) of a synthetic document photo."""
    page = render_page(ratio=ratio, seed=seed)
    image = render_background(background, size, seed=seed)
    quad = project_quad(ratio, rotation, distance, focal, size)
    page_height, page_width = page.shape[:2]
    source = np.array([[0, 0], [page_width - 1, 0], [page_width - 1, page_height - 1],
                       [0, page_height - 1]], dtype=np.float32)
    matrix = cv2.getPerspectiveTransform(source, quad)
    warped = cv2.warpPerspective(page, matrix, (size[1], size[0]))
    mask = cv2.warpPerspective(np.full((page_height, page_width), 255, np.uint8),
                               matrix, (size[1], size[0]))
    image[mask > 0] = warped[mask > 0]
    if lighting:
        rows, columns = np.mgrid[0:size[0], 0:size[1]]
        falloff = np.exp(-(((columns - size[1] * 0.3) ** 2 + (rows - size[0] * 0.2) ** 2)
                           / (0.35 * size[1] ** 2)))
        shade = ((1.0 - lighting) + lighting * falloff).astype(np.float32)
        image = np.clip(image.astype(np.float32) * shade[..., None], 0, 255).astype(np.uint8)
    image = cv2.GaussianBlur(image, (3, 3), 0)
    if noise:
        generator = np.random.default_rng(seed + 5)
        image = np.clip(image.astype(np.float32)
                        + generator.normal(0, noise, image.shape), 0, 255).astype(np.uint8)
    return image, quad
