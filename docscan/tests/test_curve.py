"""Tests for the curved page outline and the flattening."""

import unittest

from docscan.tests import HAVE_OPENCV, requires_opencv

if HAVE_OPENCV:
    import numpy as np

    import cv2

    from docscan.curve import (CurvedQuad, bezier_point, camera_focal, control_from_midpoint,
                               coons_maps, flatten, flatten_size, midpoint_from_control,
                               refine_edges, straighten_text_lines, text_line_field)
    from docscan.detect import find_document
    from docscan.scanner import ScanOptions, scan_image
    from docscan.tests.synthetic import (flatness, photograph, render_curved_photo,
                                         render_page)
    from docscan.transform import four_point_transform, order_corners

RECTANGLE = [[0, 0], [200, 0], [200, 100], [0, 100]]


def ruled_page(height=3508, width=2516, spacing=60, count=8, top=0.06, ragged=False, seed=0):
    """A page of ruled lines near the top, optionally of differing lengths.

    The shape of a table or of the last lines of a paragraph, at the size a
    phone's own camera produces: it is the ragged ends that used to confuse
    the line tracking.
    """
    generator = np.random.default_rng(seed)
    page = np.full((height, width, 3), 250, np.uint8)
    for index in range(count):
        row = int(height * top) + index * spacing
        end = width - 120
        if ragged:
            end -= int(generator.integers(0, width * 0.55))
        cv2.line(page, (120, row), (end, row), (40, 40, 40), 4)
    return page


def text_line_wobble(image, columns=24, window=12):
    """Average vertical spread of each text line across the page.

    Each line is picked up in the middle of the page and then followed column
    by column, so a strongly bowed line is measured rather than lost.  A
    straight line scores about 0 px; a page that is still bent shows the bow.
    """
    gray = image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    ink = (gray < 128).astype(np.uint8)
    height, width = ink.shape
    samples = np.linspace(int(width * 0.12), int(width * 0.60), columns).astype(int)
    profile = ink[:, samples]
    middle = profile.shape[1] // 2

    centres = []
    row = 0
    while row < height:
        if profile[row, middle]:
            start = row
            while row < height and profile[row, middle]:
                row += 1
            centres.append((start + row - 1) / 2)
        row += 1

    def follow(centre, order):
        positions = [centre]
        current = centre
        for column in order:
            low = max(0, int(round(current)) - window)
            found = np.where(profile[low:int(round(current)) + window + 1, column] > 0)[0]
            if found.size == 0:
                return None
            current = found.mean() + low
            positions.append(current)
        return positions

    spreads = []
    for centre in centres:
        left = follow(centre, range(middle - 1, -1, -1))
        right = follow(centre, range(middle + 1, profile.shape[1]))
        if left is None or right is None:
            continue
        positions = left + right
        spreads.append(max(positions) - min(positions))
    if not spreads:
        return None, 0
    return float(np.mean(spreads)), len(spreads)


@requires_opencv
class TestBezierHelpers(unittest.TestCase):

    def test_endpoints_and_midpoint(self):
        start, control, end = [0, 0], [10, 10], [20, 0]
        np.testing.assert_allclose(bezier_point(start, control, end, 0.0), start)
        np.testing.assert_allclose(bezier_point(start, control, end, 1.0), end)
        np.testing.assert_allclose(bezier_point(start, control, end, 0.5), [10, 5])

    def test_control_and_midpoint_are_inverse(self):
        start, end, middle = np.array([0, 0]), np.array([20, 0]), np.array([10, 7])
        control = control_from_midpoint(start, end, middle)
        np.testing.assert_allclose(midpoint_from_control(start, control, end), middle)

    def test_straight_edge_control_is_the_midpoint(self):
        start, end = np.array([0.0, 0.0]), np.array([20.0, 10.0])
        np.testing.assert_allclose(control_from_midpoint(start, end, (start + end) / 2),
                                   (start + end) / 2)

    def test_sampling_accepts_arrays(self):
        points = bezier_point([0, 0], [10, 10], [20, 0], np.linspace(0, 1, 5))
        self.assertEqual(points.shape, (5, 2))


@requires_opencv
class TestCurvedQuad(unittest.TestCase):

    def test_from_quad_is_straight(self):
        curved = CurvedQuad.from_quad(RECTANGLE)
        self.assertTrue(curved.is_straight)
        self.assertAlmostEqual(curved.curvature(), 0.0)
        np.testing.assert_allclose(curved.midpoints,
                                   [[100, 0], [200, 50], [100, 100], [0, 50]])

    def test_from_midpoints_round_trip(self):
        midpoints = [[100, -20], [200, 50], [100, 120], [0, 50]]
        curved = CurvedQuad.from_midpoints(RECTANGLE, midpoints)
        np.testing.assert_allclose(curved.midpoints, midpoints)
        self.assertFalse(curved.is_straight)

    def test_curvature_is_relative_to_the_edge(self):
        curved = CurvedQuad.from_midpoints(RECTANGLE, [[100, -20], [200, 50],
                                                       [100, 100], [0, 50]])
        self.assertAlmostEqual(curved.curvature(), 20.0 / 200.0, places=6)

    def test_edge_length_grows_with_the_bulge(self):
        straight = CurvedQuad.from_quad(RECTANGLE)
        bent = CurvedQuad.from_midpoints(RECTANGLE, [[100, -40], [200, 50],
                                                     [100, 100], [0, 50]])
        self.assertAlmostEqual(straight.edge_length(0), 200.0, places=3)
        self.assertGreater(bent.edge_length(0), 215.0)


@requires_opencv
class TestFlatten(unittest.TestCase):

    def test_a_straight_outline_matches_the_perspective_transform(self):
        image, quad = photograph(background="wood", rotation=(0.3, 0.35, 0.1))
        curved = CurvedQuad.from_quad(quad)
        size = (320, 450)
        expected = four_point_transform(image, quad, size=size)
        actual = flatten(image, curved, size=size)
        difference = np.mean(np.abs(actual.astype(float) - expected.astype(float)))
        self.assertLess(difference, 1.5)

    def test_size_grows_with_curvature(self):
        straight = CurvedQuad.from_quad(RECTANGLE)
        bent = CurvedQuad.from_midpoints(RECTANGLE, [[100, -40], [200, 50],
                                                     [100, 140], [0, 50]])
        flat_width, _ = flatten_size(straight, (400, 400), aspect="edges")
        bent_width, _ = flatten_size(bent, (400, 400), aspect="edges")
        self.assertGreater(bent_width, flat_width * 1.05)

    def test_paper_size_overrides_the_measured_ratio(self):
        curved = CurvedQuad.from_quad(RECTANGLE)
        width, height = flatten_size(curved, (400, 400), aspect="a4")
        self.assertAlmostEqual(width / height, 297.0 / 210.0, places=2)

    def test_flattening_straightens_the_text_of_a_curled_page(self):
        image, _ = render_curved_photo(arc=0.9)
        detection = find_document(image)
        self.assertIsNotNone(detection)
        curved = refine_edges(image, detection.quad)
        bent = four_point_transform(image, detection.quad, aspect="auto")
        straightened = flatten(image, curved, aspect="auto")
        before, lines_before = text_line_wobble(bent)
        after, lines_after = text_line_wobble(straightened)
        self.assertGreater(lines_before, 15)
        self.assertGreater(lines_after, 15)
        self.assertGreater(before, 4.0, "the test page is not actually bent")
        # following the border alone takes out roughly half of the bow; what is
        # left in the middle of the page is the text line step's job
        self.assertLess(
            after, before * 0.7,
            "flattening left {:.1f} px of wobble (was {:.1f})".format(after, before))

    def test_a_curled_page_comes_out_as_flat_as_a_scan(self):
        image, _, truth = render_curved_photo(arc=0.9, with_truth=True)
        curved = refine_edges(image, find_document(image).quad)
        width, height = flatten_size(curved, image.shape, aspect="auto")
        centre = (image.shape[1] / 2.0, image.shape[0] / 2.0)
        focal = camera_focal(curved, image.shape)
        even = flatness(*coons_maps(curved, width, height), truth)
        unrolled = flatness(*coons_maps(curved, width, height, focal=focal, centre=centre),
                            truth)
        # sampling the rectified rectangle evenly squeezes the text where the
        # paper turns away from the camera; following the sheet does not
        self.assertLess(unrolled["across"], 0.6,
                        "{:.2f} % of the page width left".format(unrolled["across"]))
        self.assertLess(unrolled["across"], even["across"] * 0.5,
                        "{:.2f} % against {:.2f} % with even spacing".format(
                            unrolled["across"], even["across"]))
        self.assertLess(unrolled["down"], 0.3)

    def test_a_barely_curled_page_is_sampled_evenly(self):
        # the spacing correction is measured against the straight outline, so
        # a page that is not curled must come out exactly as before
        image, _, truth = render_curved_photo(arc=0.05, with_truth=True)
        curved = refine_edges(image, find_document(image).quad)
        width, height = flatten_size(curved, image.shape, aspect="auto")
        centre = (image.shape[1] / 2.0, image.shape[0] / 2.0)
        even = flatness(*coons_maps(curved, width, height), truth)
        unrolled = flatness(*coons_maps(curved, width, height,
                                        focal=camera_focal(curved, image.shape),
                                        centre=centre), truth)
        for axis in ("across", "down"):
            self.assertLess(unrolled[axis], max(0.1, even[axis] * 1.2),
                            "{} went from {:.2f} to {:.2f} %".format(
                                axis, even[axis], unrolled[axis]))

    def test_the_stronger_the_curl_the_more_it_helps(self):
        gains = []
        for arc in (0.4, 0.9, 1.3):
            image, _, truth = render_curved_photo(arc=arc, with_truth=True)
            curved = refine_edges(image, find_document(image).quad)
            size = flatten_size(curved, image.shape, aspect="auto")
            centre = (image.shape[1] / 2.0, image.shape[0] / 2.0)
            result = flatness(*coons_maps(curved, *size,
                                          focal=camera_focal(curved, image.shape),
                                          centre=centre), truth)
            gains.append(result["worst"])
        # even the hardest curl stays within half a per cent of the page width
        self.assertLess(max(gains), 0.7, "worst residual warp {}".format(
            [round(value, 2) for value in gains]))

    def test_the_whole_pipeline_gets_the_text_nearly_straight(self):
        image, _ = render_curved_photo(arc=0.9)
        bent = scan_image(image, ScanOptions(mode="none", flatten=False))
        straightened = scan_image(image, ScanOptions(mode="none", flatten=True))
        before, _ = text_line_wobble(bent.image)
        after, _ = text_line_wobble(straightened.image)
        self.assertGreater(before, 10.0)
        self.assertLess(after, 0.25 * before,
                        "{:.1f} px of wobble left (was {:.1f})".format(after, before))


@requires_opencv
class TestRefineEdges(unittest.TestCase):

    def test_a_flat_page_keeps_straight_edges(self):
        image, quad = photograph(background="wood", lighting=0.4)
        curved = refine_edges(image, find_document(image).quad)
        self.assertTrue(curved.is_straight,
                        "curvature {:.4f} on a flat page".format(curved.curvature()))

    def test_a_curled_page_gets_a_bent_edge(self):
        image, _ = render_curved_photo(arc=0.9)
        curved = refine_edges(image, find_document(image).quad)
        self.assertFalse(curved.is_straight)
        self.assertGreater(curved.curvature(), 0.02)

    def test_the_corners_move_onto_the_real_ones(self):
        # the detector can only fit a straight quad, and the extreme points of
        # a curled sheet's silhouette are not its corners: here two of them are
        # out by 20 and 60 px, which no later step could recover from
        image, truth = render_curved_photo(arc=0.9)
        quad = order_corners(find_document(image).quad)
        curved = refine_edges(image, quad)
        truth = order_corners(truth)
        before = np.max(np.linalg.norm(quad - truth, axis=1))
        after = np.max(np.linalg.norm(curved.corners - truth, axis=1))
        self.assertGreater(before, 20.0, "the detected quad is already right")
        self.assertLess(after, 5.0, "corners are still {:.1f} px out".format(after))

    def test_a_flat_page_keeps_its_corners(self):
        image, _ = photograph(background="wood", lighting=0.4)
        quad = order_corners(find_document(image).quad)
        curved = refine_edges(image, quad)
        moved = np.max(np.linalg.norm(curved.corners - quad, axis=1))
        self.assertLess(moved, 8.0, "corners moved {:.1f} px on a flat page".format(moved))

    def test_only_the_genuinely_curved_edge_is_bent(self):
        # the sheet is wrapped around a vertical cylinder, so its sides stay
        # straight lines while the bottom border bows outwards.  Following the
        # strongest gradient instead of the page border would bend the sides
        # too, and pull the bottom the wrong way - into the page.
        image, _ = render_curved_photo(arc=0.9)
        curved = refine_edges(image, find_document(image).quad)
        top, right, bottom, left = (curved.edge_curvature(index) for index in range(4))
        self.assertLess(abs(left), 0.015, "the left side should stay straight")
        self.assertLess(abs(right), 0.015, "the right side should stay straight")
        self.assertLess(abs(top), 0.02, "the top should stay nearly straight")
        self.assertGreater(bottom, 0.03, "the bottom border bows outwards")

    def test_the_bend_grows_with_the_curl(self):
        measured = []
        for arc in (0.001, 0.3, 0.6, 0.9):
            image, _ = render_curved_photo(arc=arc)
            curved = refine_edges(image, find_document(image).quad)
            measured.append(curved.edge_curvature(2))
        self.assertEqual(measured, sorted(measured))
        self.assertAlmostEqual(measured[0], 0.0, places=6)
        self.assertGreater(measured[-1], 0.04)


@requires_opencv
class TestTextLineStraightening(unittest.TestCase):

    def test_a_blank_page_is_left_alone(self):
        blank = np.full((400, 300, 3), 245, np.uint8)
        self.assertIsNone(text_line_field(blank))
        self.assertIs(straighten_text_lines(blank), blank)

    def test_a_straight_page_needs_no_correction(self):
        page = render_page(width=400, lines=14, seed=2)
        field = text_line_field(page)
        self.assertTrue(field is None or float(np.max(np.abs(field))) < 1e-6)
        self.assertIs(straighten_text_lines(page), page)

    def test_a_bowed_page_is_straightened(self):
        page = render_page(width=520, lines=16, seed=4)
        height, width = page.shape[:2]
        columns = np.arange(width, dtype=np.float32)
        bow = 14.0 * np.sin(np.pi * columns / (width - 1))
        map_x, map_y = np.meshgrid(columns, np.arange(height, dtype=np.float32))
        bent = cv2.remap(page, map_x, (map_y + bow[None, :]).astype(np.float32),
                         cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
        before, lines_before = text_line_wobble(bent)
        self.assertGreater(lines_before, 8)
        self.assertGreater(before, 8.0)
        after, _ = text_line_wobble(straighten_text_lines(bent))
        self.assertLess(after, 0.3 * before,
                        "{:.1f} px left of {:.1f}".format(after, before))

    def test_lines_that_stop_short_do_not_look_like_a_bend(self):
        # a table or a paragraph leaves rules of different lengths.  Where a
        # line stops, the nearest ink in the next band is its neighbour, and
        # following that reports a whole line spacing as a bend - which is how
        # a straight page came out wavy and smeared
        for spacing in (40, 60, 90):
            page = ruled_page(spacing=spacing, ragged=True)
            field = text_line_field(page)
            worst = 0.0 if field is None else float(np.max(np.abs(field)))
            self.assertLess(worst, 1e-6,
                            "a straight page was bent by {:.0f} px "
                            "(lines {} px apart)".format(worst, spacing))
            self.assertIs(straighten_text_lines(page), page)

    def test_a_ragged_page_that_really_bends_is_still_fixed(self):
        # the same page, bowed on purpose: tightening the tracking must not
        # cost the correction it is there for
        page = ruled_page(spacing=60, ragged=True)
        height, width = page.shape[:2]
        columns = np.arange(width, dtype=np.float32)
        bow = 40.0 * np.sin(np.pi * columns / (width - 1))
        map_x, map_y = np.meshgrid(columns, np.arange(height, dtype=np.float32))
        bent = cv2.remap(page, map_x, (map_y + bow[None, :]).astype(np.float32),
                         cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
        field = text_line_field(bent)
        self.assertIsNotNone(field, "the bend was not measured at all")
        measured = float(np.max(np.abs(field)))
        self.assertGreater(measured, 15.0, "only {:.0f} px of 40 measured".format(measured))
        before, _ = text_line_wobble(bent, columns=16)
        after, _ = text_line_wobble(straighten_text_lines(bent), columns=16)
        self.assertLess(after, 0.35 * before,
                        "{:.1f} px left of {:.1f}".format(after, before))

    def test_nonsense_shifts_are_rejected(self):
        # a page of vertical stripes has no text lines to follow
        stripes = np.full((400, 300, 3), 245, np.uint8)
        stripes[:, ::12] = 20
        field = text_line_field(stripes)
        self.assertTrue(field is None or float(np.max(np.abs(field))) < 1e-6)


@requires_opencv
class TestScanWithFlattening(unittest.TestCase):

    def test_pipeline_flattens_by_default(self):
        image, _ = render_curved_photo(arc=0.9)
        result = scan_image(image, ScanOptions(mode="none"))
        self.assertTrue(result.flattened)
        self.assertIsNotNone(result.outline)

    def test_flattening_can_be_switched_off(self):
        image, _ = render_curved_photo(arc=0.9)
        result = scan_image(image, ScanOptions(mode="none", flatten=False))
        self.assertFalse(result.flattened)

    def test_a_flat_photo_is_not_flattened(self):
        image, _ = photograph(background="wood", lighting=0.4)
        result = scan_image(image, ScanOptions(mode="none"))
        self.assertTrue(result.cropped)
        self.assertFalse(result.flattened)

    def test_a_manual_outline_is_used_as_given(self):
        image, _ = photograph(background="wood")
        corners = [[100, 80], [520, 90], [530, 600], [110, 590]]
        outline = CurvedQuad.from_quad(corners)
        result = scan_image(image, ScanOptions(mode="none", flatten=False), outline=outline)
        self.assertTrue(result.cropped)
        self.assertIs(result.outline, outline)
        # the detector must not override what the user picked
        self.assertIsNone(result.detection)

    def test_a_region_inside_the_page_is_not_pulled_to_the_border(self):
        # flattening measures the border around a hand placed region, and a
        # region that is all paper has none - it must come back as drawn
        image, _ = photograph(background="wood")
        corners = [[100, 80], [520, 90], [530, 600], [110, 590]]
        result = scan_image(image, ScanOptions(mode="none"),
                            outline=CurvedQuad.from_quad(corners))
        moved = np.max(np.linalg.norm(result.outline.corners - order_corners(corners), axis=1))
        self.assertLess(moved, 2.0, "corners moved {:.1f} px".format(moved))

    def test_a_hand_placed_region_snaps_onto_the_paper(self):
        image, quad = photograph(background="wood", lighting=0.4)
        truth = order_corners(quad)
        # as a finger would place them: a handful of pixels inside the page
        rough = truth + np.array([[9, 7], [-8, 6], [-7, -9], [8, -8]], dtype=np.float64)
        result = scan_image(image, ScanOptions(mode="none"),
                            outline=CurvedQuad.from_quad(rough))
        before = np.max(np.linalg.norm(rough - truth, axis=1))
        after = np.max(np.linalg.norm(result.outline.corners - truth, axis=1))
        self.assertLess(after, before * 0.6,
                        "{:.1f} px out, was {:.1f}".format(after, before))

    def test_a_manual_curved_outline_is_flattened(self):
        image, _ = photograph(background="wood")
        corners = [[100, 80], [520, 90], [530, 600], [110, 590]]
        midpoints = [[310, 40], [525, 345], [320, 640], [105, 335]]
        outline = CurvedQuad.from_midpoints(corners, midpoints)
        result = scan_image(image, ScanOptions(mode="none"), outline=outline)
        self.assertTrue(result.flattened)

    def test_scan_result_reports_the_pipeline_state(self):
        image, _ = render_curved_photo(arc=1.2)
        result = scan_image(image, ScanOptions(mode="bw"))
        self.assertEqual(result.image.ndim, 2)
        self.assertTrue(result.cropped and result.flattened)
        self.assertGreater(min(result.size), 50)
