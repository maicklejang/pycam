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


def cylinder_surface_color(points, height=90.0):
    """ a smooth, unambiguous pattern on the surface of the demo cylinder

    Both the angle around the rotation axis and the height are visible in the color, so a
    texture that is rotated or mirrored by mistake cannot pass unnoticed.
    """
    points = np.asarray(points, dtype=float).reshape(-1, 3)
    azimuth = np.arctan2(points[:, 1], points[:, 0])
    level = np.clip(points[:, 2] / max(float(height), 1e-9), 0.0, 1.0)
    colors = np.empty((len(points), 3), dtype=float)
    colors[:, 0] = 128.0 + 100.0 * np.sin(azimuth)
    colors[:, 1] = 128.0 + 100.0 * np.cos(azimuth)
    colors[:, 2] = 30.0 + 200.0 * level
    return np.clip(colors, 0, 255)


def _cylinder_hit(camera, radius, height):
    """ intersect one ray per pixel with a standing cylinder

    @returns: a tuple of the hit mask and the world coordinates of the hit points
    """
    intrinsics = camera.intrinsics
    columns, rows = np.meshgrid(np.arange(intrinsics.width, dtype=float),
                                np.arange(intrinsics.height, dtype=float))
    local = np.stack(((columns.reshape(-1) + 0.5 - intrinsics.cx) / intrinsics.fx,
                      (rows.reshape(-1) + 0.5 - intrinsics.cy) / intrinsics.fy,
                      np.ones(intrinsics.width * intrinsics.height)), axis=1)
    directions = local @ camera.rotation
    origin = camera.center
    a = directions[:, 0] ** 2 + directions[:, 1] ** 2
    b = 2.0 * (origin[0] * directions[:, 0] + origin[1] * directions[:, 1])
    c = origin[0] ** 2 + origin[1] ** 2 - radius ** 2
    discriminant = b ** 2 - 4.0 * a * c
    best = np.full(len(directions), np.inf)
    valid = (discriminant >= 0) & (a > 1e-12)
    if valid.any():
        root = np.sqrt(discriminant[valid])
        for candidate in ((-b[valid] - root) / (2.0 * a[valid]),
                          (-b[valid] + root) / (2.0 * a[valid])):
            z = origin[2] + candidate * directions[valid, 2]
            usable = (candidate > 0) & (z >= 0.0) & (z <= height)
            current = best[valid]
            current[usable] = np.minimum(current[usable], candidate[usable])
            best[valid] = current
    # the lid of the cylinder, which a camera above the object looks at
    with np.errstate(divide="ignore", invalid="ignore"):
        cap = (height - origin[2]) / directions[:, 2]
    cap_point = origin + cap[:, None] * directions
    on_cap = ((cap > 0) & np.isfinite(cap)
              & ((cap_point[:, 0] ** 2 + cap_point[:, 1] ** 2) <= radius ** 2))
    best[on_cap] = np.minimum(best[on_cap], cap[on_cap])
    hit = np.isfinite(best)
    points = origin + np.where(hit, best, 0.0)[:, None] * directions
    shape = (intrinsics.height, intrinsics.width)
    return hit.reshape(shape), points.reshape(shape + (3,))


def render_textured_photos(cameras, radius=30.0, height=90.0, background_color=(240, 240, 235),
                           noise=0.0, seed=4321):
    """ render photos of a patterned cylinder standing on the turntable

    Unlike "render_photos" these images carry a different color in every direction, which is
    what the texture mapping needs in order to be tested.

    @returns: a tuple of the photos and the matching silhouettes
    """
    generator = np.random.default_rng(seed)
    photos = []
    masks = []
    for camera in cameras:
        hit, points = _cylinder_hit(camera, radius, height)
        image = np.zeros(hit.shape + (3,), dtype=float)
        image[:] = np.asarray(background_color, dtype=float)
        if hit.any():
            image[hit] = cylinder_surface_color(points[hit], height)
        if noise > 0:
            image += generator.normal(0.0, noise, image.shape)
        photos.append(np.clip(image, 0, 255).astype(np.uint8))
        masks.append(hit)
    return photos, masks


def _fill_color_gaps(image, painted, passes=3):
    """ close the pinholes that are left between the projected sample points """
    for _ in range(max(int(passes), 0)):
        if painted.all():
            break
        weights = np.zeros(painted.shape, dtype=np.float32)
        sums = np.zeros(image.shape, dtype=np.float32)
        for shift, axis in ((1, 0), (-1, 0), (1, 1), (-1, 1)):
            neighbor = np.roll(painted, shift, axis=axis)
            values = np.roll(image, shift, axis=axis)
            if axis == 0:
                neighbor[0 if shift > 0 else -1] = False
            else:
                neighbor[:, 0 if shift > 0 else -1] = False
            weights += neighbor
            sums += values * neighbor[:, :, None]
        grown = (~painted) & (weights > 0)
        if not grown.any():
            break
        image[grown] = sums[grown] / weights[grown][:, None]
        painted = painted | grown
    return image, painted


def render_solid_photos(cameras, points, color_function=None, background_color=(240, 240, 235),
                        grow=1, noise=0.0, seed=97):
    """ render photos of a solid that is given as a cloud of sample points

    The points are drawn from the back to the front, so the nearest surface wins - enough for
    a convincing demonstration photo of an object whose color depends on its position.

    @returns: a tuple of the photos and the matching silhouettes
    """
    generator = np.random.default_rng(seed)
    points = np.asarray(points, dtype=float).reshape(-1, 3)
    if color_function is None:
        colors = np.broadcast_to(np.array((205.0, 75.0, 50.0)), points.shape)
    else:
        colors = np.asarray(color_function(points), dtype=float).reshape(-1, 3)
    photos = []
    masks = []
    for camera in cameras:
        pixels, depth = camera.project(points)
        width = camera.intrinsics.width
        height = camera.intrinsics.height
        columns = np.floor(pixels[:, 0]).astype(np.int64)
        rows = np.floor(pixels[:, 1]).astype(np.int64)
        visible = ((depth > 0) & (columns >= 0) & (columns < width)
                   & (rows >= 0) & (rows < height))
        image = np.zeros((height, width, 3), dtype=np.float32)
        image[:] = np.asarray(background_color, dtype=np.float32)
        painted = np.zeros((height, width), dtype=bool)
        if visible.any():
            order = np.argsort(-depth[visible])
            target_rows = rows[visible][order]
            target_columns = columns[visible][order]
            image[target_rows, target_columns] = colors[visible][order]
            painted[target_rows, target_columns] = True
        # the silhouette follows the projected points - the color filling below must not
        # enlarge it, it only paints the pixels between them
        mask = painted
        if grow > 0:
            mask = fill_holes(close_mask(dilate(mask, grow), grow))
        image, _ = _fill_color_gaps(image, painted, passes=grow + 3)
        image[~mask] = np.asarray(background_color, dtype=np.float32)
        if noise > 0:
            image += generator.normal(0.0, noise, image.shape)
        photos.append(np.clip(image, 0, 255).astype(np.uint8))
        masks.append(mask)
    return photos, masks
