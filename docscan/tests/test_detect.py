"""Tests for the page outline detection."""

import unittest

from docscan.tests import HAVE_OPENCV, requires_opencv

if HAVE_OPENCV:
    import numpy as np

    import cv2

    from docscan.detect import (detect_candidates, draw_outline, find_document,
                                full_frame_quad, touches_border)
    from docscan.tests.synthetic import BACKGROUNDS, photograph, render_background
    from docscan.transform import order_corners

#: the detector works on a downscaled copy, so a few pixels of error are expected
CORNER_TOLERANCE = 8.0


@requires_opencv
class TestFindDocument(unittest.TestCase):

    def _check(self, **kwargs):
        image, quad = photograph(**kwargs)
        detection = find_document(image)
        self.assertIsNotNone(detection, "no page found for {}".format(kwargs))
        error = float(np.max(np.linalg.norm(detection.quad - order_corners(quad), axis=1)))
        self.assertLess(error, CORNER_TOLERANCE,
                        "corners off by {:.1f} px for {}".format(error, kwargs))
        return detection

    def test_finds_the_page_on_every_background(self):
        for background in BACKGROUNDS:
            with self.subTest(background=background):
                self._check(background=background)

    def test_finds_the_page_from_different_angles(self):
        for rotation in ((0.05, 0.05, 0.0), (0.6, -0.5, 0.2), (-0.4, 0.3, -0.3)):
            with self.subTest(rotation=rotation):
                self._check(rotation=rotation, distance=1.9)

    def test_survives_uneven_lighting_and_sensor_noise(self):
        self._check(lighting=0.5, noise=4.0)

    def test_works_for_a_landscape_page(self):
        detection = self._check(ratio=297.0 / 210.0)
        self.assertGreater(detection.area_ratio, 0.1)

    def test_nothing_is_detected_on_an_empty_background(self):
        image = render_background("wood", (720, 1280))
        self.assertIsNone(find_document(image))

    def test_fallback_returns_the_full_frame(self):
        image = render_background("wood", (720, 1280))
        detection = find_document(image, fallback=True)
        self.assertIsNotNone(detection)
        self.assertEqual(detection.method, "full-frame")
        np.testing.assert_allclose(detection.quad, full_frame_quad(image.shape))

    def test_the_page_wins_against_a_crisp_inner_block(self):
        # a dark, sharply printed photo on the page must not be mistaken for the page
        image, quad = photograph(background="wood")
        ordered = order_corners(quad)
        centre = ordered.mean(axis=0)
        inner = (centre + (ordered - centre) * 0.45).astype(np.int32)
        cv2.fillPoly(image, [inner], (20, 20, 20))
        detection = find_document(image)
        self.assertIsNotNone(detection)
        error = float(np.max(np.linalg.norm(detection.quad - ordered, axis=1)))
        self.assertLess(error, CORNER_TOLERANCE)

    def test_candidates_are_sorted_and_deduplicated(self):
        image, _ = photograph()
        candidates = detect_candidates(image)
        self.assertTrue(candidates)
        scores = [candidate.score for candidate in candidates]
        self.assertEqual(scores, sorted(scores, reverse=True))
        for index, candidate in enumerate(candidates):
            for other in candidates[index + 1:]:
                distance = float(np.max(np.linalg.norm(candidate.quad - other.quad, axis=1)))
                self.assertGreater(distance, 1.0)

    def test_minimum_area_filters_small_outlines(self):
        image, _ = photograph()
        self.assertIsNotNone(find_document(image, min_area_ratio=0.05))
        self.assertIsNone(find_document(image, min_area_ratio=0.95))


@requires_opencv
class TestBorderHelpers(unittest.TestCase):

    def test_detects_an_outline_at_the_frame_edge(self):
        shape = (720, 1280)
        self.assertTrue(touches_border(full_frame_quad(shape), shape))
        self.assertFalse(touches_border([[100, 100], [600, 100], [600, 500], [100, 500]],
                                        shape))

    def test_full_frame_quad_covers_the_image(self):
        quad = full_frame_quad((10, 20))
        np.testing.assert_allclose(quad, [[0, 0], [19, 0], [19, 9], [0, 9]])


@requires_opencv
class TestDrawOutline(unittest.TestCase):

    def test_draws_without_touching_the_input(self):
        image, quad = photograph()
        original = image.copy()
        preview = draw_outline(image, quad, label=True)
        self.assertEqual(preview.shape, image.shape)
        np.testing.assert_array_equal(image, original)
        self.assertTrue(np.any(preview != original))

    def test_missing_outline_returns_a_copy(self):
        image, _ = photograph()
        preview = draw_outline(image, None)
        np.testing.assert_array_equal(preview, image)
