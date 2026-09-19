"""Tests for the image clean-up steps."""

import unittest

from docscan.tests import HAVE_OPENCV, requires_opencv

if HAVE_OPENCV:
    import numpy as np

    import cv2

    from docscan.enhance import (MODE_DESCRIPTIONS, MODES, auto_white_balance, enhance,
                                 remove_shadows, stretch_levels, to_black_white,
                                 unsharp_mask, whiten)


def _page_with_text(width=600, height=800, background=250, ink=35):
    page = np.full((height, width, 3), background, np.uint8)
    for index in range(12):
        row = 60 + index * 60
        cv2.line(page, (50, row), (width - 60, row), (ink, ink, ink), 4)
    return page


def _add_lighting_gradient(image, strength=0.55):
    rows, columns = np.mgrid[0:image.shape[0], 0:image.shape[1]]
    shade = (1.0 - strength * (columns / image.shape[1])).astype(np.float32)
    return np.clip(image.astype(np.float32) * shade[..., None], 0, 255).astype(np.uint8)


@requires_opencv
class TestShadowRemoval(unittest.TestCase):

    def test_flattens_a_lighting_gradient(self):
        page = _add_lighting_gradient(_page_with_text())
        gray = cv2.cvtColor(page, cv2.COLOR_BGR2GRAY)
        flattened = remove_shadows(gray)
        # compare the paper brightness on the bright and on the dark side
        before = abs(float(gray[:, :50].mean()) - float(gray[:, -50:].mean()))
        after = abs(float(flattened[:, :50].mean()) - float(flattened[:, -50:].mean()))
        self.assertGreater(before, 60.0)
        self.assertLess(after, 8.0)

    def test_keeps_the_ink_dark(self):
        page = _page_with_text()
        # the ink mask comes from the unlit page: on the shaded side even the
        # paper is dark, so it cannot be used to tell ink from background
        ink_mask = cv2.cvtColor(page, cv2.COLOR_BGR2GRAY) < 128
        flattened = remove_shadows(cv2.cvtColor(_add_lighting_gradient(page),
                                                cv2.COLOR_BGR2GRAY))
        self.assertLess(float(flattened[ink_mask].mean()), 130.0)
        self.assertGreater(float(flattened[~ink_mask].mean()), 230.0)

    def test_zero_strength_is_a_no_operation(self):
        gray = cv2.cvtColor(_page_with_text(), cv2.COLOR_BGR2GRAY)
        np.testing.assert_array_equal(remove_shadows(gray, 0.0), gray)

    def test_colour_images_keep_their_shape(self):
        page = _add_lighting_gradient(_page_with_text())
        self.assertEqual(remove_shadows(page).shape, page.shape)


@requires_opencv
class TestBuildingBlocks(unittest.TestCase):

    def test_stretch_levels_uses_the_full_range(self):
        image = np.linspace(80, 170, 256 * 256, dtype=np.float32).reshape(256, 256)
        stretched = stretch_levels(image.astype(np.uint8))
        self.assertLess(stretched.min(), 10)
        self.assertGreater(stretched.max(), 245)

    def test_stretch_levels_keeps_flat_images(self):
        flat = np.full((32, 32), 128, np.uint8)
        np.testing.assert_array_equal(stretch_levels(flat), flat)

    def test_whiten_lifts_the_paper_but_keeps_the_ink(self):
        gray = np.array([[10, 120, 230, 240]], np.uint8)
        whitened = whiten(gray, 225)
        self.assertEqual(whitened[0, 0], 11)
        self.assertEqual(whitened[0, 2], 255)
        self.assertEqual(whitened[0, 3], 255)

    def test_white_balance_neutralises_a_colour_cast(self):
        image = np.full((32, 32, 3), (200, 230, 250), np.uint8)
        balanced = auto_white_balance(image)
        channels = [float(balanced[:, :, index].mean()) for index in range(3)]
        self.assertLess(max(channels) - min(channels), 12.0)

    def test_unsharp_mask_increases_local_contrast(self):
        page = cv2.GaussianBlur(_page_with_text(), (5, 5), 0)
        sharpened = unsharp_mask(page, amount=0.8)
        self.assertGreater(float(np.std(sharpened)), float(np.std(page)))

    def test_unsharp_mask_without_amount_is_a_no_operation(self):
        page = _page_with_text()
        np.testing.assert_array_equal(unsharp_mask(page, amount=0.0), page)


@requires_opencv
class TestBlackAndWhite(unittest.TestCase):

    def test_output_is_bi_level(self):
        binary = to_black_white(_add_lighting_gradient(_page_with_text()))
        self.assertEqual(binary.ndim, 2)
        self.assertTrue(set(np.unique(binary)).issubset({0, 255}))

    def test_text_survives_uneven_lighting(self):
        page = _page_with_text()
        binary = to_black_white(_add_lighting_gradient(page))
        truth = cv2.cvtColor(page, cv2.COLOR_BGR2GRAY) < 128
        found = binary < 128
        # most of the ink must still be there, without flooding the page
        recall = float((found & truth).sum()) / float(truth.sum())
        self.assertGreater(recall, 0.8)
        self.assertLess(float(found.mean()), 3.0 * float(truth.mean()))


@requires_opencv
class TestModes(unittest.TestCase):

    def test_every_mode_is_documented(self):
        self.assertEqual(set(MODES), set(MODE_DESCRIPTIONS))

    def test_every_mode_returns_a_usable_image(self):
        page = _add_lighting_gradient(_page_with_text())
        for mode in MODES:
            with self.subTest(mode=mode):
                result = enhance(page, mode=mode)
                self.assertEqual(result.dtype, np.uint8)
                self.assertEqual(result.shape[:2], page.shape[:2])
                self.assertIn(result.ndim, (2, 3))

    def test_colour_modes_brighten_the_paper(self):
        page = _add_lighting_gradient(_page_with_text())
        dark_corner = float(cv2.cvtColor(page, cv2.COLOR_BGR2GRAY)[:, -50:].mean())
        for mode in ("color", "magic", "gray"):
            with self.subTest(mode=mode):
                result = enhance(page, mode=mode)
                gray = result if result.ndim == 2 else cv2.cvtColor(result, cv2.COLOR_BGR2GRAY)
                self.assertGreater(float(gray[:, -50:].mean()), dark_corner + 40)

    def test_mode_none_is_untouched(self):
        page = _page_with_text()
        np.testing.assert_array_equal(enhance(page, mode="none"), page)

    def test_unknown_mode_is_rejected(self):
        with self.assertRaises(ValueError):
            enhance(_page_with_text(), mode="sepia")
