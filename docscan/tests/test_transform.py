"""Tests for the geometry helpers of docscan."""

import unittest

from docscan.tests import HAVE_OPENCV, requires_opencv

if HAVE_OPENCV:
    import numpy as np

    from docscan.tests.synthetic import project_quad
    from docscan.transform import (edge_lengths, expand_quad, four_point_transform,
                                   order_corners, output_size, projective_aspect_ratio,
                                   quad_area, quad_is_sane, rotate_image,
                                   target_aspect_ratio)

A4_RATIO = 210.0 / 297.0


@requires_opencv
class TestCornerOrdering(unittest.TestCase):

    def test_orders_axis_aligned_rectangle(self):
        corners = [[10, 20], [110, 20], [110, 220], [10, 220]]
        ordered = order_corners(corners)
        np.testing.assert_allclose(ordered, np.array(corners, dtype=float))

    def test_order_is_independent_of_the_input_order(self):
        corners = np.array([[10, 20], [110, 20], [110, 220], [10, 220]], dtype=float)
        reference = order_corners(corners)
        for shift in range(4):
            rolled = np.roll(corners, shift, axis=0)
            np.testing.assert_allclose(order_corners(rolled), reference)
            np.testing.assert_allclose(order_corners(rolled[::-1]), reference)

    def test_rejects_wrong_number_of_points(self):
        with self.assertRaises(ValueError):
            order_corners([[0, 0], [1, 0], [1, 1]])


@requires_opencv
class TestQuadHelpers(unittest.TestCase):

    def test_area_of_a_rectangle(self):
        self.assertAlmostEqual(quad_area([[0, 0], [100, 0], [100, 50], [0, 50]]), 5000.0)

    def test_sane_quads_are_accepted(self):
        self.assertTrue(quad_is_sane([[0, 0], [100, 0], [100, 50], [0, 50]]))

    def test_degenerate_and_concave_quads_are_rejected(self):
        # a very sharp corner
        self.assertFalse(quad_is_sane([[0, 0], [100, 0], [101, 1], [0, 50]]))
        # self intersecting ("bow tie")
        self.assertFalse(quad_is_sane([[0, 0], [100, 0], [0, 50], [100, 50]]))
        # two identical corners
        self.assertFalse(quad_is_sane([[0, 0], [0, 0], [100, 50], [0, 50]]))

    def test_expand_quad_scales_around_the_centre(self):
        quad = np.array([[0, 0], [100, 0], [100, 100], [0, 100]], dtype=float)
        grown = expand_quad(quad, 0.1)
        self.assertAlmostEqual(quad_area(grown) / quad_area(quad), 1.1 ** 2, places=6)
        np.testing.assert_allclose(grown.mean(axis=0), quad.mean(axis=0))

    def test_edge_lengths(self):
        width, height = edge_lengths(order_corners([[0, 0], [100, 0], [100, 50], [0, 50]]))
        self.assertAlmostEqual(width, 100.0)
        self.assertAlmostEqual(height, 50.0)


@requires_opencv
class TestAspectRatio(unittest.TestCase):

    def _quad(self, ratio, rotation=(0.35, 0.45, 0.15), distance=1.4):
        return order_corners(project_quad(ratio, rotation, distance, 900.0, (720, 1280)))

    def test_recovers_the_ratio_of_a_tilted_page(self):
        for ratio in (A4_RATIO, 1.0, 11.0 / 8.5, 0.5):
            for rotation in ((0.35, 0.45, 0.15), (0.6, 0.1, 0.0), (0.5, -0.4, 0.3)):
                estimate = projective_aspect_ratio(self._quad(ratio, rotation), (720, 1280))
                self.assertIsNotNone(estimate)
                self.assertAlmostEqual(estimate, ratio, delta=0.02 * ratio)

    def test_beats_the_naive_edge_ratio_on_a_tilted_page(self):
        quad = self._quad(A4_RATIO)
        width, height = edge_lengths(quad)
        naive_error = abs(width / height - A4_RATIO)
        estimated_error = abs(target_aspect_ratio(quad, (720, 1280), "auto") - A4_RATIO)
        self.assertLess(estimated_error, naive_error)

    def test_fixed_paper_size_follows_the_orientation(self):
        portrait = self._quad(A4_RATIO)
        landscape = self._quad(1.0 / A4_RATIO)
        self.assertAlmostEqual(target_aspect_ratio(portrait, (720, 1280), "a4"), A4_RATIO)
        self.assertAlmostEqual(target_aspect_ratio(landscape, (720, 1280), "a4"),
                               1.0 / A4_RATIO)

    def test_parallel_projection_has_no_perspective_information(self):
        # a parallelogram carries no information about the focal length
        quad = order_corners([[100, 100], [400, 100], [430, 300], [130, 300]])
        self.assertIsNone(projective_aspect_ratio(quad, (720, 1280)))

    def test_edges_mode_uses_the_measured_edges(self):
        quad = order_corners([[0, 0], [200, 0], [200, 100], [0, 100]])
        self.assertAlmostEqual(target_aspect_ratio(quad, (720, 1280), "edges"), 2.0)

    def test_unknown_mode_is_rejected(self):
        quad = order_corners([[0, 0], [200, 0], [200, 100], [0, 100]])
        with self.assertRaises(ValueError):
            target_aspect_ratio(quad, (720, 1280), "nonsense")

    def test_output_size_honours_the_maximum_side(self):
        quad = order_corners([[0, 0], [2000, 0], [2000, 1000], [0, 1000]])
        width, height = output_size(quad, (3000, 4000), aspect="edges", max_side=500)
        self.assertEqual((width, height), (500, 250))


@requires_opencv
class TestPerspectiveWarp(unittest.TestCase):

    def test_rectifies_a_projected_page(self):
        ratio = A4_RATIO
        quad = project_quad(ratio, (0.3, 0.4, 0.1), 1.6, 900.0, (720, 1280))
        image = np.zeros((720, 1280, 3), np.uint8)
        result = four_point_transform(image, quad, aspect="auto")
        height, width = result.shape[:2]
        self.assertAlmostEqual(width / height, ratio, delta=0.03 * ratio)

    def test_content_is_restored_to_a_rectangle(self):
        import cv2
        page = np.full((400, 300, 3), 255, np.uint8)
        cv2.rectangle(page, (50, 50), (250, 350), (0, 0, 0), -1)
        quad = project_quad(300.0 / 400.0, (0.3, 0.35, 0.05), 1.6, 900.0, (720, 1280))
        source = np.array([[0, 0], [299, 0], [299, 399], [0, 399]], dtype=np.float32)
        matrix = cv2.getPerspectiveTransform(source, quad)
        photo = cv2.warpPerspective(page, matrix, (1280, 720), borderValue=(255, 255, 255))
        restored = four_point_transform(photo, quad, aspect="auto")
        restored = cv2.resize(restored, (300, 400))
        difference = np.mean(np.abs(restored.astype(float) - page.astype(float)))
        self.assertLess(difference, 12.0)

    def test_explicit_size_is_used_as_is(self):
        image = np.zeros((720, 1280, 3), np.uint8)
        quad = [[10, 10], [200, 10], [200, 300], [10, 300]]
        result = four_point_transform(image, quad, size=(123, 456))
        self.assertEqual(result.shape[:2], (456, 123))


@requires_opencv
class TestRotation(unittest.TestCase):

    def test_quarter_turns(self):
        image = np.zeros((40, 100, 3), np.uint8)
        image[0, 0] = (255, 255, 255)
        self.assertEqual(rotate_image(image, 0).shape[:2], (40, 100))
        self.assertEqual(rotate_image(image, 90).shape[:2], (100, 40))
        self.assertEqual(rotate_image(image, 180).shape[:2], (40, 100))
        self.assertEqual(rotate_image(image, 270).shape[:2], (100, 40))
        # the marked corner travels around the image
        self.assertTrue(rotate_image(image, 90)[0, -1].all())
        self.assertTrue(rotate_image(image, 180)[-1, -1].all())
        self.assertTrue(rotate_image(image, 270)[-1, 0].all())

    def test_full_turn_returns_the_original(self):
        image = np.arange(40 * 100, dtype=np.uint8).reshape(40, 100)
        np.testing.assert_array_equal(rotate_image(image, 360), image)
