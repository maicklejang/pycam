"""
Copyright 2026 PyCAM contributors

This file is part of PyCAM.

PyCAM is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

PyCAM is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with PyCAM.  If not, see <http://www.gnu.org/licenses/>.


Virtual objects and virtual photos.

These helpers create the silhouettes that a camera *would* see, which makes it possible to try
out and to test the whole reconstruction without owning a turntable.
"""

import numpy as np

from pycam.Photogrammetry.silhouette import close_mask, dilate, fill_holes


def sphere(radius=40.0, center=(0.0, 0.0, 45.0)):
    """ return a function describing a solid sphere """
    center = np.asarray(center, dtype=float)

    def contains(points):
        return np.linalg.norm(points - center, axis=1) <= radius

    return contains


def box(size=(60.0, 40.0, 80.0), center=(0.0, 0.0, 40.0)):
    """ return a function describing a solid box """
    half = np.asarray(size, dtype=float) / 2.0
    center = np.asarray(center, dtype=float)

    def contains(points):
        return (np.abs(points - center) <= half).all(axis=1)

    return contains


def revolution(profile, height):
    """ return a solid of revolution around the Z axis

    @param profile: a callable that maps a height (0 .. height) to the radius at that height
    @param height: the total height of the object
    """
    def contains(points):
        z = points[:, 2]
        radius = np.where((z >= 0) & (z <= height), profile(np.clip(z, 0, height)), -1.0)
        return np.hypot(points[:, 0], points[:, 1]) <= radius

    return contains


def demo_object(height=90.0, base_radius=30.0):
    """ a chess pawn like object: a wide base, a narrow neck and a ball on top

    Every horizontal slice is a circle, therefore the visual hull of a full turntable sweep is
    identical to the object itself.  That makes it a good reference for testing.
    """
    def profile(z):
        relative = z / height
        base = base_radius * np.clip(1.0 - 2.2 * relative, 0.0, 1.0) ** 0.5
        neck = 0.35 * base_radius * np.ones_like(relative)
        ball_center = 0.78
        ball_radius = 0.22
        ball_offset = np.clip(1.0 - ((relative - ball_center) / ball_radius) ** 2, 0.0, 1.0)
        ball = 0.62 * base_radius * np.sqrt(ball_offset)
        return np.maximum(np.maximum(base, neck * (relative < 0.95)), ball)

    return revolution(profile, height)


def sample_solid(contains, low, high, resolution=110):
    """ return the centers of all voxels inside a solid """
    low = np.asarray(low, dtype=float)
    high = np.asarray(high, dtype=float)
    spacing = float((high - low).max()) / max(int(resolution), 4)
    axes = [np.arange(low[axis] + spacing / 2, high[axis], spacing) for axis in range(3)]
    grid = np.stack(np.meshgrid(*axes, indexing="ij"), axis=-1).reshape(-1, 3)
    return grid[contains(grid)]


def render_masks(cameras, points, grow=1):
    """ project a point cloud into every camera and return the resulting silhouettes """
    masks = []
    for camera in cameras:
        pixels, depth = camera.project(points)
        width = camera.intrinsics.width
        height = camera.intrinsics.height
        columns = np.floor(pixels[:, 0]).astype(np.int64)
        rows = np.floor(pixels[:, 1]).astype(np.int64)
        visible = ((depth > 0) & (columns >= 0) & (columns < width)
                   & (rows >= 0) & (rows < height))
        mask = np.zeros((height, width), dtype=bool)
        mask[rows[visible], columns[visible]] = True
        if grow > 0:
            # close the gaps between the projected samples
            mask = fill_holes(close_mask(dilate(mask, grow), grow))
        masks.append(mask)
    return masks


def render_photos(masks, object_color=(210, 60, 40), background_color=(240, 240, 235), noise=6,
                  seed=1234):
    """ turn silhouettes into plausible looking photos (a colored object on a light background)

    The photos are only used for demonstrations and tests - they contain no shading, but they
    exercise exactly the same code path as real photos.
    """
    generator = np.random.default_rng(seed)
    photos = []
    for mask in masks:
        image = np.zeros(mask.shape + (3,), dtype=np.float32)
        image[:] = np.asarray(background_color, dtype=np.float32)
        image[mask] = np.asarray(object_color, dtype=np.float32)
        if noise > 0:
            image += generator.normal(0.0, noise, image.shape)
        photos.append(np.clip(image, 0, 255).astype(np.uint8))
    return photos
