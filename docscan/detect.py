"""Detection of the page outline (a quadrilateral) inside a photo.

Copyright 2026 PyCAM contributors

This file is part of the docscan document scanner.  It is free software:
you can redistribute it and/or modify it under the terms of the GNU General
Public License as published by the Free Software Foundation, either version 3
of the License, or (at your option) any later version.
"""

from dataclasses import dataclass, field

import numpy as np

import cv2

from docscan.transform import order_corners, quad_area, quad_is_sane


# relative tolerances used when simplifying a contour to four corners
APPROX_EPSILONS = (0.01, 0.02, 0.03, 0.04, 0.06, 0.08)


@dataclass
class Detection:
    """A detected page outline in the coordinate system of the input image."""

    quad: np.ndarray
    score: float
    method: str
    area_ratio: float = 0.0
    details: dict = field(default_factory=dict)


def full_frame_quad(shape):
    """Return the outline of the complete image (used when nothing is detected)."""
    height, width = shape[:2]
    return np.array([[0.0, 0.0],
                     [width - 1.0, 0.0],
                     [width - 1.0, height - 1.0],
                     [0.0, height - 1.0]], dtype=np.float64)


def touches_border(quad, shape, tolerance=0.01):
    """Tell whether the outline runs into the image border.

    A page that is cut off by the frame cannot be rectified properly, so the
    live preview uses this to warn the user to step back.
    """
    height, width = shape[:2]
    limit = tolerance * max(height, width)
    points = np.asarray(quad, dtype=np.float64).reshape(-1, 2)
    return bool(np.any(points[:, 0] <= limit) or np.any(points[:, 1] <= limit)
                or np.any(points[:, 0] >= width - 1 - limit)
                or np.any(points[:, 1] >= height - 1 - limit))


def _to_gray(image):
    if image.ndim == 2:
        return image
    return cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)


def _resize_for_analysis(image, working_size):
    """Downscale for a fast and less noise sensitive analysis; never upscale."""
    height, width = image.shape[:2]
    longest = max(height, width)
    if not working_size or longest <= working_size:
        return image, 1.0
    scale = working_size / float(longest)
    resized = cv2.resize(image, (max(1, int(round(width * scale))),
                                 max(1, int(round(height * scale)))),
                         interpolation=cv2.INTER_AREA)
    return resized, scale


def _auto_canny(gray, sigma=0.33):
    median = float(np.median(gray))
    lower = int(max(0, (1.0 - sigma) * median))
    upper = int(min(255, (1.0 + sigma) * median))
    if upper <= lower:
        lower, upper = 50, 150
    return cv2.Canny(gray, lower, upper)


def _close(mask, size=5):
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (size, size))
    return cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)


def _edge_maps(image):
    """Yield (name, binary mask) pairs from several complementary strategies.

    Different scenes fail in different ways: a Canny edge map is great for a
    page on a textured desk, an Otsu threshold works better for a page on a
    dark, uniform surface, and the morphological gradient catches low contrast
    borders.  All of them are tried and the best scoring result wins.
    """
    gray = _to_gray(image)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    smoothed = cv2.bilateralFilter(gray, 9, 60, 60)

    yield "canny", _close(_auto_canny(blurred))
    yield "canny-bilateral", _close(_auto_canny(smoothed), 7)

    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    gradient = cv2.morphologyEx(smoothed, cv2.MORPH_GRADIENT, kernel)
    _, gradient_mask = cv2.threshold(gradient, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    yield "gradient", _close(gradient_mask)

    _, otsu = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    yield "otsu", _close(otsu, 7)
    yield "otsu-inverted", _close(cv2.bitwise_not(otsu), 7)

    if image.ndim == 3:
        # paper is usually the least saturated area of the scene
        saturation = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)[:, :, 1]
        saturation = cv2.GaussianBlur(saturation, (5, 5), 0)
        _, mask = cv2.threshold(saturation, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        yield "saturation", _close(mask, 7)


def _quad_candidates(contour):
    """Reduce a contour to four corners, trying several simplification levels."""
    perimeter = cv2.arcLength(contour, True)
    if perimeter <= 0:
        return
    hull = cv2.convexHull(contour)
    for source in (contour, hull):
        for epsilon in APPROX_EPSILONS:
            approx = cv2.approxPolyDP(source, epsilon * perimeter, True)
            if len(approx) == 4:
                yield approx.reshape(4, 2).astype(np.float64)
    # last resort: the minimal area rectangle around the contour
    yield cv2.boxPoints(cv2.minAreaRect(contour)).astype(np.float64)


def _gradient_map(image):
    """Return a smooth, normalised edge strength map used to verify candidates."""
    gray = _to_gray(image)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    magnitude = cv2.magnitude(cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3),
                              cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3))
    # blurring makes the support test tolerant against a few pixels of offset
    magnitude = cv2.GaussianBlur(magnitude, (0, 0), 2.0)
    reference = float(np.percentile(magnitude, 99.0))
    if reference < 1e-6:
        return np.zeros_like(magnitude)
    return np.clip(magnitude / reference, 0.0, 1.0)


def _edge_support(gradient, quad, samples=40, border_tolerance=0.012):
    """Return the weakest average edge strength along the four sides of a quad.

    Taking the minimum (instead of the mean) rejects outlines that only follow
    a real border on some of their sides - a common failure mode of threshold
    based masks, which happily return the whole frame.

    Sides that run along the image border are a special case: a page held too
    close to the camera is cut off by the frame and has no visible border
    there.  Such sides are left out of the vote (with a small penalty) instead
    of failing the candidate, but a candidate that is mostly made of image
    borders is rejected outright - that is a frame, not a page.
    """
    height, width = gradient.shape[:2]
    limit = border_tolerance * max(height, width)
    points = np.asarray(quad, dtype=np.float64).reshape(-1, 2)
    steps = np.linspace(0.08, 0.92, samples)
    supports = []
    border_sides = 0
    for index in range(4):
        start = points[index]
        end = points[(index + 1) % 4]
        samples_xy = start + (end - start) * steps[:, None]
        columns = np.rint(samples_xy[:, 0]).astype(np.int64)
        rows = np.rint(samples_xy[:, 1]).astype(np.int64)
        on_border = ((columns <= limit) | (columns >= width - 1 - limit)
                     | (rows <= limit) | (rows >= height - 1 - limit))
        if np.mean(on_border) > 0.8:
            border_sides += 1
            continue
        inside = (columns >= 0) & (columns < width) & (rows >= 0) & (rows < height)
        # a side may run along the border for part of its length: those samples
        # carry no evidence either way and are left out of the average
        usable = inside & ~on_border
        if not np.any(usable):
            return 0.0
        values = gradient[rows[usable], columns[usable]]
        # ... but a side that is mostly outside the frame stays suspicious
        supports.append(float(np.mean(values)) * min(1.0, np.count_nonzero(inside)
                                                     / (0.75 * samples)))
    if border_sides >= 3 or not supports:
        return 0.0
    return min(supports) * (0.85 ** border_sides)


def _score(quad, contour_area, image_area, gradient):
    """Rate a candidate by edge evidence, rectangularity and size."""
    area = quad_area(quad)
    if area <= 0:
        return 0.0, 0.0
    area_ratio = area / image_area
    # a good page outline encloses its contour tightly
    fill = min(contour_area / area, area / contour_area) if contour_area > 0 else 0.0
    support = _edge_support(gradient, quad)
    score = support * (0.3 + 0.7 * fill) * (area_ratio ** 0.25)
    return score, area_ratio


def detect_candidates(image, min_area_ratio=0.08, working_size=720, max_contours=8,
                      min_score=0.05):
    """Return all plausible page outlines, best score first."""
    small, scale = _resize_for_analysis(image, working_size)
    image_area = float(small.shape[0] * small.shape[1])
    gradient = _gradient_map(small)
    candidates = []
    for name, mask in _edge_maps(small):
        contours, _ = cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        contours = sorted(contours, key=cv2.contourArea, reverse=True)[:max_contours]
        for contour in contours:
            contour_area = float(cv2.contourArea(contour))
            if contour_area / image_area < min_area_ratio:
                continue
            for quad in _quad_candidates(contour):
                if not quad_is_sane(quad):
                    continue
                score, area_ratio = _score(quad, contour_area, image_area, gradient)
                if area_ratio < min_area_ratio or area_ratio > 1.05:
                    continue
                if score < min_score:
                    continue
                ordered = order_corners(quad)
                if scale != 1.0:
                    ordered = ordered / scale
                candidates.append(Detection(quad=ordered, score=score, method=name,
                                            area_ratio=area_ratio))
    candidates.sort(key=lambda item: item.score, reverse=True)
    return _deduplicate(candidates)


def _deduplicate(candidates, tolerance=0.02):
    """Drop candidates whose corners nearly coincide with a better scoring one."""
    kept = []
    for candidate in candidates:
        limit = tolerance * max(np.ptp(candidate.quad[:, 0]), np.ptp(candidate.quad[:, 1]), 1.0)
        if any(np.max(np.linalg.norm(candidate.quad - other.quad, axis=1)) <= limit
               for other in kept):
            continue
        kept.append(candidate)
    return kept


def _contains(outer, inner, tolerance=2.0):
    """True when every corner of ``inner`` lies inside ``outer``."""
    contour = np.asarray(outer, dtype=np.float32).reshape(-1, 1, 2)
    return all(cv2.pointPolygonTest(contour, (float(x), float(y)), True) >= -tolerance
               for x, y in np.asarray(inner, dtype=np.float64).reshape(-1, 2))


def _prefer_enclosing(candidates, shape=None, score_ratio=0.6, clipped_score_ratio=0.35,
                      area_ratio=1.25):
    """Promote an outline that encloses the best candidate and is clearly bigger.

    Text columns and framed illustrations are often crisper than the edge of
    the sheet they sit on.  When a noticeably larger outline still has a decent
    score and contains the leader, it is the page the user meant.

    A page that is cut off by the frame always scores lower (part of its border
    simply is not visible), so a lower bar applies to such candidates: losing
    page content is a worse mistake than keeping a bit of background.
    """
    if len(candidates) < 2:
        return candidates
    best = candidates[0]
    promoted = best
    for candidate in candidates[1:]:
        clipped = shape is not None and touches_border(candidate.quad, shape)
        limit = clipped_score_ratio if clipped else score_ratio
        if candidate.score < limit * best.score:
            continue
        if quad_area(candidate.quad) < area_ratio * quad_area(promoted.quad):
            continue
        if _contains(candidate.quad, best.quad):
            promoted = candidate
    if promoted is best:
        return candidates
    return [promoted] + [item for item in candidates if item is not promoted]


def find_document(image, min_area_ratio=0.08, working_size=720, fallback=False,
                  min_score=0.05):
    """Return the best page outline of ``image`` or ``None`` when nothing fits.

    With ``fallback=True`` the outline of the complete image is returned
    instead of ``None`` - useful for photos that are already cropped to the
    page, where no border is visible at all.
    """
    candidates = detect_candidates(image, min_area_ratio=min_area_ratio,
                                   working_size=working_size, min_score=min_score)
    candidates = _prefer_enclosing(candidates, image.shape)
    if candidates:
        return candidates[0]
    if fallback:
        return Detection(quad=full_frame_quad(image.shape), score=0.0, method="full-frame",
                         area_ratio=1.0)
    return None


def draw_outline(image, quad, colour=(0, 220, 0), thickness=2, corner_radius=6, label=None):
    """Return a copy of ``image`` with the outline and its corners drawn on top."""
    preview = image.copy()
    if quad is None:
        return preview
    points = np.asarray(quad, dtype=np.int32).reshape(-1, 1, 2)
    overlay = preview.copy()
    cv2.fillPoly(overlay, [points], colour)
    cv2.addWeighted(overlay, 0.18, preview, 0.82, 0, preview)
    cv2.polylines(preview, [points], True, colour, thickness, cv2.LINE_AA)
    for index, corner in enumerate(np.asarray(quad, dtype=np.int32).reshape(-1, 2)):
        cv2.circle(preview, tuple(corner), corner_radius, colour, -1, cv2.LINE_AA)
        cv2.circle(preview, tuple(corner), corner_radius, (255, 255, 255), 1, cv2.LINE_AA)
        if label:
            cv2.putText(preview, str(index + 1), tuple(corner + np.array([8, -8])),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
    return preview
