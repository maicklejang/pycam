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


A tiny software renderer for previewing a scan without OpenGL.

The result is a plain RGB array: it can be shown in the graphical application, written to an
image file or simply ignored.
"""

import math
import os
import tempfile

import numpy as np

BACKGROUND_COLOR = (28, 30, 36)
OBJECT_COLOR = (235, 225, 205)


def _view_matrix(azimuth, elevation):
    """ return a rotation matrix for an orbiting camera (angles in degrees) """
    azimuth = math.radians(azimuth)
    elevation = math.radians(elevation)
    forward = np.array((math.cos(elevation) * math.cos(azimuth),
                        math.cos(elevation) * math.sin(azimuth),
                        math.sin(elevation)))
    right = np.cross(forward, (0.0, 0.0, 1.0))
    if np.linalg.norm(right) < 1e-9:
        right = np.array((0.0, 1.0, 0.0))
    right /= np.linalg.norm(right)
    down = np.cross(forward, right)
    return np.vstack((right, down, forward))


def render_points(points, normals=None, azimuth=35.0, elevation=25.0, size=(420, 420),
                  point_size=None, background=BACKGROUND_COLOR, color=OBJECT_COLOR):
    """ draw a point cloud with a depth buffer and simple shading

    @param points: the coordinates to be drawn (shape: N x 3)
    @param normals: optional surface normals used for shading (shape: N x 3)
    @param point_size: the size of a single sample in pixels (default: automatic)
    @returns: an RGB array of bytes
    """
    width, height = int(size[0]), int(size[1])
    image = np.zeros((height, width, 3), dtype=np.uint8)
    image[:] = np.asarray(background, dtype=np.uint8)
    points = np.asarray(points, dtype=float).reshape(-1, 3)
    if len(points) == 0:
        return image
    rotation = _view_matrix(azimuth, elevation)
    local = (points - points.mean(axis=0)) @ rotation.T
    if normals is not None:
        normals = np.asarray(normals, dtype=float).reshape(-1, 3) @ rotation.T
        # drop the samples on the back of the model - otherwise they shine through the gaps
        front = normals[:, 2] < 0
        if front.any():
            local = local[front]
            normals = normals[front]
    span = float(np.abs(local[:, :2]).max()) * 2.0
    if span < 1e-9:
        return image
    if point_size is None:
        # sparse point clouds need bigger dots in order to cover the surface
        point_size = 1 if len(points) > 0.7 * width * height else 2
    scale = 0.85 * min(width, height) / span
    columns = np.clip((local[:, 0] * scale + width / 2).astype(int), 0, width - 1)
    rows = np.clip((local[:, 1] * scale + height / 2).astype(int), 0, height - 1)
    depth = local[:, 2]
    if normals is not None:
        light = np.asarray((-0.4, -0.5, -0.75))
        light = light / np.linalg.norm(light)
        shading = np.clip(normals @ light, 0.0, 1.0)
        brightness = 0.25 + 0.75 * shading
    else:
        # without normals the depth defines the brightness (near = bright)
        low, high = depth.min(), depth.max()
        brightness = 1.0 - 0.7 * ((depth - low) / max(high - low, 1e-9))
    # painter's algorithm: draw the distant samples first, so that near ones cover them
    flat = rows * width + columns
    order = np.argsort(-depth)
    colors = np.asarray(color, dtype=float)[None, :] * brightness[order][:, None]
    target = image.reshape(-1, 3)
    target[flat[order]] = np.clip(colors, 0, 255).astype(np.uint8)
    if point_size > 1:
        image = _grow(image, np.asarray(background, dtype=np.uint8), int(point_size) - 1)
    return image


def render_mesh(mesh, **kwargs):
    """ draw a mesh by rendering the centers of its triangles """
    if mesh.is_empty:
        return render_points(np.zeros((0, 3)), **kwargs)
    centers = mesh.triangle_corners.mean(axis=1)
    # the averaged vertex normals avoid the speckled look of the raw triangle normals
    normals = mesh.vertex_normals(smoothing=2)[mesh.faces].mean(axis=1)
    return render_points(centers, normals=normals, **kwargs)


def render_grid(grid, **kwargs):
    """ draw the occupied voxels of a carved volume """
    indices = np.nonzero(grid.occupancy.reshape(-1))[0]
    return render_points(grid.centers(indices), **kwargs)


def _grow(image, background, radius):
    """ enlarge the drawn points by a few pixels """
    result = image.copy()
    for _ in range(radius):
        for axis in (0, 1):
            for shift in (-1, 1):
                shifted = np.roll(result, shift, axis=axis)
                empty = (result == background).all(axis=2)
                filled = ~(shifted == background).all(axis=2)
                replace = empty & filled
                result[replace] = shifted[replace]
    return result


def to_ppm(image):
    """ encode an RGB array as a PPM image (the format understood by Tk) """
    image = np.asarray(image, dtype=np.uint8)
    header = "P6\n{} {}\n255\n".format(image.shape[1], image.shape[0]).encode("ascii")
    return header + image.tobytes()


def to_tk_image(image):
    """ convert an RGB array into a tkinter.PhotoImage """
    import tkinter
    data = to_ppm(image)
    try:
        return tkinter.PhotoImage(data=data)
    except tkinter.TclError:
        # some Tk versions accept image data only via a file
        handle, filename = tempfile.mkstemp(suffix=".ppm")
        try:
            os.write(handle, data)
            os.close(handle)
            return tkinter.PhotoImage(file=filename)
        finally:
            os.unlink(filename)
