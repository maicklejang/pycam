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


Surface extraction from a scalar volume ("naive surface nets").

Every cell of the volume that is crossed by the surface receives exactly one vertex, which is
placed at the average of the crossing points along the edges of that cell.  Afterwards the
vertices of the four cells around every crossed grid edge are connected to a quad.  Compared to
marching cubes this produces fewer and more evenly shaped triangles and it always yields a
closed, consistently oriented surface, which is exactly what a CAM program needs.
"""

import numpy as np

from pycam.Photogrammetry.mesh import Mesh


# the eight corners of a cell (in the order used for the local corner index)
_CORNERS = np.array([(x, y, z) for x in (0, 1) for y in (0, 1) for z in (0, 1)], dtype=np.int64)
# the twelve edges of a cell as pairs of corner indices
_CELL_EDGES = tuple((first, second)
                    for first in range(8) for second in range(first + 1, 8)
                    if np.abs(_CORNERS[first] - _CORNERS[second]).sum() == 1)


def smooth_field(field, iterations=1):
    """ apply a separable 3x3x3 box filter to a volume

    Applying this to a binary volume before extracting the surface removes most of the
    staircase artifacts of the voxel grid.
    """
    result = np.asarray(field, dtype=np.float32)
    for _ in range(max(int(iterations), 0)):
        padded = np.pad(result, 1, mode="edge")
        accumulator = np.zeros_like(result)
        for axis_x in range(3):
            for axis_y in range(3):
                for axis_z in range(3):
                    accumulator += padded[axis_x:axis_x + result.shape[0],
                                          axis_y:axis_y + result.shape[1],
                                          axis_z:axis_z + result.shape[2]]
        result = accumulator / 27.0
    return result


def extract_surface(field, iso=0.5, origin=(0.0, 0.0, 0.0), spacing=1.0):
    """ extract the iso surface of a volume as a triangle mesh

    @param field: a three dimensional array of scalar values
    @param iso: the threshold that separates the inside (bigger values) from the outside
    @param origin: the world coordinates of the sample field[0, 0, 0]
    @param spacing: the distance between two neighboring samples (a scalar or three values)
    @returns: a Mesh with outwards facing triangles
    """
    field = np.asarray(field, dtype=np.float32)
    if field.ndim != 3:
        raise ValueError("a three dimensional volume is required: {}".format(field.shape))
    origin = np.asarray(origin, dtype=float).reshape(3)
    spacing = np.broadcast_to(np.asarray(spacing, dtype=float), (3,)).astype(float)
    if min(field.shape) < 2:
        return _empty_mesh()
    signed = field - float(iso)
    inside = signed > 0
    if not inside.any() or inside.all():
        return _empty_mesh()
    vertices, vertex_index = _cell_vertices(signed, inside, origin, spacing)
    if len(vertices) == 0:
        return _empty_mesh()
    faces = []
    for axis in range(3):
        faces.extend(_faces_for_axis(inside, vertex_index, axis))
    if not faces:
        return _empty_mesh()
    return Mesh(vertices, np.vstack(faces))


def _empty_mesh():
    return Mesh(np.zeros((0, 3), dtype=float), np.zeros((0, 3), dtype=np.int64))


def _cell_vertices(signed, inside, origin, spacing):
    """ place one vertex into every cell that is crossed by the surface """
    cell_shape = tuple(size - 1 for size in signed.shape)
    corner_values = np.empty(cell_shape + (8,), dtype=np.float32)
    corner_inside = np.empty(cell_shape + (8,), dtype=bool)
    for index, (offset_x, offset_y, offset_z) in enumerate(_CORNERS):
        selection = (slice(offset_x, offset_x + cell_shape[0]),
                     slice(offset_y, offset_y + cell_shape[1]),
                     slice(offset_z, offset_z + cell_shape[2]))
        corner_values[..., index] = signed[selection]
        corner_inside[..., index] = inside[selection]
    active = corner_inside.any(axis=-1) & (~corner_inside).any(axis=-1)
    active_cells = np.nonzero(active)
    count = len(active_cells[0])
    if count == 0:
        return np.zeros((0, 3), dtype=float), np.full(cell_shape, -1, dtype=np.int64)
    values = corner_values[active]
    states = corner_inside[active]
    position_sum = np.zeros((count, 3), dtype=np.float64)
    crossing_count = np.zeros(count, dtype=np.float64)
    for first, second in _CELL_EDGES:
        crossing = states[:, first] != states[:, second]
        if not crossing.any():
            continue
        value_a = values[crossing, first].astype(np.float64)
        value_b = values[crossing, second].astype(np.float64)
        ratio = value_a / (value_a - value_b)
        ratio = np.clip(ratio, 0.0, 1.0)
        start = _CORNERS[first].astype(np.float64)
        direction = (_CORNERS[second] - _CORNERS[first]).astype(np.float64)
        position_sum[crossing] += start + ratio[:, None] * direction
        crossing_count[crossing] += 1.0
    crossing_count[crossing_count == 0] = 1.0
    local = position_sum / crossing_count[:, None]
    cell_indices = np.stack(active_cells, axis=1).astype(np.float64)
    vertices = origin + (cell_indices + local) * spacing
    vertex_index = np.full(cell_shape, -1, dtype=np.int64)
    vertex_index[active_cells] = np.arange(count, dtype=np.int64)
    return vertices, vertex_index


def _faces_for_axis(inside, vertex_index, axis):
    """ connect the four cells around every crossed grid edge along one axis """
    lower = [slice(None)] * 3
    upper = [slice(None)] * 3
    lower[axis] = slice(0, -1)
    upper[axis] = slice(1, None)
    state_low = inside[tuple(lower)]
    state_high = inside[tuple(upper)]
    crossing = np.nonzero(state_low != state_high)
    if len(crossing[0]) == 0:
        return []
    indices = np.stack(crossing, axis=1)
    # the two axes that span the quad - their cyclic order defines the winding
    first_axis = (axis + 1) % 3
    second_axis = (axis + 2) % 3
    limits = vertex_index.shape
    valid = ((indices[:, first_axis] >= 1) & (indices[:, first_axis] <= limits[first_axis] - 1)
             & (indices[:, second_axis] >= 1)
             & (indices[:, second_axis] <= limits[second_axis] - 1))
    indices = indices[valid]
    if len(indices) == 0:
        return []
    forward = state_low[tuple(crossing)][valid]
    corners = []
    for offset_first, offset_second in ((-1, -1), (0, -1), (0, 0), (-1, 0)):
        cell = np.empty((len(indices), 3), dtype=np.int64)
        cell[:, axis] = indices[:, axis]
        cell[:, first_axis] = indices[:, first_axis] + offset_first
        cell[:, second_axis] = indices[:, second_axis] + offset_second
        corners.append(vertex_index[cell[:, 0], cell[:, 1], cell[:, 2]])
    quads = np.stack(corners, axis=1)
    complete = (quads >= 0).all(axis=1)
    if not complete.all():
        # this should not happen for a consistent volume - but never emit broken faces
        quads = quads[complete]
        forward = forward[complete]
    if len(quads) == 0:
        return []
    # "forward" marks the edges whose inner end is the lower one: there the outside (and thus
    # the surface normal) is located in the positive direction of the current axis
    flipped = np.where(forward[:, None], quads, quads[:, ::-1])
    return [np.stack((flipped[:, 0], flipped[:, 1], flipped[:, 2]), axis=1),
            np.stack((flipped[:, 0], flipped[:, 2], flipped[:, 3]), axis=1)]
