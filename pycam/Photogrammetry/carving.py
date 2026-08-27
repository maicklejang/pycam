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


Space carving: intersect the silhouettes of all photos inside a voxel volume.

Every photo defines a cone that starts at the camera and contains the object.  A voxel belongs
to the object only if it is inside of every one of these cones.  The remaining voxels form the
"visual hull" of the object.
"""

import numpy as np

# process at most this many voxels per projection step (keeps the memory usage predictable)
_CHUNK_SIZE = 1 << 20


class VoxelGrid:
    """ a regular grid of voxels with a boolean occupancy flag """

    def __init__(self, origin, spacing, occupancy):
        self.origin = np.asarray(origin, dtype=float).reshape(3)
        self.spacing = np.broadcast_to(np.asarray(spacing, dtype=float), (3,)).astype(float)
        self.occupancy = np.asarray(occupancy, dtype=bool)
        if self.occupancy.ndim != 3:
            raise ValueError("the occupancy volume must be three dimensional: {}"
                             .format(self.occupancy.shape))

    @classmethod
    def from_bounds(cls, low, high, resolution):
        """ create a filled grid covering the given box with about "resolution" voxels per axis

        The resolution refers to the longest axis of the box - the voxels are always cubes.
        """
        low = np.asarray(low, dtype=float).reshape(3)
        high = np.asarray(high, dtype=float).reshape(3)
        if np.any(high <= low):
            raise ValueError("the volume must have a positive extent: {} .. {}".format(low, high))
        resolution = max(int(resolution), 2)
        spacing = float((high - low).max()) / resolution
        counts = np.maximum(np.ceil((high - low) / spacing).astype(int), 2)
        return cls(low, spacing, np.ones(tuple(counts), dtype=bool))

    @property
    def shape(self):
        return self.occupancy.shape

    @property
    def count(self):
        return int(self.occupancy.sum())

    @property
    def voxel_volume(self):
        return float(np.prod(self.spacing))

    @property
    def volume(self):
        return self.count * self.voxel_volume

    @property
    def bounds(self):
        return self.origin, self.origin + self.spacing * np.array(self.shape)

    def centers(self, indices=None):
        """ return the world coordinates of the voxel centers

        @param indices: optional flat indices of the requested voxels (defaults to all)
        """
        if indices is None:
            indices = np.arange(self.occupancy.size)
        grid_indices = np.stack(np.unravel_index(indices, self.shape), axis=1)
        return self.origin + (grid_indices + 0.5) * self.spacing

    def occupied_bounds(self, margin=1):
        """ return the bounding box of all occupied voxels (enlarged by "margin" voxels) """
        if not self.occupancy.any():
            return None
        low_index = []
        high_index = []
        for axis in range(3):
            others = tuple(other for other in range(3) if other != axis)
            hits = np.nonzero(self.occupancy.any(axis=others))[0]
            low_index.append(max(int(hits[0]) - margin, 0))
            high_index.append(min(int(hits[-1]) + 1 + margin, self.shape[axis]))
        low = self.origin + np.array(low_index) * self.spacing
        high = self.origin + np.array(high_index) * self.spacing
        return low, high

    def padded(self, width=2):
        """ return a copy that is surrounded by an empty margin

        This guarantees that objects touching the border of the volume still result in a closed
        surface.
        """
        width = max(int(width), 0)
        if width == 0:
            return VoxelGrid(self.origin, self.spacing, self.occupancy.copy())
        occupancy = np.pad(self.occupancy, width, mode="constant", constant_values=False)
        return VoxelGrid(self.origin - width * self.spacing, self.spacing, occupancy)

    def as_field(self):
        """ return the occupancy as a float volume (1.0 inside, 0.0 outside) """
        return self.occupancy.astype(np.float32)


def _sample_masks(cameras, masks, points, outside_is_background=True):
    """ return for every point the number of silhouettes that contain it """
    votes = np.zeros(len(points), dtype=np.int32)
    for camera, mask in zip(cameras, masks):
        pixels, depth = camera.project(points)
        columns = np.floor(pixels[:, 0]).astype(np.int64)
        rows = np.floor(pixels[:, 1]).astype(np.int64)
        height, width = mask.shape[:2]
        visible = ((depth > 0) & (columns >= 0) & (columns < width)
                   & (rows >= 0) & (rows < height))
        hit = np.zeros(len(points), dtype=bool)
        if visible.any():
            hit[visible] = mask[rows[visible], columns[visible]]
        if not outside_is_background:
            # points outside of the image are not judged by this camera
            hit |= ~visible
        votes += hit
    return votes


def carve(cameras, masks, low, high, resolution=140, max_missing_views=0,
          outside_is_background=True, progress=None):
    """ intersect all silhouette cones inside the given box

    @param cameras: a sequence of Camera objects (one per photo)
    @param masks: a sequence of boolean masks - True marks the object
    @param low: the lower corner of the volume to be carved
    @param high: the upper corner of the volume to be carved
    @param resolution: the number of voxels along the longest axis
    @param max_missing_views: how many photos may disagree before a voxel is removed (increase
        this if some of the silhouettes are unreliable)
    @param outside_is_background: treat the area outside of a photo as background (disable this
        if the object does not fit into every photo)
    @param progress: an optional callable receiving a message and a completion ratio
    @returns: a VoxelGrid
    """
    cameras = list(cameras)
    masks = [np.asarray(mask, dtype=bool) for mask in masks]
    if not cameras:
        raise ValueError("at least one camera is required for carving")
    if len(cameras) != len(masks):
        raise ValueError("the number of cameras ({}) and masks ({}) must be equal"
                         .format(len(cameras), len(masks)))
    grid = VoxelGrid.from_bounds(low, high, resolution)
    max_missing_views = min(int(max_missing_views), len(cameras) - 1)
    if max_missing_views <= 0:
        _carve_strict(grid, cameras, masks, outside_is_background, progress)
    else:
        _carve_with_votes(grid, cameras, masks, max_missing_views, outside_is_background,
                          progress)
    return grid


def _carve_strict(grid, cameras, masks, outside_is_background, progress):
    """ remove every voxel that is missing from at least one silhouette

    The voxels that were removed already are skipped, which makes every additional photo
    cheaper than the previous one.
    """
    flat = grid.occupancy.reshape(-1)
    for index, (camera, mask) in enumerate(zip(cameras, masks)):
        remaining = np.nonzero(flat)[0]
        if len(remaining) == 0:
            break
        for start in range(0, len(remaining), _CHUNK_SIZE):
            chunk = remaining[start:start + _CHUNK_SIZE]
            votes = _sample_masks([camera], [mask], grid.centers(chunk),
                                  outside_is_background=outside_is_background)
            flat[chunk[votes == 0]] = False
        if progress is not None:
            progress("carving view {}/{}".format(index + 1, len(cameras)),
                     (index + 1) / len(cameras))


def _carve_with_votes(grid, cameras, masks, max_missing_views, outside_is_background, progress):
    """ keep voxels that are covered by all but "max_missing_views" silhouettes """
    votes = np.zeros(grid.occupancy.size, dtype=np.int32)
    total = grid.occupancy.size
    for start in range(0, total, _CHUNK_SIZE):
        indices = np.arange(start, min(start + _CHUNK_SIZE, total))
        votes[indices] = _sample_masks(cameras, masks, grid.centers(indices),
                                       outside_is_background=outside_is_background)
        if progress is not None:
            progress("carving", min(start + _CHUNK_SIZE, total) / total)
    required = len(cameras) - max_missing_views
    grid.occupancy = (votes >= required).reshape(grid.shape)


def carve_refined(cameras, masks, low, high, resolution=140, coarse_resolution=48, margin=2,
                  progress=None, **kwargs):
    """ carve twice: a coarse pass locates the object, the fine pass resolves the details

    Restricting the fine pass to the region that actually contains the object increases the
    effective resolution considerably without using more memory.
    """
    def phase(label, start, span):
        if progress is None:
            return None
        return lambda message, ratio: progress("{} ({})".format(message, label),
                                               start + span * ratio)

    coarse_resolution = min(int(coarse_resolution), int(resolution))
    coarse = carve(cameras, masks, low, high, resolution=coarse_resolution,
                   progress=phase("rough pass", 0.0, 0.25), **kwargs)
    refined_bounds = coarse.occupied_bounds(margin=margin)
    if refined_bounds is None:
        # nothing survived the coarse pass - report the empty result instead of guessing
        return coarse
    if coarse_resolution >= resolution:
        return coarse
    return carve(cameras, masks, refined_bounds[0], refined_bounds[1], resolution=resolution,
                 progress=phase("detail pass", 0.25, 0.75), **kwargs)
