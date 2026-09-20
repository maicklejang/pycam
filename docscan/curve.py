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


#: how many points of each edge a measured border profile keeps
PROFILE_SAMPLES = 129


def edge_frame(corners, index):
    """Start, direction and inward normal of one edge of a quad."""
    start = np.asarray(corners[index], dtype=np.float64)
    end = np.asarray(corners[(index + 1) % 4], dtype=np.float64)
    direction = end - start
    length = float(np.linalg.norm(direction))
    if length < 1e-6:
        return start, direction, 0.0, np.zeros(2)
    normal = np.array([-direction[1], direction[0]]) / length
    centre = np.asarray(corners, dtype=np.float64).mean(axis=0)
    if np.dot(centre - (start + end) / 2.0, normal) < 0:
        normal = -normal
    return start, direction, length, normal


@dataclass
class CurvedQuad:
    """Four corners plus one Bezier control point per edge.

    A single quadratic per edge is what a person can actually drag, and it is
    enough for the outline the app draws.  It is *not* enough to flatten a
    strongly curled sheet, so when the border has been measured in the photo
    the samples are kept alongside, in ``profiles``, and the flattening uses
    those instead.  They are offsets from the straight chord along its inward
    normal, so they are only meaningful for these corners: any edit that moves
    a corner drops them.
    """

    corners: np.ndarray          # (4, 2), ordered TL, TR, BR, BL
    controls: np.ndarray         # (4, 2), one per edge in EDGE_NAMES order
    profiles: np.ndarray = None  # (4, PROFILE_SAMPLES) or None

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

    def border(self, index, t):
        """The page border along edge ``index`` - measured if it was measured.

        ``edge`` is the Bezier the UI draws; this is what the flattening
        follows, which is the same curve unless a profile was measured.
        """
        if self.profiles is None:
            return self.edge(index, t)
        start, direction, length, normal = edge_frame(self.corners, index)
        if length < 1e-6:
            return self.edge(index, t)
        t = np.asarray(t, dtype=np.float64)
        profile = np.asarray(self.profiles[index], dtype=np.float64)
        offset = np.interp(t, np.linspace(0.0, 1.0, len(profile)), profile)
        return start + direction * t[..., None] + normal * offset[..., None]

    def without_profiles(self):
        """The same outline as the plain Bezier one - what an edit leaves."""
        return CurvedQuad(corners=self.corners.copy(), controls=self.controls.copy())

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

    top = to_rect(curved.border(0, t))          # TL -> TR
    right = to_rect(curved.border(1, t))        # TR -> BR
    bottom = to_rect(curved.border(2, t))[::-1]  # BR -> BL, reversed to BL -> BR
    left = to_rect(curved.border(3, t))[::-1]   # BL -> TL, reversed to TL -> BL

    xs = np.linspace(0.0, width - 1.0, width)
    ys = np.linspace(0.0, height - 1.0, height)
    curves = {
        "top": np.stack([xs, _monotonic_interp(xs, top[:, 0], top[:, 1])], axis=-1),
        "bottom": np.stack([xs, _monotonic_interp(xs, bottom[:, 0], bottom[:, 1])], axis=-1),
        "left": np.stack([_monotonic_interp(ys, left[:, 1], left[:, 0]), ys], axis=-1),
        "right": np.stack([_monotonic_interp(ys, right[:, 1], right[:, 0]), ys], axis=-1),
    }
    return curves, matrix


def _even_arc_positions(first, second, focal, centre, count):
    """Positions along an axis that sample the real sheet evenly.

    Where the paper turns away from the camera it is foreshortened, and
    sampling the rectified rectangle evenly squeezes the text there - the
    difference between a photo that has been straightened and a page that has
    been scanned.  The two ends of each ruling (a line across the sheet, given
    here as ``first`` and ``second`` in photo pixels) say how much: the
    ruling's image length is its distance, its position is its direction, and
    together they give the sheet's cross-section up to one scale factor.
    Sampling that at equal arc length unrolls the sheet.
    """
    span = np.linalg.norm(second - first, axis=1)
    if not np.all(np.isfinite(span)) or float(np.min(span)) < 1e-6:
        return None
    middle = (first + second) / 2.0
    ray = np.stack([(middle[:, 0] - centre[0]) / focal,
                    (middle[:, 1] - centre[1]) / focal,
                    np.ones(len(middle))], axis=-1)
    section = ray / span[:, None]
    walked = np.concatenate([[0.0], np.cumsum(
        np.linalg.norm(np.diff(section, axis=0), axis=1))])
    if walked[-1] <= 0.0:
        return None
    return walked / walked[-1]


def _arc_positions(curved_ends, straight_ends, focal, centre, count):
    """Sampling positions that undo the curl, and nothing else.

    A ruling is also foreshortened by its own slant, which the perspective
    transform has already dealt with, so the walk is compared against the same
    walk over the straight outline instead of being used on its own.  On a
    flat page the two are identical and the spacing stays even, to the pixel.
    """
    walked = _even_arc_positions(*curved_ends, focal, centre, count)
    reference = _even_arc_positions(*straight_ends, focal, centre, count)
    if walked is None or reference is None:
        return None
    # column j should cover as much paper as the flat model says it does
    index = np.arange(count, dtype=np.float64)
    return np.interp(reference, walked, index)


def coons_maps(curved, width, height, focal=None, centre=None):
    """Sampling maps (in photo coordinates) of the flattened page.

    The Coons patch is built in rectified space, where the four borders are
    nearly straight, and the result is mapped back into the photo with the
    inverse of the perspective transform - one interpolation, not two.  With a
    focal length the rows and columns are also spaced by the arc length of the
    sheet rather than evenly, which is what unrolls a curl.
    """
    curves, matrix = boundary_curves(curved, width, height)
    inverse = np.linalg.inv(matrix)
    top_y = curves["top"][:, 1]
    bottom_y = curves["bottom"][:, 1]
    left_x = curves["left"][:, 0]
    right_x = curves["right"][:, 0]

    xs = np.linspace(0.0, width - 1.0, width)
    ys = np.linspace(0.0, height - 1.0, height)
    columns, rows = xs.copy(), ys.copy()
    if focal:
        def to_photo(points):
            return cv2.perspectiveTransform(
                np.ascontiguousarray(points).reshape(-1, 1, 2), inverse).reshape(-1, 2)

        flat_x = np.zeros(width)
        flat_y = np.zeros(height)
        across = _arc_positions(
            (to_photo(np.stack([xs, top_y], axis=-1)),
             to_photo(np.stack([xs, bottom_y], axis=-1))),
            (to_photo(np.stack([xs, flat_x], axis=-1)),
             to_photo(np.stack([xs, flat_x + height - 1.0], axis=-1))),
            focal, centre, width)
        down = _arc_positions(
            (to_photo(np.stack([left_x, ys], axis=-1)),
             to_photo(np.stack([right_x, ys], axis=-1))),
            (to_photo(np.stack([flat_y, ys], axis=-1)),
             to_photo(np.stack([flat_y + width - 1.0, ys], axis=-1))),
            focal, centre, height)
        if across is not None:
            columns = across
            top_y = np.interp(columns, xs, top_y)
            bottom_y = np.interp(columns, xs, bottom_y)
        if down is not None:
            rows = down
            left_x = np.interp(rows, ys, left_x)
            right_x = np.interp(rows, ys, right_x)

    u = np.linspace(0.0, 1.0, width)[None, :]
    v = np.linspace(0.0, 1.0, height)[:, None]
    surface_x = (columns[None, :] + (1.0 - u) * left_x[:, None]
                 + u * right_x[:, None] - u * (width - 1.0))
    surface_y = (rows[:, None] + (1.0 - v) * top_y[None, :]
                 + v * bottom_y[None, :] - v * (height - 1.0))

    photo = cv2.perspectiveTransform(
        np.stack([surface_x, surface_y], axis=-1).reshape(-1, 1, 2), inverse)
    photo = photo.reshape(height, width, 2)
    return (np.ascontiguousarray(photo[:, :, 0], dtype=np.float32),
            np.ascontiguousarray(photo[:, :, 1], dtype=np.float32))


def camera_focal(curved, image_shape):
    """Focal length in pixels to unroll a sheet photographed like this.

    The perspective of the outline gives it when there is any; a shot taken
    straight on carries none, and then the usual field of view of a phone
    camera is a better guess than pretending the lens is flat.
    """
    from docscan.transform import projective_focal

    longest = float(max(image_shape[:2]))
    focal = projective_focal(curved.corners, image_shape)
    if focal is None or not (0.3 * longest <= focal <= 4.0 * longest):
        return 0.8 * longest
    return focal


def flatten(image, curved, size=None, aspect="auto", max_side=None, margin=0.0):
    """Map a curved page outline onto a straight rectangle."""
    if margin:
        from docscan.transform import expand_quad
        curved = CurvedQuad.from_midpoints(expand_quad(curved.corners, margin),
                                           expand_quad(curved.midpoints, margin))
    if size is None:
        size = flatten_size(curved, image.shape, aspect=aspect, max_side=max_side)
    width, height = size
    centre = (image.shape[1] / 2.0, image.shape[0] / 2.0)
    map_x, map_y = coons_maps(curved, width, height,
                              focal=camera_focal(curved, image.shape), centre=centre)
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


def _measure_profile(gray, corners, index, levels, band, samples, offsets, hold, degree):
    """Offsets of the real border from one chord, as a polynomial in t.

    The edge is sampled at a number of positions and, at each of them, the
    brightness is read along the edge normal from outside the page inwards.
    The border is where the profile changes from background to paper and stays
    there - not simply where the gradient is strongest, because the first line
    of text is a stronger edge than the rim of the sheet, and a textured
    surface (wood, cloth) is full of strong edges of its own.
    """
    page_level, background_level = levels
    start, direction, length, normal = edge_frame(corners, index)
    if length < 1e-6:
        return None
    # skip the corners: the border bends there and the fit would chase it
    t = np.linspace(0.10, 0.90, samples)
    steps = np.linspace(-band, band, offsets)
    base = start + direction * t[:, None]
    candidates = base[:, None, :] + normal[None, None, :] * steps[None, :, None]
    values = _sample(gray, candidates, default=background_level)
    page_like = (np.abs(values - page_level)
                 < np.abs(values - background_level)).astype(np.int8)

    # the border is the first offset from which the profile stays on the page
    # for at least `hold` steps
    window = np.ones(hold, dtype=np.int8)
    sustained = np.apply_along_axis(
        lambda row: np.convolve(row, window, mode="valid") == hold, 1, page_like)
    has_border = sustained.any(axis=1)
    shift = np.where(has_border, steps[np.argmax(sustained, axis=1)], np.nan)
    if np.count_nonzero(has_border) < max(4, samples // 2):
        return None
    valid = ~np.isnan(shift)
    fit = np.polyfit(t[valid], shift[valid], degree)
    residual = shift[valid] - np.polyval(fit, t[valid])
    if float(np.std(residual)) > 0.3 * band:
        return None            # noisy: the border was not followed reliably
    return fit


def _profile_points(corners, index, fit, t):
    """Points of a fitted border, in photo coordinates."""
    start, direction, length, normal = edge_frame(corners, index)
    t = np.asarray(t, dtype=np.float64)
    return (start + direction * t[:, None]
            + normal * np.polyval(fit, t)[:, None])


def _meeting_point(corners, index, fits, reach=0.35, count=257):
    """Where the end of one fitted border crosses the start of the next.

    A detector can only fit a straight quad, and the extreme points of a
    curled sheet's silhouette are not its corners - at a strong curl they miss
    by tens of pixels, and every later step is anchored to them.  The borders
    are measured away from the corners, where they behave, so extending them
    until they cross puts the corner back where the paper actually ends.
    """
    following = (index + 1) % 4
    first = _profile_points(corners, index, fits[index],
                            np.linspace(1.0 - reach, 1.0 + reach, count))
    second = _profile_points(corners, following, fits[following],
                             np.linspace(-reach, reach, count))
    distance = np.linalg.norm(first[:, None, :] - second[None, :, :], axis=-1)
    a, b = np.unravel_index(np.argmin(distance), distance.shape)
    return (first[a] + second[b]) / 2.0, float(distance[a, b])


def refine_edges(image, quad, search_ratio=0.03, samples=41, offsets=61,
                 max_curvature=0.25, hold=4, rounds=2, degree=2):
    """Follow the real page border and return a :class:`CurvedQuad`.

    Each edge is measured in the photo (see :func:`_measure_profile`), the
    corners are moved to where those borders meet, and the measurement is
    repeated from there.  The result carries both the samples, which the
    flattening follows, and one Bezier per edge, which is what the app draws
    and what people drag.  Edges that stay close to their straight chord are
    left straight, so a flat page is unaffected.
    """
    curved = CurvedQuad.from_quad(quad)
    diagonal = float(np.hypot(*image.shape[:2]))
    band = max(3.0, search_ratio * diagonal)
    gray, page_level, background_level = _levels(image, curved.corners, band)
    if page_level is None or abs(page_level - background_level) < 12:
        return curved          # not enough contrast to tell page from background
    levels = (page_level, background_level)

    corners = curved.corners
    fits = None
    for round_index in range(max(1, rounds)):
        measured = [_measure_profile(gray, corners, index, levels, band,
                                     samples, offsets, hold, degree)
                    for index in range(4)]
        if any(fit is None for fit in measured):
            break
        fits = measured
        if round_index + 1 >= rounds:
            break
        moved = corners.copy()
        for index in range(4):
            point, gap = _meeting_point(corners, index, fits)
            if gap < 0.02 * diagonal:
                moved[(index + 1) % 4] = point
        travelled = float(np.max(np.linalg.norm(moved - corners, axis=1)))
        corners = moved
        if travelled < 0.5:
            break
    if fits is None:
        return curved

    t = np.linspace(0.0, 1.0, PROFILE_SAMPLES)
    profiles = np.zeros((4, PROFILE_SAMPLES))
    controls = CurvedQuad.from_quad(corners).controls.copy()
    for index in range(4):
        start, direction, length, normal = edge_frame(corners, index)
        if length < 1e-6:
            continue
        offset = np.polyval(fits[index], t)
        # the ends belong to the corners, which the borders already agreed on
        offset -= (1.0 - t) * offset[0] + t * offset[-1]
        bulge = float(offset[len(offset) // 2])
        if abs(bulge) > max_curvature * length:
            continue           # implausible for a page
        profiles[index] = offset
        if abs(bulge) < CurvedQuad.STRAIGHT_LIMIT * length:
            continue           # straight enough; keep the straight edge
        middle = (start + direction / 2.0) + normal * bulge
        controls[index] = control_from_midpoint(start, start + direction, middle)

    if not np.any(profiles):
        return CurvedQuad(corners=corners, controls=controls)
    return CurvedQuad(corners=corners, controls=controls, profiles=profiles)


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


#: peaks that wander less than this are noise, not a bend (pixels)
NO_BEND = 3.0


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
    if np.max(np.abs(shifts)) < NO_BEND:
        # wander of the detected peaks, not a bend worth resampling for: the
        # border based flattening leaves this much on a page it got right
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
