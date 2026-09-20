"""Curved page outlines and flattening.

A photographed page is rarely a flat rectangle: a book bends, a receipt curls,
a stapled sheet lifts at the corner.  The perspective transform in
``transform.py`` can only straighten a flat quad, so a curved page comes out
with bowed text lines.

This module describes the outline as four quadratic Bezier edges instead of
four straight ones, and maps that curved patch onto a rectangle (a Coons
patch).  The control points can come from the user dragging an edge in the web
app, or from ``refine_edges`` following the real page border in the photo.

Copyright 2026 PyCAM contributors

This file is part of the docscan document scanner.  It is free software:
you can redistribute it and/or modify it under the terms of the GNU General
Public License as published by the Free Software Foundation, either version 3
of the License, or (at your option) any later version.
"""

from dataclasses import dataclass

import numpy as np

import cv2

from docscan.transform import PAPER_RATIOS, order_corners

#: corner order is top-left, top-right, bottom-right, bottom-left, so the edges
#: run top, right, bottom (right to left), left (bottom to top)
EDGE_NAMES = ("top", "right", "bottom", "left")


def bezier_point(start, control, end, t):
    """Quadratic Bezier at ``t``; ``t`` may be an array."""
    t = np.asarray(t, dtype=np.float64)[..., None]
    start = np.asarray(start, dtype=np.float64)
    control = np.asarray(control, dtype=np.float64)
    end = np.asarray(end, dtype=np.float64)
    return ((1 - t) ** 2) * start + 2 * (1 - t) * t * control + (t ** 2) * end


def control_from_midpoint(start, end, midpoint):
    """Control point of the curve that passes through ``midpoint`` at t=0.5.

    The web app lets people drag a handle that sits *on* the edge, which is far
    more predictable than dragging a Bezier control point off in space.
    """
    start = np.asarray(start, dtype=np.float64)
    end = np.asarray(end, dtype=np.float64)
    midpoint = np.asarray(midpoint, dtype=np.float64)
    return 2.0 * midpoint - 0.5 * (start + end)


def midpoint_from_control(start, control, end):
    """The point the curve passes through at t=0.5 (inverse of the above)."""
    return bezier_point(start, control, end, 0.5)


@dataclass
class CurvedQuad:
    """Four corners plus one Bezier control point per edge."""

    corners: np.ndarray          # (4, 2), ordered TL, TR, BR, BL
    controls: np.ndarray         # (4, 2), one per edge in EDGE_NAMES order

    @classmethod
    def from_quad(cls, quad):
        """A straight outline: every control point sits on the edge midpoint."""
        corners = order_corners(quad)
        controls = np.array([(corners[index] + corners[(index + 1) % 4]) / 2.0
                             for index in range(4)])
        return cls(corners=corners, controls=controls)

    @classmethod
    def from_midpoints(cls, corners, midpoints):
        """Build from corners and the points each edge should pass through."""
        corners = order_corners(corners)
        midpoints = np.asarray(midpoints, dtype=np.float64).reshape(4, 2)
        controls = np.array([control_from_midpoint(corners[index],
                                                   corners[(index + 1) % 4],
                                                   midpoints[index])
                             for index in range(4)])
        return cls(corners=corners, controls=controls)

    @property
    def midpoints(self):
        """Where each edge passes at t=0.5 - what the UI shows as a handle."""
        return np.array([midpoint_from_control(self.corners[index], self.controls[index],
                                               self.corners[(index + 1) % 4])
                         for index in range(4)])

    def edge(self, index, t):
        """Sample edge ``index`` (see EDGE_NAMES) at parameter(s) ``t``."""
        return bezier_point(self.corners[index], self.controls[index],
                            self.corners[(index + 1) % 4], t)

    def edge_length(self, index, samples=64):
        points = self.edge(index, np.linspace(0.0, 1.0, samples))
        return float(np.sum(np.linalg.norm(np.diff(points, axis=0), axis=1)))

    #: a bulge smaller than this fraction of the edge is treated as straight
    STRAIGHT_LIMIT = 0.012

    @property
    def is_straight(self):
        """True when every edge is (almost) a straight line."""
        return self.curvature() < self.STRAIGHT_LIMIT

    def edge_bulge(self, index):
        """Signed sideways offset of an edge, in pixels; positive is outwards."""
        start = self.corners[index]
        end = self.corners[(index + 1) % 4]
        length = float(np.linalg.norm(end - start))
        if length < 1e-6:
            return 0.0
        middle = midpoint_from_control(start, self.controls[index], end)
        outward = (start + end) / 2.0 - self.corners.mean(axis=0)
        norm = float(np.linalg.norm(outward))
        if norm < 1e-6:
            return 0.0
        return float(np.dot(middle - (start + end) / 2.0, outward / norm))

    def edge_curvature(self, index):
        """:meth:`edge_bulge` relative to the length of that edge."""
        start = self.corners[index]
        end = self.corners[(index + 1) % 4]
        length = float(np.linalg.norm(end - start))
        return 0.0 if length < 1e-6 else self.edge_bulge(index) / length

    def curvature(self):
        """Largest sideways bulge of an edge, relative to that edge's length."""
        worst = 0.0
        for index in range(4):
            start = self.corners[index]
            end = self.corners[(index + 1) % 4]
            length = float(np.linalg.norm(end - start))
            if length < 1e-6:
                continue
            middle = midpoint_from_control(start, self.controls[index], end)
            offset = float(np.linalg.norm(middle - (start + end) / 2.0))
            worst = max(worst, offset / length)
        return worst

    def as_dict(self):
        return {"corners": self.corners.tolist(), "midpoints": self.midpoints.tolist()}


def _length_factor(curved, index_a, index_b):
    """How much longer the curved edges are than the straight chords."""
    best = 1.0
    for index in (index_a, index_b):
        start = curved.corners[index]
        end = curved.corners[(index + 1) % 4]
        chord = float(np.linalg.norm(end - start))
        if chord < 1e-6:
            continue
        best = max(best, curved.edge_length(index) / chord)
    return best


def flatten_size(curved, image_shape=None, aspect="auto", max_side=None):
    """Output size for a flattened page.

    The straight case reuses the focal length based estimate from
    ``transform.py``; a curled page is then stretched by how much longer its
    curved edges are, because the unrolled sheet has to be that long.
    """
    from docscan.transform import output_size

    ordered = curved.corners
    if aspect in PAPER_RATIOS or image_shape is None:
        width = max(curved.edge_length(0), curved.edge_length(2))
        height = max(curved.edge_length(1), curved.edge_length(3))
        if aspect in PAPER_RATIOS:
            ratio = PAPER_RATIOS[aspect]
            if width > height:
                ratio = 1.0 / ratio
            if width >= height:
                height = width / ratio
            else:
                width = height * ratio
    else:
        width, height = output_size(ordered, image_shape, aspect=aspect)
        width *= _length_factor(curved, 0, 2)
        height *= _length_factor(curved, 1, 3)
    if max_side:
        longest = max(width, height)
        if longest > max_side:
            scale = max_side / longest
            width *= scale
            height *= scale
    return max(1, int(round(width))), max(1, int(round(height)))


def _monotonic_interp(x_new, x, y):
    """np.interp, but tolerant of samples that are not sorted."""
    order = np.argsort(x)
    return np.interp(x_new, x[order], y[order])


def boundary_curves(curved, width, height, samples=256):
    """The four page borders in rectified coordinates.

    The corners are mapped onto the corners of a width x height rectangle, so
    what is left of each edge is a small bulge.  Expressing the top and bottom
    as y(x) and the sides as x(y) also fixes the spacing: a straight edge seen
    in perspective is not sampled evenly by its Bezier parameter, and that
    alone would bend every text line in the result.
    """
    matrix = cv2.getPerspectiveTransform(
        curved.corners.astype(np.float32),
        np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]],
                 dtype=np.float32))
    t = np.linspace(0.0, 1.0, samples)

    def to_rect(points):
        return cv2.perspectiveTransform(points.reshape(-1, 1, 2).astype(np.float64),
                                        matrix).reshape(-1, 2)

    top = to_rect(curved.edge(0, t))            # TL -> TR
    right = to_rect(curved.edge(1, t))          # TR -> BR
    bottom = to_rect(curved.edge(2, t))[::-1]   # BR -> BL, reversed to BL -> BR
    left = to_rect(curved.edge(3, t))[::-1]     # BL -> TL, reversed to TL -> BL

    xs = np.linspace(0.0, width - 1.0, width)
    ys = np.linspace(0.0, height - 1.0, height)
    curves = {
        "top": np.stack([xs, _monotonic_interp(xs, top[:, 0], top[:, 1])], axis=-1),
        "bottom": np.stack([xs, _monotonic_interp(xs, bottom[:, 0], bottom[:, 1])], axis=-1),
        "left": np.stack([_monotonic_interp(ys, left[:, 1], left[:, 0]), ys], axis=-1),
        "right": np.stack([_monotonic_interp(ys, right[:, 1], right[:, 0]), ys], axis=-1),
    }
    return curves, matrix


def coons_maps(curved, width, height):
    """Sampling maps (in photo coordinates) of the flattened page.

    The Coons patch is built in rectified space, where the four borders are
    nearly straight, and the result is mapped back into the photo with the
    inverse of the perspective transform - one interpolation, not two.
    """
    curves, matrix = boundary_curves(curved, width, height)
    top, bottom = curves["top"], curves["bottom"]
    left, right = curves["left"], curves["right"]

    u = np.linspace(0.0, 1.0, width)[None, :, None]
    v = np.linspace(0.0, 1.0, height)[:, None, None]
    tl = np.array([0.0, 0.0])
    tr = np.array([width - 1.0, 0.0])
    br = np.array([width - 1.0, height - 1.0])
    bl = np.array([0.0, height - 1.0])

    surface = ((1.0 - v) * top[None, :, :] + v * bottom[None, :, :]
               + (1.0 - u) * left[:, None, :] + u * right[:, None, :]
               - ((1.0 - u) * (1.0 - v) * tl + u * (1.0 - v) * tr
                  + u * v * br + (1.0 - u) * v * bl))

    photo = cv2.perspectiveTransform(surface.reshape(-1, 1, 2), np.linalg.inv(matrix))
    photo = photo.reshape(height, width, 2)
    return (np.ascontiguousarray(photo[:, :, 0], dtype=np.float32),
            np.ascontiguousarray(photo[:, :, 1], dtype=np.float32))


def flatten(image, curved, size=None, aspect="auto", max_side=None, margin=0.0):
    """Map a curved page outline onto a straight rectangle."""
    if margin:
        from docscan.transform import expand_quad
        curved = CurvedQuad.from_midpoints(expand_quad(curved.corners, margin),
                                           expand_quad(curved.midpoints, margin))
    if size is None:
        size = flatten_size(curved, image.shape, aspect=aspect, max_side=max_side)
    width, height = size
    map_x, map_y = coons_maps(curved, width, height)
    return cv2.remap(image, map_x, map_y, interpolation=cv2.INTER_CUBIC,
                     borderMode=cv2.BORDER_REPLICATE)


def _gradient_magnitude(image):
    gray = image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    magnitude = cv2.magnitude(cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3),
                              cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3))
    return cv2.GaussianBlur(magnitude, (0, 0), 1.5)


def _sample(plane, points, default=0.0):
    """Nearest neighbour lookup; points outside the image return ``default``."""
    height, width = plane.shape[:2]
    columns = np.clip(np.rint(points[..., 0]).astype(np.int64), 0, width - 1)
    rows = np.clip(np.rint(points[..., 1]).astype(np.int64), 0, height - 1)
    inside = ((points[..., 0] >= 0) & (points[..., 0] < width)
              & (points[..., 1] >= 0) & (points[..., 1] < height))
    return np.where(inside, plane[rows, columns].astype(np.float64), default)


#: the medians below are measured on a copy no larger than this
LEVEL_SIZE = 480


def _levels(image, quad, band):
    """Median brightness of the page and of the background around it.

    Measured on a small copy: the two medians do not need full resolution, and
    growing the page polygon by a band that is a percent of the diagonal means
    a huge structuring element at full size.
    """
    gray = image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    scale = min(1.0, LEVEL_SIZE / max(gray.shape[:2]))
    small = gray if scale == 1.0 else cv2.resize(
        gray, (max(8, int(round(gray.shape[1] * scale))),
               max(8, int(round(gray.shape[0] * scale)))), interpolation=cv2.INTER_AREA)
    polygon = np.rint(np.asarray(quad, dtype=np.float64) * scale).astype(np.int32)
    inside = np.zeros(small.shape[:2], np.uint8)
    cv2.fillPoly(inside, [polygon.reshape(-1, 1, 2)], 255)
    size = max(3, int(round(band * scale)) * 2 + 1)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))
    core = cv2.erode(inside, kernel)
    ring = cv2.subtract(cv2.dilate(inside, kernel), inside)
    if np.count_nonzero(core) < 50 or np.count_nonzero(ring) < 50:
        return gray, None, None
    return gray, float(np.median(small[core > 0])), float(np.median(small[ring > 0]))


def refine_edges(image, quad, search_ratio=0.03, samples=25, offsets=61,
                 max_curvature=0.25, hold=4):
    """Follow the real page border and return a :class:`CurvedQuad`.

    Every edge is sampled at a number of positions and, at each of them, the
    brightness is read along the edge normal from outside the page inwards.
    The border is where the profile changes from background to paper and stays
    there - not simply where the gradient is strongest, because the first line
    of text is a stronger edge than the rim of the sheet, and a textured
    surface (wood, cloth) is full of strong edges of its own.

    A quadratic is fitted through the offsets found, and edges that stay close
    to their straight chord are left straight, so a flat page is unaffected.
    """
    curved = CurvedQuad.from_quad(quad)
    diagonal = float(np.hypot(*image.shape[:2]))
    band = max(3.0, search_ratio * diagonal)
    gray, page_level, background_level = _levels(image, curved.corners, band)
    if page_level is None or abs(page_level - background_level) < 12:
        return curved          # not enough contrast to tell page from background

    steps = np.linspace(-band, band, offsets)
    controls = curved.controls.copy()
    centre = curved.corners.mean(axis=0)

    for index in range(4):
        start = curved.corners[index]
        end = curved.corners[(index + 1) % 4]
        direction = end - start
        length = float(np.linalg.norm(direction))
        if length < 1e-6:
            continue
        normal = np.array([-direction[1], direction[0]]) / length
        if np.dot(centre - (start + end) / 2.0, normal) < 0:
            normal = -normal   # point into the page

        # skip the corners: the border bends there and the fit would chase it
        t = np.linspace(0.12, 0.88, samples)
        base = start + direction * t[:, None]
        candidates = base[:, None, :] + normal[None, None, :] * steps[None, :, None]
        values = _sample(gray, candidates, default=background_level)
        page_like = (np.abs(values - page_level)
                     < np.abs(values - background_level)).astype(np.int8)

        # the border is the first offset from which the profile stays on the
        # page for at least `hold` steps
        window = np.ones(hold, dtype=np.int8)
        sustained = np.apply_along_axis(
            lambda row: np.convolve(row, window, mode="valid") == hold, 1, page_like)
        has_border = sustained.any(axis=1)
        crossing = np.argmax(sustained, axis=1)
        shift = np.where(has_border, steps[crossing], np.nan)

        if np.count_nonzero(has_border) < max(4, samples // 2):
            continue
        valid = ~np.isnan(shift)
        fit = np.polyfit(t[valid], shift[valid], 2)
        residual = shift[valid] - np.polyval(fit, t[valid])
        if float(np.std(residual)) > 0.3 * band:
            continue           # noisy: the border was not followed reliably
        bulge = float(np.polyval(fit, 0.5)
                      - 0.5 * (np.polyval(fit, 0.0) + np.polyval(fit, 1.0)))
        if abs(bulge) > max_curvature * length:
            continue           # implausible for a page
        if abs(bulge) < CurvedQuad.STRAIGHT_LIMIT * length:
            continue           # straight enough; keep the straight edge
        middle = (start + end) / 2.0 + normal * bulge
        controls[index] = control_from_midpoint(start, end, middle)

    return CurvedQuad(corners=curved.corners, controls=controls)


def _ink_mask(image):
    """Rough binary mask of the writing on an already rectified page."""
    gray = image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    longest = max(gray.shape[:2])
    kernel = max(3, int(longest * 0.012) | 1)
    background = cv2.medianBlur(cv2.dilate(gray, np.ones((kernel, kernel), np.uint8)),
                                max(3, int(longest * 0.02) | 1))
    flattened = cv2.divide(gray, background, scale=255)
    block = max(15, int(longest * 0.025) | 1)
    return cv2.adaptiveThreshold(flattened, 1, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                 cv2.THRESH_BINARY_INV, block, 10)


def _band_peaks(column_sums, minimum):
    """Row positions of the text lines in one vertical band."""
    smooth = cv2.GaussianBlur(column_sums.astype(np.float32).reshape(-1, 1),
                              (1, 9), 0).ravel()
    peaks = []
    row = 1
    while row < len(smooth) - 1:
        if smooth[row] >= minimum and smooth[row] >= smooth[row - 1] \
                and smooth[row] > smooth[row + 1]:
            start = row
            while row < len(smooth) - 1 and smooth[row + 1] == smooth[start]:
                row += 1
            peaks.append((start + row) / 2.0)
        row += 1
    return peaks


def text_line_field(image, bands=14, min_lines=5, max_shift_ratio=0.08):
    """Vertical displacement that makes the text lines of a page straight.

    The page is split into vertical bands; the text lines show up as peaks of
    the ink profile of each band, and following a peak across the bands traces
    one line.  How far each line wanders from its own average is exactly the
    residual bend, and interpolating that between the lines gives a
    displacement for every pixel.

    Returns ``None`` when the page does not hold enough text to measure.
    """
    ink = _ink_mask(image)
    height, width = ink.shape[:2]
    if bands < 4 or width < bands * 8:
        return None
    edges = np.linspace(0, width, bands + 1).astype(int)
    centres = (edges[:-1] + edges[1:]) / 2.0

    profiles = [ink[:, edges[index]:edges[index + 1]].sum(axis=1)
                for index in range(bands)]
    strength = float(np.median([profile.max() for profile in profiles]))
    if strength < 3:
        return None
    peaks = [_band_peaks(profile, 0.35 * strength) for profile in profiles]

    middle = bands // 2
    if len(peaks[middle]) < min_lines:
        return None

    tolerance = max(4.0, height * 0.02)
    lines = []
    for seed in peaks[middle]:
        positions = {middle: seed}
        for direction in (-1, 1):
            current = seed
            index = middle + direction
            while 0 <= index < bands:
                if not peaks[index]:
                    break
                nearest = min(peaks[index], key=lambda value: abs(value - current))
                if abs(nearest - current) > tolerance:
                    break
                positions[index] = nearest
                current = nearest
                index += direction
        if len(positions) >= int(bands * 0.7):
            lines.append(positions)

    if len(lines) < min_lines:
        return None

    # how far each line wanders from its own mean, per band
    samples = []
    for positions in lines:
        indexes = sorted(positions)
        values = np.array([positions[index] for index in indexes])
        shift = values - values.mean()
        full = np.interp(np.arange(bands), indexes, shift)
        samples.append((values.mean(), full))
    samples.sort(key=lambda item: item[0])

    line_y = np.array([item[0] for item in samples])
    shifts = np.array([item[1] for item in samples])      # (lines, bands)
    limit = max_shift_ratio * height
    if np.max(np.abs(shifts)) > limit:
        return None                                       # implausible: not text lines
    if np.max(np.abs(shifts)) < 1.5:
        # sub pixel wander of the detected peaks, not a bend worth resampling for
        return np.zeros((height, width), np.float32)

    # interpolate across the page: along x between band centres, along y
    # between the lines
    columns = np.arange(width)
    per_line = np.stack([np.interp(columns, centres, shifts[index])
                         for index in range(len(samples))])   # (lines, width)
    rows = np.arange(height)
    field = np.empty((height, width), np.float32)
    for column in range(width):
        field[:, column] = np.interp(rows, line_y, per_line[:, column])
    return field


def straighten_text_lines(image, **kwargs):
    """Remove the residual bend of the text lines of a rectified page.

    The boundary based flattening gets the shape of the sheet right, but a
    strongly curled page keeps a little bow in the middle, where there is no
    border to follow.  The text itself is the only evidence there, so it is
    what this uses.  Pages without enough text are returned unchanged.
    """
    field = text_line_field(image, **kwargs)
    if field is None or not np.any(field):
        return image
    height, width = image.shape[:2]
    map_x, map_y = np.meshgrid(np.arange(width, dtype=np.float32),
                               np.arange(height, dtype=np.float32))
    return cv2.remap(image, map_x, (map_y + field).astype(np.float32),
                     interpolation=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
