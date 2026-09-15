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
from pycam.Photogrammetry.camera import turntable_cameras
from pycam.Photogrammetry.carving import carve, carve_refined
from pycam.Photogrammetry.images import load_image, resize_to_max, save_image
from pycam.Photogrammetry.session import load_session
from pycam.Photogrammetry.silhouette import (choose_method, erode, extract_mask, mask_quality,
                                             score_mask, SilhouetteConfig)
from pycam.Photogrammetry.surfacenets import extract_surface, smooth_field
from pycam.Photogrammetry.texturing import TextureConfig, texture_mesh
import pycam.Utils.log

log = pycam.Utils.log.get_logger()

# the measured aim of the camera is only used if the carved volume explains the silhouettes
TRUSTED_AIM_RATING = 0.9


class ReconstructionConfig:
    """ all tunable parameters of the reconstruction """

    def __init__(self, resolution=160, coarse_resolution=48, max_image_size=900,
                 silhouette=None, max_missing_views=0, outside_is_background=True,
                 field_smoothing=1, mesh_smoothing=2, remove_small_parts=True,
                 object_size=None, center_model=True, debug_directory=None,
                 drop_outlier_views=True, texture=False, texture_config=None, auto_aim=True):
        """ @param drop_outlier_views: ignore the photos whose silhouette does not fit to the
            rest of the series (a single wrong one ruins the whole model, since the carving
            intersects all of them)
        @param texture: also build a texture and the texture coordinates for it
        @param auto_aim: determine the height that the camera was aimed at from the photos,
            unless the capture session states it explicitly
        """
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
        self.drop_outlier_views = bool(drop_outlier_views)
        self.texture = bool(texture)
        self.texture_config = texture_config or TextureConfig()
        self.auto_aim = bool(auto_aim)

    def as_dict(self):
        skipped = ("silhouette", "texture_config")
        data = {key: value for key, value in vars(self).items() if key not in skipped}
        data["silhouette"] = self.silhouette.as_dict()
        data["texture_config"] = self.texture_config.as_dict()
        return data


class PreparedPhotos:
    """ the silhouettes of a session together with everything that was learned about them """

    def __init__(self, masks, size, warnings=None, images=None, method=None, qualities=None):
        self.masks = list(masks)
        self.size = size
        self.warnings = list(warnings or [])
        self.images = images
        self.method = method
        self.qualities = list(qualities or [])

    def __len__(self):
        return len(self.masks)


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

    def write_obj(self, filename, **kwargs):
        return self.mesh.write_obj(filename, **kwargs)

    @property
    def has_texture(self):
        return self.mesh.has_texture

    def describe(self):
        lines = [self.mesh.describe()]
        for warning in self.warnings:
            lines.append("warning: {}".format(warning))
        return "\n".join(lines)


def _report(progress, message, ratio):
    log.debug("photogrammetry: %s (%d%%)", message, round(100 * ratio))
    if progress is not None:
        progress(message, ratio)


def _load_photo(path, config):
    image, _ = resize_to_max(load_image(path), config.max_image_size)
    return image


def _sample_paths(image_paths, count=4):
    """ pick a few photos that are spread over the whole turn """
    if len(image_paths) <= count:
        return list(image_paths)
    positions = np.linspace(0, len(image_paths) - 1, count).round().astype(int)
    return [image_paths[index] for index in sorted(set(positions.tolist()))]


def overlay_mask(image, mask):
    """ draw a silhouette onto its photo - the quickest way of seeing what went wrong """
    result = np.asarray(image, dtype=np.float32)
    if result.ndim == 2:
        result = np.repeat(result[:, :, None], 3, axis=2)
    result = result.copy()
    if mask.any():
        outline = mask & ~erode(mask, 1)
        result[mask] = 0.65 * result[mask] + 0.35 * np.array((0.0, 255.0, 0.0))
        result[outline] = np.array((255.0, 0.0, 0.0))
    return np.clip(result, 0, 255).astype(np.uint8)


def _reject_outlier_views(masks, names, warnings, minimum_views=6):
    """ drop the silhouettes that do not fit to the rest of the series

    The carving intersects all views, so a single silhouette that covers the whole photo - or
    only a corner of it - is enough to turn the model into something unrecognizable.  Such a
    view is much better ignored than trusted.
    """
    areas = np.array([float(mask.sum()) for mask in masks])
    usable = areas > 0
    if int(usable.sum()) < minimum_views:
        return masks
    median = float(np.median(areas[usable]))
    if median <= 0:
        return masks
    suspicious = usable & ((areas > 2.5 * median) | (areas < 0.4 * median))
    if not suspicious.any():
        return masks
    if int(usable.sum() - suspicious.sum()) < minimum_views:
        # if that many views disagree, the setup itself is wrong - keep everything and let
        # the warnings about the result explain the problem
        warnings.append("the silhouettes differ a lot in size - the separation of object and "
                        "background is unreliable")
        return masks
    rejected = [names[index] for index in np.nonzero(suspicious)[0]]
    warnings.append("ignoring {} photo(s) whose silhouette does not fit to the others: {}"
                    .format(len(rejected), ", ".join(rejected)))
    return [np.zeros_like(mask) if bad else mask
            for mask, bad in zip(masks, suspicious)]


def prepare_masks(image_paths, background_path=None, config=None, progress=None,
                  keep_images=False):
    """ load all photos and reduce them to silhouettes

    @param keep_images: also return the (scaled) photos, which are needed for a texture
    @returns: a PreparedPhotos object
    """
    config = config or ReconstructionConfig()
    image_paths = list(image_paths)
    background = None
    if background_path:
        background = _load_photo(background_path, config)
    debug_directory = None
    if config.debug_directory:
        debug_directory = os.path.expanduser(config.debug_directory)
        os.makedirs(debug_directory, exist_ok=True)
    warnings = []
    method = config.silhouette.method
    if method == "auto":
        _report(progress, "choosing the separation method", 0.02)
        samples = [_load_photo(path, config) for path in _sample_paths(image_paths)]
        if background is not None and samples and (background.shape != samples[0].shape):
            warnings.append("the reference photo has a different size than the photos - it is "
                            "ignored")
            background = None
        method, scores = choose_method(samples, background=background,
                                       config=config.silhouette)
        log.info("photogrammetry: separating the object by '%s' %s", method,
                 {name: round(value, 3) for name, value in scores.items()})
        if scores and max(scores.values()) < 0.25:
            warnings.append("none of the separation methods found a convincing object - check "
                            "the debug images and consider a reference photo of the empty "
                            "turntable")
    masks = []
    qualities = []
    images = [] if keep_images else None
    size = None
    for index, path in enumerate(image_paths):
        image = _load_photo(path, config)
        if size is None:
            size = (image.shape[1], image.shape[0])
        elif (image.shape[1], image.shape[0]) != size:
            raise InvalidDataError("all photos must have the same size: {} differs ({} != {})"
                                   .format(path, (image.shape[1], image.shape[0]), size))
        mask = extract_mask(image, background=background, config=config.silhouette,
                            method=method)
        quality = mask_quality(mask)
        quality["score"] = score_mask(mask)
        quality["name"] = os.path.basename(path)
        qualities.append(quality)
        if quality["area_fraction"] <= 0:
            warnings.append("no object was detected in '{}'".format(os.path.basename(path)))
        elif quality["area_fraction"] > 0.9:
            warnings.append("the silhouette covers almost the whole photo '{}' - check the "
                            "background separation".format(os.path.basename(path)))
        elif quality["touches_border"]:
            warnings.append("the object touches the border of '{}' - parts of it may be missing"
                            .format(os.path.basename(path)))
        masks.append(mask)
        if keep_images:
            images.append(image)
        if debug_directory:
            stem = "{:03d}_{}".format(index, os.path.splitext(os.path.basename(path))[0])
            save_image(os.path.join(debug_directory, "mask_" + stem + ".png"), mask)
            save_image(os.path.join(debug_directory, "overlay_" + stem + ".png"),
                       overlay_mask(image, mask))
        _report(progress, "analyzing photo {}/{}".format(index + 1, len(image_paths)),
                0.3 * (index + 1) / max(len(image_paths), 1))
    if config.drop_outlier_views:
        masks = _reject_outlier_views(masks, [item["name"] for item in qualities], warnings)
    if debug_directory:
        _write_debug_report(debug_directory, method, qualities, warnings)
    return PreparedPhotos(masks, size, warnings, images=images, method=method,
                          qualities=qualities)


def _write_debug_report(directory, method, qualities, warnings):
    """ summarize what was found in every photo """
    lines = ["separation method: {}".format(method), "",
             "{:<28s} {:>8s} {:>8s} {:>8s} {:>7s}".format("photo", "area", "fill", "offset",
                                                          "rating")]
    for item in qualities:
        lines.append("{:<28s} {:8.4f} {:8.2f} {:8.2f} {:7.2f}"
                     .format(item["name"][:28], item["area_fraction"], item["fill_ratio"],
                             item["center_offset"], item["score"]))
    if warnings:
        lines.extend(["", "warnings:"])
        lines.extend("  " + warning for warning in warnings)
    with open(os.path.join(directory, "report.txt"), "w") as out_file:
        out_file.write("\n".join(lines) + "\n")


def hull_coverage(grid, cameras, masks):
    """ how much of every silhouette is explained by the carved volume (0 .. 1)

    The carved volume always projects *into* the silhouettes, never beyond them.  How much of
    them it fills is therefore a measure for the agreement between the assumed capture setup
    and the photos.
    """
    from pycam.Photogrammetry.silhouette import close_mask, dilate, fill_holes
    if grid.count == 0:
        return 0.0
    points = grid.centers(np.flatnonzero(grid.occupancy.reshape(-1)))
    ratios = []
    for camera, mask in zip(cameras, masks):
        area = float(mask.sum())
        if area <= 0:
            continue
        pixels, depth = camera.project(points)
        columns = np.floor(pixels[:, 0]).astype(np.int64)
        rows = np.floor(pixels[:, 1]).astype(np.int64)
        visible = ((depth > 0) & (columns >= 0) & (columns < mask.shape[1])
                   & (rows >= 0) & (rows < mask.shape[0]))
        projected = np.zeros(mask.shape, dtype=bool)
        projected[rows[visible], columns[visible]] = True
        # one voxel covers several pixels - close the gaps between their centers
        distance = max(float(np.linalg.norm(camera.center - points.mean(axis=0))), 1e-6)
        radius = int(np.ceil(float(grid.spacing.max()) * camera.intrinsics.fx / distance))
        projected = fill_holes(close_mask(dilate(projected, max(radius, 1)), 1))
        ratios.append(float((projected & mask).sum()) / area)
    return float(np.mean(ratios)) if ratios else 0.0


def estimate_target_z(session, masks, config=None, resolution=52, iterations=4):
    """ find the height that the camera was aimed at

    Nobody measures that angle, and a guess that is a few degrees off tilts the whole model -
    it becomes too high or lopsided.  The camera is assumed to be aimed at the middle of the
    object, as everybody does without thinking about it.  The height of the object is not
    taken from the declared search volume though (which is usually chosen generously), but
    measured on a rough carving, and that measurement is repeated until it agrees with itself.

    @returns: a tuple of the estimated height and the rating of the agreement (0 .. 1).  A
        low rating means that the assumed setup does not explain the photos at all - the
        estimate is then not worth more than the original guess.
    """
    config = config or ReconstructionConfig()
    usable = [index for index, mask in enumerate(masks) if mask.any()]
    if len(usable) < 3:
        return None, 0.0
    masks = [masks[index] for index in usable]
    angles = [session.angles[index] for index in usable]
    height, width = masks[0].shape
    intrinsics = session.get_intrinsics(width, height)
    low, high = session.rig.bounds
    rig = session.rig
    target = rig.effective_target_z
    grid = None
    cameras = None
    for _ in range(max(int(iterations), 1)):
        cameras = turntable_cameras(intrinsics, angles, distance=rig.distance,
                                    height=rig.height, target_z=target,
                                    clockwise=rig.clockwise)
        grid = carve(cameras, masks, low, high, resolution=resolution,
                     max_missing_views=config.max_missing_views,
                     outside_is_background=config.outside_is_background)
        box = grid.occupied_bounds(margin=0)
        if box is None:
            return None, 0.0
        measured = float(box[1][2] - box[0][2])
        if measured <= 0:
            return None, 0.0
        log.debug("photogrammetry: aiming at %.1f gives an object of %.1f mm", target, measured)
        if abs(measured / 2.0 - target) <= 0.01 * rig.object_height:
            break
        # move only a part of the way, so that the estimate cannot start oscillating
        target += 0.7 * (measured / 2.0 - target)
    return float(target), hull_coverage(grid, cameras, masks)


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
    prepared = prepare_masks(session.image_paths, session.background_path, config=config,
                             progress=progress, keep_images=config.texture)
    masks = prepared.masks
    warnings = prepared.warnings
    if config.auto_aim and (session.rig.target_z is None):
        _report(progress, "locating the camera", 0.32)
        estimate, rating = estimate_target_z(session, masks, config)
        log.info("photogrammetry: the camera seems to aim at z=%s (rating %.2f)",
                 "?" if estimate is None else round(estimate, 1), rating)
        if (estimate is not None) and (rating >= TRUSTED_AIM_RATING):
            assumed = session.rig.effective_target_z
            session = session.with_target_z(estimate)
            if abs(estimate - assumed) > 0.05 * max(session.rig.object_height, 1.0):
                warnings.append("the camera seems to be aimed at {:.0f} mm above the turntable "
                                "instead of {:.0f} mm - add '--target-z {:.0f}' to keep this "
                                "value".format(estimate, assumed, estimate))
        elif estimate is not None:
            # the silhouettes cannot be explained by any aim of the camera: something else is
            # wrong, and guessing the angle would only add a second error
            warnings.append("the assumed capture setup explains only {:.0f} % of the "
                            "silhouettes - please check --distance, --height and --fov"
                            .format(100 * rating))
    cameras = session.get_cameras(*prepared.size)
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
    used_images = None
    if prepared.images is not None:
        used_images = [prepared.images[index] for index in usable]
    low, high = session.rig.bounds
    result = reconstruct_from_masks(used_cameras, used_masks, low, high, config=config,
                                    progress=progress, warnings=warnings, images=used_images)
    result.statistics["photos"] = len(masks)
    result.statistics["used_photos"] = len(usable)
    result.statistics["method"] = prepared.method
    return result


def reconstruct_from_masks(cameras, masks, low, high, config=None, progress=None, warnings=None,
                           images=None):
    """ carve the visual hull of the given silhouettes and convert it into a mesh

    @param images: the photos belonging to the silhouettes - only needed for a texture
    """
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
    if config.texture:
        if images is None:
            warnings.append("no texture was built, since the photos are not available here")
        else:
            def texture_progress(message, ratio):
                _report(progress, message, 0.94 + 0.05 * ratio)

            # the texture is painted while the model still stands where it was photographed
            mesh = texture_mesh(mesh, cameras, images, masks=masks, grid=grid,
                                config=config.texture_config, progress=texture_progress)
    if config.object_size:
        mesh = mesh.scaled_to_size(config.object_size, axes=(0, 1))
    if config.center_model:
        mesh = mesh.centered_on_origin()
    if not mesh.is_watertight():
        # this happens where the carved volume touches itself along an edge only - the model
        # is usable, but a slicer may complain about it
        warnings.append("the surface of the model is not completely closed - a slightly "
                        "different --resolution usually avoids that")
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
