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


The complete way from a set of photos to a triangle mesh.

  photos -> silhouettes -> voxel carving -> iso surface -> smoothing -> STL
"""

import os

import numpy as np

from pycam.errors import InvalidDataError
from pycam.Photogrammetry.carving import carve_refined
from pycam.Photogrammetry.images import load_image, resize_to_max, save_image
from pycam.Photogrammetry.session import load_session
from pycam.Photogrammetry.silhouette import SilhouetteConfig, extract_mask, mask_quality
from pycam.Photogrammetry.surfacenets import extract_surface, smooth_field
import pycam.Utils.log

log = pycam.Utils.log.get_logger()


class ReconstructionConfig:
    """ all tunable parameters of the reconstruction """

    def __init__(self, resolution=160, coarse_resolution=48, max_image_size=900,
                 silhouette=None, max_missing_views=0, outside_is_background=True,
                 field_smoothing=1, mesh_smoothing=2, remove_small_parts=True,
                 object_size=None, center_model=True, debug_directory=None):
        self.resolution = int(resolution)
        self.coarse_resolution = int(coarse_resolution)
        self.max_image_size = None if max_image_size is None else int(max_image_size)
        self.silhouette = silhouette or SilhouetteConfig()
        self.max_missing_views = int(max_missing_views)
        self.outside_is_background = bool(outside_is_background)
        self.field_smoothing = int(field_smoothing)
        self.mesh_smoothing = int(mesh_smoothing)
        self.remove_small_parts = bool(remove_small_parts)
        self.object_size = None if object_size is None else float(object_size)
        self.center_model = bool(center_model)
        self.debug_directory = debug_directory

    def as_dict(self):
        data = {key: value for key, value in vars(self).items() if key != "silhouette"}
        data["silhouette"] = self.silhouette.as_dict()
        return data


class ReconstructionResult:
    """ the outcome of a reconstruction """

    def __init__(self, mesh, grid, cameras, masks, warnings=None, statistics=None):
        self.mesh = mesh
        self.grid = grid
        self.cameras = cameras
        self.masks = masks
        self.warnings = list(warnings or [])
        self.statistics = dict(statistics or {})

    def write_stl(self, filename, **kwargs):
        return self.mesh.write_stl(filename, **kwargs)

    def describe(self):
        lines = [self.mesh.describe()]
        for warning in self.warnings:
            lines.append("warning: {}".format(warning))
        return "\n".join(lines)


def _report(progress, message, ratio):
    log.debug("photogrammetry: %s (%d%%)", message, round(100 * ratio))
    if progress is not None:
        progress(message, ratio)


def prepare_masks(image_paths, background_path=None, config=None, progress=None):
    """ load all photos and reduce them to silhouettes

    @returns: a tuple of the mask list, the image size (width, height) and a list of warnings
    """
    config = config or ReconstructionConfig()
    background = None
    if background_path:
        background, _ = resize_to_max(load_image(background_path), config.max_image_size)
    masks = []
    warnings = []
    size = None
    if config.debug_directory:
        os.makedirs(os.path.expanduser(config.debug_directory), exist_ok=True)
    for index, path in enumerate(image_paths):
        image, _ = resize_to_max(load_image(path), config.max_image_size)
        if size is None:
            size = (image.shape[1], image.shape[0])
        elif (image.shape[1], image.shape[0]) != size:
            raise InvalidDataError("all photos must have the same size: {} differs ({} != {})"
                                   .format(path, (image.shape[1], image.shape[0]), size))
        mask = extract_mask(image, background=background, config=config.silhouette)
        quality = mask_quality(mask)
        if quality["area_fraction"] <= 0:
            warnings.append("no object was detected in '{}'".format(os.path.basename(path)))
        elif quality["area_fraction"] > 0.9:
            warnings.append("the silhouette covers almost the whole photo '{}' - check the "
                            "background separation".format(os.path.basename(path)))
        elif quality["touches_border"]:
            warnings.append("the object touches the border of '{}' - parts of it may be missing"
                            .format(os.path.basename(path)))
        masks.append(mask)
        if config.debug_directory:
            debug_name = "mask_{:03d}_{}.png".format(index,
                                                     os.path.splitext(
                                                         os.path.basename(path))[0])
            save_image(os.path.join(os.path.expanduser(config.debug_directory), debug_name), mask)
        _report(progress, "analyzing photo {}/{}".format(index + 1, len(image_paths)),
                0.3 * (index + 1) / max(len(image_paths), 1))
    return masks, size, warnings


def reconstruct(session, config=None, progress=None):
    """ turn a capture session into a triangle mesh

    @param session: a CaptureSession
    @param config: an optional ReconstructionConfig
    @param progress: an optional callable receiving a message and a completion ratio
    @returns: a ReconstructionResult
    """
    config = config or ReconstructionConfig()
    if len(session) < 2:
        raise InvalidDataError("at least two photos are required for a reconstruction (got {})"
                               .format(len(session)))
    masks, size, warnings = prepare_masks(session.image_paths, session.background_path,
                                          config=config, progress=progress)
    cameras = session.get_cameras(*size)
    usable = [index for index, mask in enumerate(masks) if mask.any()]
    if len(usable) < 2:
        raise InvalidDataError("the object could not be separated from the background - please "
                               "check the lighting or capture a reference photo of the empty "
                               "turntable")
    if len(usable) < len(masks):
        warnings.append("{} of {} photos were ignored, since no object was detected"
                        .format(len(masks) - len(usable), len(masks)))
    used_masks = [masks[index] for index in usable]
    used_cameras = [cameras[index] for index in usable]
    low, high = session.rig.bounds
    result = reconstruct_from_masks(used_cameras, used_masks, low, high, config=config,
                                    progress=progress, warnings=warnings)
    result.statistics["photos"] = len(masks)
    result.statistics["used_photos"] = len(usable)
    return result


def reconstruct_from_masks(cameras, masks, low, high, config=None, progress=None, warnings=None):
    """ carve the visual hull of the given silhouettes and convert it into a mesh """
    config = config or ReconstructionConfig()
    warnings = list(warnings or [])
    masks = [np.asarray(mask, dtype=bool) for mask in masks]
    shapes = {mask.shape for mask in masks}
    if len(shapes) > 1:
        raise InvalidDataError("all silhouettes must have the same size: {}".format(shapes))
    _report(progress, "carving the volume", 0.35)

    def carving_progress(message, ratio):
        _report(progress, message, 0.35 + 0.45 * ratio)

    grid = carve_refined(cameras, masks, low, high, resolution=config.resolution,
                         coarse_resolution=config.coarse_resolution,
                         max_missing_views=config.max_missing_views,
                         outside_is_background=config.outside_is_background,
                         progress=carving_progress)
    if grid.count == 0:
        raise InvalidDataError("the silhouettes do not overlap - please verify the turntable "
                               "angles and the camera distance of the capture setup")
    warnings.extend(_check_volume_usage(grid))
    _report(progress, "building the surface", 0.85)
    # an empty margin around the volume keeps the resulting surface closed
    padded = grid.padded(2)
    field = smooth_field(padded.as_field(), config.field_smoothing)
    mesh = extract_surface(field, iso=0.5, origin=padded.origin + 0.5 * padded.spacing,
                           spacing=padded.spacing)
    if mesh.is_empty:
        raise InvalidDataError("no surface could be extracted from the carved volume")
    if config.remove_small_parts:
        mesh = mesh.remove_small_components(keep=1)
    if config.mesh_smoothing > 0:
        _report(progress, "smoothing the model", 0.92)
        mesh = mesh.smoothed(config.mesh_smoothing)
    if config.object_size:
        mesh = mesh.scaled_to_size(config.object_size, axes=(0, 1))
    if config.center_model:
        mesh = mesh.centered_on_origin()
    _report(progress, "finished", 1.0)
    statistics = {"voxels": grid.count, "voxel_size": float(grid.spacing.max()),
                  "triangles": len(mesh.faces), "views": len(cameras)}
    return ReconstructionResult(mesh, grid, cameras, masks, warnings, statistics)


def _check_volume_usage(grid):
    """ warn if the object seems to be bigger than the volume that was searched """
    warnings = []
    occupancy = grid.occupancy
    faces = {"-X": occupancy[0], "+X": occupancy[-1], "-Y": occupancy[:, 0],
             "+Y": occupancy[:, -1], "+Z": occupancy[:, :, -1]}
    touching = sorted(name for name, plane in faces.items() if plane.any())
    if touching:
        warnings.append("the model reaches the border of the search volume ({}) - increase the "
                        "object diameter or height".format(", ".join(touching)))
    filled = grid.count / occupancy.size
    if filled > 0.5:
        warnings.append("more than half of the search volume is filled - the silhouettes are "
                        "probably too big or the camera distance is wrong")
    return warnings


def reconstruct_session(directory, config=None, progress=None):
    """ load a capture session from a directory and reconstruct it """
    return reconstruct(load_session(directory), config=config, progress=progress)
