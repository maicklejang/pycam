"""Geometry helpers: corner ordering, aspect estimation and perspective warping.

Copyright 2026 PyCAM contributors

This file is part of the docscan document scanner.  It is free software:
you can redistribute it and/or modify it under the terms of the GNU General
Public License as published by the Free Software Foundation, either version 3
of the License, or (at your option) any later version.
"""

import numpy as np

import cv2


# width/height ratios of common paper formats (portrait orientation)
PAPER_RATIOS = {
    "a4": 210.0 / 297.0,
    "a3": 297.0 / 420.0,
    "a5": 148.0 / 210.0,
    "letter": 8.5 / 11.0,
    "legal": 8.5 / 14.0,
    "square": 1.0,
}

# aspect ratios outside of this range are considered implausible for a document
MIN_RATIO = 0.15
MAX_RATIO = 1.0 / MIN_RATIO


def order_corners(points):
    """Return the four corners ordered as top-left, top-right, bottom-right, bottom-left.

    The points are sorted by their angle around the centroid (which yields a
    consistent clockwise order in image coordinates, where y grows downwards)
    and then rotated so that the corner closest to the image origin comes first.
    """
    pts = np.asarray(points, dtype=np.float64).reshape(-1, 2)
    if pts.shape[0] != 4:
        raise ValueError("exactly four corners are required, got {}".format(pts.shape[0]))
    centre = pts.mean(axis=0)
    angles = np.arctan2(pts[:, 1] - centre[1], pts[:, 0] - centre[0])
    pts = pts[np.argsort(angles)]
    start = int(np.argmin(pts.sum(axis=1)))
    return np.roll(pts, -start, axis=0)


def quad_is_sane(quad, min_angle_cos=0.6):
    """Check that the quad is convex and free of degenerate (very sharp) corners."""
    pts = np.asarray(quad, dtype=np.float64).reshape(-1, 2)
    if pts.shape[0] != 4:
        return False
    if not np.all(np.isfinite(pts)):
        return False
    crosses = []
    for index in range(4):
        previous = pts[index - 1] - pts[index]
        following = pts[(index + 1) % 4] - pts[index]
        len_previous = np.linalg.norm(previous)
        len_following = np.linalg.norm(following)
        if len_previous < 1e-6 or len_following < 1e-6:
            return False
        cosine = abs(float(np.dot(previous, following)) / (len_previous * len_following))
        if cosine > min_angle_cos:
            # corner angle is below ~53 degrees or above ~127 degrees
            return False
        # 2D cross product: its sign tells the turn direction at this corner
        crosses.append(float(previous[0] * following[1] - previous[1] * following[0]))
    signs = {cross > 0 for cross in crosses}
    return len(signs) == 1


def quad_area(quad):
    """Return the area of a quad via the shoelace formula."""
    pts = np.asarray(quad, dtype=np.float64).reshape(-1, 2)
    x, y = pts[:, 0], pts[:, 1]
    return 0.5 * abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


def expand_quad(quad, margin):
    """Scale the quad around its centroid (``margin`` is a fraction, e.g. 0.02)."""
    if not margin:
        return np.asarray(quad, dtype=np.float64).reshape(-1, 2)
    pts = np.asarray(quad, dtype=np.float64).reshape(-1, 2)
    centre = pts.mean(axis=0)
    return centre + (pts - centre) * (1.0 + margin)


def edge_lengths(ordered_quad):
    """Return (width, height) estimated from the longest pair of opposing edges."""
    tl, tr, br, bl = np.asarray(ordered_quad, dtype=np.float64)
    width = max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl))
    height = max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr))
    return float(width), float(height)


def _rectification_vectors(ordered_quad, image_shape):
    """The two vanishing directions and the principal point of a quad.

    The shared first half of the Zhang & He rectification: ``n2`` and ``n3``
    are the images of the rectangle's two edge directions, and everything the
    focal length and the aspect ratio need is in them.
    """
    tl, tr, br, bl = np.asarray(ordered_quad, dtype=np.float64)
    # the algorithm expects the corners as top-left, top-right, bottom-left, bottom-right
    m1 = np.array([tl[0], tl[1], 1.0])
    m2 = np.array([tr[0], tr[1], 1.0])
    m3 = np.array([bl[0], bl[1], 1.0])
    m4 = np.array([br[0], br[1], 1.0])

    height, width = image_shape[:2]
    u0 = width / 2.0
    v0 = height / 2.0

    denominator_k2 = float(np.dot(np.cross(m2, m4), m3))
    denominator_k3 = float(np.dot(np.cross(m3, m4), m2))
    if abs(denominator_k2) < 1e-9 or abs(denominator_k3) < 1e-9:
        return None
    k2 = float(np.dot(np.cross(m1, m4), m3)) / denominator_k2
    k3 = float(np.dot(np.cross(m1, m4), m2)) / denominator_k3

    n2 = k2 * m2 - m1
    n3 = k3 * m3 - m1

    if abs(k2 - 1.0) < 1e-6 and abs(k3 - 1.0) < 1e-6:
        # parallel projection: the shape is an affine image of the rectangle and
        # the focal length cannot be recovered
        return None
    if abs(n2[2]) < 1e-9 or abs(n3[2]) < 1e-9:
        return None
    return n2, n3, u0, v0


def projective_focal(ordered_quad, image_shape):
    """Camera focal length in pixels, from the perspective of a rectangle.

    Returns ``None`` for a shot that carries no perspective (the corners of a
    fronto-parallel page say nothing about the lens).
    """
    vectors = _rectification_vectors(ordered_quad, image_shape)
    if vectors is None:
        return None
    n2, n3, u0, v0 = vectors
    f_squared = -((n2[0] * n3[0] - (n2[0] * n3[2] + n2[2] * n3[0]) * u0
                   + n2[2] * n3[2] * u0 * u0)
                  + (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0
                     + n2[2] * n3[2] * v0 * v0)) / (n2[2] * n3[2])
    if not np.isfinite(f_squared) or f_squared <= 0.0:
        return None
    return float(np.sqrt(f_squared))


def projective_aspect_ratio(ordered_quad, image_shape):
    """Estimate the true width/height ratio of the rectangle behind a quad.

    This implements the well known rectification approach (Zhang & He): the
    perspective distortion of the quad is used to recover the camera focal
    length, which in turn yields the aspect ratio of the original rectangle.
    Returns ``None`` when the geometry carries no usable perspective
    information (e.g. a fronto-parallel shot) or the result is degenerate.
    """
    vectors = _rectification_vectors(ordered_quad, image_shape)
    if vectors is None:
        return None
    n2, n3, u0, v0 = vectors
    focal = projective_focal(ordered_quad, image_shape)
    if focal is None:
        return None

    camera = np.array([[focal, 0.0, u0], [0.0, focal, v0], [0.0, 0.0, 1.0]])
    inverse = np.linalg.inv(camera)
    metric = inverse.T @ inverse
    numerator = float(n2 @ metric @ n2)
    denominator = float(n3 @ metric @ n3)
    if denominator <= 0.0 or numerator <= 0.0:
        return None
    ratio = float(np.sqrt(numerator / denominator))
    if not np.isfinite(ratio) or not (MIN_RATIO <= ratio <= MAX_RATIO):
        return None
    return ratio


def target_aspect_ratio(ordered_quad, image_shape, mode="auto"):
    """Return the width/height ratio to be used for the rectified output."""
    width, height = edge_lengths(ordered_quad)
    edge_ratio = width / height if height > 1e-6 else 1.0
    if mode in (None, "none", "edges"):
        return edge_ratio
    if mode in PAPER_RATIOS:
        ratio = PAPER_RATIOS[mode]
        # match the orientation (portrait/landscape) of the detected quad
        return ratio if edge_ratio <= 1.0 else 1.0 / ratio
    if mode in ("auto", "projective"):
        ratio = projective_aspect_ratio(ordered_quad, image_shape)
        if ratio is None:
            return edge_ratio
        if mode == "auto":
            # guard against wild estimates from noisy corners
            relative = ratio / edge_ratio if edge_ratio > 1e-6 else 0.0
            if not (0.5 <= relative <= 2.0):
                return edge_ratio
        return ratio
    raise ValueError("unknown aspect mode: {}".format(mode))


def output_size(ordered_quad, image_shape, aspect="auto", max_side=None):
    """Return the (width, height) in pixels of the rectified document."""
    width, height = edge_lengths(ordered_quad)
    ratio = target_aspect_ratio(ordered_quad, image_shape, aspect)
    # keep the resolution of the longer side and derive the shorter one
    if width >= height:
        out_width = width
        out_height = width / ratio
    else:
        out_height = height
        out_width = height * ratio
    if max_side:
        longest = max(out_width, out_height)
        if longest > max_side:
            scale = max_side / longest
            out_width *= scale
            out_height *= scale
    return max(1, int(round(out_width))), max(1, int(round(out_height)))


def four_point_transform(image, quad, aspect="auto", margin=0.0, size=None):
    """Rectify the quad of ``image`` into a straight, front facing rectangle."""
    ordered = order_corners(expand_quad(quad, margin))
    if size is None:
        size = output_size(ordered, image.shape, aspect=aspect)
    width, height = size
    destination = np.array([[0.0, 0.0],
                            [width - 1.0, 0.0],
                            [width - 1.0, height - 1.0],
                            [0.0, height - 1.0]], dtype=np.float32)
    matrix = cv2.getPerspectiveTransform(ordered.astype(np.float32), destination)
    source_area = quad_area(ordered)
    # shrinking benefits from area averaging, upscaling from cubic interpolation
    interpolation = cv2.INTER_AREA if source_area > width * height else cv2.INTER_CUBIC
    return cv2.warpPerspective(image, matrix, (width, height), flags=interpolation,
                               borderMode=cv2.BORDER_REPLICATE)


def rotate_image(image, degrees):
    """Rotate by a multiple of 90 degrees (clockwise, positive values)."""
    turns = int(round((degrees % 360) / 90.0)) % 4
    if turns == 0:
        return image
    if turns == 1:
        return cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE)
    if turns == 2:
        return cv2.rotate(image, cv2.ROTATE_180)
    return cv2.rotate(image, cv2.ROTATE_90_COUNTERCLOCKWISE)
