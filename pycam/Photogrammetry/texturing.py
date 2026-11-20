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


Texture coordinates ("UV mapping") and the texture itself.

The carved model only describes the shape of the object - its colors are still sitting in the
photos.  This module puts both together:

  1. every vertex is given a texture coordinate by wrapping a cylinder around the rotation
     axis of the turntable, which is the natural parametrization for a scan of this kind,
  2. the texture is "baked": for every pixel of the texture the corresponding point on the
     surface is looked up in those photos that actually see it, and their colors are mixed.

The result is an OBJ file with "vt" coordinates, a material and a PNG - the combination that
every 3D viewer, slicer and game engine understands.
"""

import numpy as np

# texels whose surface point is seen by no photo are filled from their neighbors
_FILL_PASSES = 32


class TextureConfig:
    """ the parameters of the texture generation """

    def __init__(self, size=1024, views=3, sharpness=3.0, padding=8, minimum_angle=20.0,
                 mask_margin=2, background=(200, 200, 200), name=None):
        """ @param size: edge length of the square texture in pixels
        @param views: how many photos are mixed for one point of the surface
        @param sharpness: how strongly the photo with the best view is preferred
        @param padding: how far the texture is extended beyond the used areas, so that no
            background shines through at the seams
        @param minimum_angle: photos that see a part of the surface flatter than this angle
            are not used for it
        @param mask_margin: how far the silhouette is shrunk before colors are taken from a
            photo (the outline of an object usually carries a halo of background)
        @param background: the color of the parts that no photo has seen
        @param name: the file name of the texture (default: the name of the model)
        """
        self.size = max(int(size), 16)
        self.views = max(int(views), 1)
        self.sharpness = float(sharpness)
        self.padding = max(int(padding), 0)
        self.minimum_angle = float(minimum_angle)
        self.mask_margin = max(int(mask_margin), 0)
        self.background = tuple(int(value) for value in background)
        self.name = None if name is None else str(name)

    def as_dict(self):
        return dict(vars(self))

    @classmethod
    def from_dict(cls, data):
        return cls(**{key: value for key, value in (data or {}).items()})


def cylindrical_uv(mesh, axis_fraction=0.04):
    """ wrap a cylinder around the Z axis and return a copy of the mesh with UV coordinates

    The horizontal coordinate follows the rotation of the turntable, the vertical one the
    height of the object.  Two details decide whether the texture looks right or falls apart:

      * the seam at the back of the object, where the texture coordinate jumps from 1 back
        to 0 - the vertices there have to exist twice, once for each side,
      * the vertices on the rotation axis itself (the top of the object), whose angle is
        undefined and is taken from their neighbors instead.

    @param axis_fraction: vertices closer to the axis than this fraction of the radius are
        treated as lying on it
    @returns: a new Mesh with the same shape, additional vertices along the seam and UVs
    """
    from pycam.Photogrammetry.mesh import Mesh
    vertices = mesh.vertices
    faces = mesh.faces
    if len(faces) == 0:
        return mesh.copy()
    radius = np.hypot(vertices[:, 0], vertices[:, 1])
    angle = np.arctan2(vertices[:, 1], vertices[:, 0]) / (2.0 * np.pi)
    horizontal = np.mod(angle, 1.0)
    low, high = mesh.bounds
    height = max(float(high[2] - low[2]), 1e-9)
    vertical = (vertices[:, 2] - low[2]) / height
    corner_u = horizontal[faces].copy()
    # the triangles that cross the seam: their narrow side is on the far end of the texture
    crossing = (corner_u.max(axis=1) - corner_u.min(axis=1)) > 0.5
    if crossing.any():
        wrapped = corner_u[crossing]
        corner_u[crossing] = np.where(wrapped < 0.5, wrapped + 1.0, wrapped)
    on_axis = radius <= (axis_fraction * max(float(radius.max()), 1e-9))
    if on_axis.any():
        corner_on_axis = on_axis[faces]
        # the angle of a point on the axis is arbitrary - use the one of the other corners
        available = (~corner_on_axis).sum(axis=1)
        total = np.where(corner_on_axis, 0.0, corner_u).sum(axis=1)
        # a triangle whose corners all sit on the axis has no angle at all - any value will do
        replacement = np.where(available > 0, total / np.maximum(available, 1), 0.0)
        corner_u = np.where(corner_on_axis, replacement[:, None], corner_u)
    corner_v = vertical[faces]
    # every combination of an original vertex and a texture coordinate becomes one vertex
    quantized = np.round(corner_u * 100000.0).astype(np.int64)
    keys = faces.astype(np.int64) * 1000003 + quantized
    unique, inverse = np.unique(keys.reshape(-1), return_inverse=True)
    new_faces = inverse.reshape(faces.shape)
    sources = faces.reshape(-1)
    new_vertices = np.zeros((len(unique), 3), dtype=float)
    new_uv = np.zeros((len(unique), 2), dtype=float)
    new_vertices[new_faces.reshape(-1)] = vertices[sources]
    new_uv[new_faces.reshape(-1), 0] = corner_u.reshape(-1)
    new_uv[new_faces.reshape(-1), 1] = corner_v.reshape(-1)
    # the triangles at the seam keep a coordinate beyond 1.0: a texture repeats horizontally,
    # so they continue on the left edge - exactly what a cylinder needs
    return Mesh(new_vertices, new_faces, uv=new_uv)


def _chunks(count, size):
    for start in range(0, count, size):
        yield slice(start, min(start + size, count))


def unoccluded(grid, points, center, steps=40, bias=1.5, chunk=20000):
    """ test whether the straight line from a point to the camera stays outside of the model

    The carved volume is the only thing known about the object, and it is enough: a point on
    the back of the object is hidden by the voxels in between.
    """
    points = np.asarray(points, dtype=float).reshape(-1, 3)
    center = np.asarray(center, dtype=float).reshape(3)
    if grid is None:
        return np.ones(len(points), dtype=bool)
    spacing = grid.spacing
    shape = np.array(grid.occupancy.shape)
    result = np.ones(len(points), dtype=bool)
    ratios = np.linspace(0.0, 1.0, max(int(steps), 2))[None, :, None]
    for part in _chunks(len(points), chunk):
        block = points[part]
        direction = center - block
        length = np.linalg.norm(direction, axis=1, keepdims=True)
        length[length < 1e-12] = 1.0
        # start a little above the surface, otherwise the point hides itself
        start = block + direction / length * (bias * float(spacing.max()))
        samples = start[:, None, :] + (center - start)[:, None, :] * ratios
        indices = np.floor((samples - grid.origin) / spacing).astype(np.int64)
        inside = np.all((indices >= 0) & (indices < shape), axis=2)
        occupied = np.zeros(inside.shape, dtype=bool)
        if inside.any():
            selected = indices[inside]
            occupied[inside] = grid.occupancy[selected[:, 0], selected[:, 1], selected[:, 2]]
        result[part] = ~occupied.any(axis=1)
    return result


def view_weights(mesh, cameras, grid=None, config=None):
    """ rate how well every photo sees every triangle

    @returns: an array of shape (triangles x cameras); a weight of zero means that the photo
        does not show that triangle at all
    """
    config = config or TextureConfig()
    corners = mesh.vertices[mesh.faces]
    centers = corners.mean(axis=1)
    normals = mesh.face_normals()
    weights = np.zeros((len(mesh.faces), len(cameras)), dtype=float)
    limit = float(np.sin(np.radians(max(min(config.minimum_angle, 89.0), 0.0))))
    for index, camera in enumerate(cameras):
        direction = camera.center - centers
        length = np.linalg.norm(direction, axis=1, keepdims=True)
        length[length < 1e-12] = 1.0
        direction = direction / length
        facing = np.einsum("ij,ij->i", normals, direction)
        # "facing" is the cosine between the surface normal and the direction to the camera,
        # so the photo grazes the surface under the complementary angle
        usable = facing > limit
        if not usable.any():
            continue
        visible = np.zeros(len(centers), dtype=bool)
        visible[usable] = unoccluded(grid, centers[usable], camera.center)
        chosen = usable & visible
        weights[chosen, index] = np.power(facing[chosen], max(config.sharpness, 0.0))
    return weights


def _limit_to_best_views(weights, count):
    """ keep only the best photos per triangle, so that blurry views do not smear the texture """
    if weights.shape[1] <= count:
        return weights
    threshold = np.sort(weights, axis=1)[:, -count][:, None]
    return np.where(weights >= threshold, weights, 0.0)


def _rasterize(mesh, size):
    """ render the triangles into the texture

    @returns: a tuple of the triangle index per texel (-1 where nothing was drawn) and the
        world coordinates of the surface point belonging to every texel
    """
    face_index = np.full((size, size), -1, dtype=np.int64)
    positions = np.zeros((size, size, 3), dtype=np.float32)
    corners = mesh.vertices[mesh.faces]
    pixels = mesh.uv[mesh.faces] * (size - 1)
    for index in range(len(mesh.faces)):
        triangle = pixels[index]
        low = np.floor(triangle.min(axis=0)).astype(int) - 1
        high = np.ceil(triangle.max(axis=0)).astype(int) + 1
        # the texture repeats horizontally - the columns are wrapped when they are written
        columns = np.arange(low[0], high[0] + 1)
        rows = np.arange(max(low[1], 0), min(high[1], size - 1) + 1)
        if (len(columns) == 0) or (len(rows) == 0):
            continue
        grid_x, grid_y = np.meshgrid(columns, rows)
        first, second, third = triangle
        denominator = ((second[1] - third[1]) * (first[0] - third[0])
                       + (third[0] - second[0]) * (first[1] - third[1]))
        if abs(denominator) < 1e-12:
            continue
        alpha = ((second[1] - third[1]) * (grid_x - third[0])
                 + (third[0] - second[0]) * (grid_y - third[1])) / denominator
        beta = ((third[1] - first[1]) * (grid_x - third[0])
                + (first[0] - third[0]) * (grid_y - third[1])) / denominator
        gamma = 1.0 - alpha - beta
        # a slightly enlarged triangle avoids holes between neighboring triangles
        inside = (alpha >= -0.003) & (beta >= -0.003) & (gamma >= -0.003)
        if not inside.any():
            continue
        weights = np.stack((alpha[inside], beta[inside], gamma[inside]), axis=1)
        weights = np.clip(weights, 0.0, 1.0)
        weights /= np.maximum(weights.sum(axis=1, keepdims=True), 1e-12)
        target_rows = grid_y[inside]
        target_columns = np.mod(grid_x[inside], size)
        face_index[target_rows, target_columns] = index
        positions[target_rows, target_columns] = weights @ corners[index]
    return face_index, positions


def _sample_bilinear(image, pixels):
    """ read colors from a photo at fractional pixel positions """
    height, width = image.shape[:2]
    x = np.clip(pixels[:, 0], 0.0, width - 1.0)
    y = np.clip(pixels[:, 1], 0.0, height - 1.0)
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    x1 = np.minimum(x0 + 1, width - 1)
    y1 = np.minimum(y0 + 1, height - 1)
    fx = (x - x0)[:, None]
    fy = (y - y0)[:, None]
    values = image.astype(np.float32)
    top = values[y0, x0] * (1.0 - fx) + values[y0, x1] * fx
    bottom = values[y1, x0] * (1.0 - fx) + values[y1, x1] * fx
    return top * (1.0 - fy) + bottom * fy


def _fill_gaps(color, filled, rounds=_FILL_PASSES):
    """ extend the texture into the areas that no photo has seen """
    if filled.all() or not filled.any():
        return color, filled
    known = filled.copy()
    result = color.copy()
    for _ in range(max(int(rounds), 1)):
        if known.all():
            break
        weights = np.zeros(known.shape, dtype=np.float32)
        sums = np.zeros(result.shape, dtype=np.float32)
        for shift, axis in ((1, 0), (-1, 0), (1, 1), (-1, 1)):
            neighbor = np.roll(known, shift, axis=axis)
            values = np.roll(result, shift, axis=axis)
            if axis == 0:
                if shift > 0:
                    neighbor[0] = False
                else:
                    neighbor[-1] = False
            else:
                if shift > 0:
                    neighbor[:, 0] = False
                else:
                    neighbor[:, -1] = False
            weights += neighbor
            sums += values * neighbor[:, :, None]
        grown = (~known) & (weights > 0)
        if not grown.any():
            break
        result[grown] = sums[grown] / weights[grown][:, None]
        known = known | grown
    return result, known


def bake_texture(mesh, cameras, images, masks=None, grid=None, config=None, progress=None):
    """ paint the photos onto the UV map of a mesh

    @param mesh: a mesh with texture coordinates (see "cylindrical_uv")
    @param cameras: one camera per photo
    @param images: the photos belonging to the cameras (RGB arrays)
    @param masks: the silhouettes belonging to the photos - colors are only taken from inside
    @param grid: the carved voxel volume, used to find out what a photo cannot see
    @returns: the texture as an RGB array of bytes
    """
    from pycam.Photogrammetry.silhouette import erode
    config = config or TextureConfig()
    if mesh.uv is None:
        raise ValueError("the mesh has no texture coordinates")
    if len(cameras) != len(images):
        raise ValueError("every photo needs a camera ({} photos, {} cameras)"
                         .format(len(images), len(cameras)))
    size = config.size
    if progress is not None:
        progress("preparing the texture", 0.0)
    weights = _limit_to_best_views(view_weights(mesh, cameras, grid, config), config.views)
    face_index, positions = _rasterize(mesh, size)
    used = face_index >= 0
    color_sum = np.zeros((size, size, 3), dtype=np.float32)
    weight_sum = np.zeros((size, size), dtype=np.float32)
    flat_faces = face_index[used]
    flat_positions = positions[used].astype(np.float64)
    texel_rows, texel_columns = np.nonzero(used)
    for index, (camera, image) in enumerate(zip(cameras, images)):
        if progress is not None:
            progress("painting photo {}/{}".format(index + 1, len(images)),
                     (index + 1) / float(len(images)))
        texel_weight = weights[flat_faces, index]
        candidates = texel_weight > 0
        if not candidates.any():
            continue
        pixels, depth = camera.project(flat_positions[candidates])
        image = np.asarray(image)
        height, width = image.shape[:2]
        valid = ((depth > 0)
                 & (pixels[:, 0] >= 0) & (pixels[:, 0] <= width - 1)
                 & (pixels[:, 1] >= 0) & (pixels[:, 1] <= height - 1))
        if masks is not None:
            mask = np.asarray(masks[index], dtype=bool)
            if config.mask_margin > 0:
                mask = erode(mask, config.mask_margin)
            columns = np.clip(np.round(pixels[:, 0]).astype(np.int64), 0, width - 1)
            rows = np.clip(np.round(pixels[:, 1]).astype(np.int64), 0, height - 1)
            valid &= mask[rows, columns]
        if not valid.any():
            continue
        colors = _sample_bilinear(image, pixels[valid])
        selected = np.nonzero(candidates)[0][valid]
        share = texel_weight[selected].astype(np.float32)
        target_rows = texel_rows[selected]
        target_columns = texel_columns[selected]
        np.add.at(color_sum, (target_rows, target_columns), colors * share[:, None])
        np.add.at(weight_sum, (target_rows, target_columns), share)
    painted = weight_sum > 0
    texture = np.zeros((size, size, 3), dtype=np.float32)
    texture[painted] = color_sum[painted] / weight_sum[painted][:, None]
    texture, known = _fill_gaps(texture, painted, config.padding + _FILL_PASSES)
    texture[~known] = np.asarray(config.background, dtype=np.float32)
    if progress is not None:
        progress("the texture is ready", 1.0)
    return np.clip(texture, 0, 255).astype(np.uint8)


def texture_mesh(mesh, cameras, images, masks=None, grid=None, config=None, progress=None):
    """ give a mesh texture coordinates and the matching texture

    @returns: a new mesh that carries both
    """
    config = config or TextureConfig()
    mapped = cylindrical_uv(mesh)
    texture = bake_texture(mapped, cameras, images, masks=masks, grid=grid, config=config,
                           progress=progress)
    mapped.texture = texture
    mapped.texture_name = config.name
    return mapped
