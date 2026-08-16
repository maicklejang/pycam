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


The command line interface of the photo scanner ("pycam-photo3d").
"""

import argparse
import logging
import os
import sys

import pycam.errors
from pycam.Photogrammetry.camera import turntable_angles, turntable_cameras
from pycam.Photogrammetry.pipeline import ReconstructionConfig, reconstruct
from pycam.Photogrammetry.session import (CaptureSession, DEFAULT_FIELD_OF_VIEW, SESSION_FILENAME,
                                          TurntableRig, load_session, session_from_directory)
from pycam.Photogrammetry.silhouette import MASK_METHODS, SilhouetteConfig
import pycam.Utils.log

_log = pycam.Utils.log.get_logger()

LOG_LEVELS = {"debug": logging.DEBUG, "info": logging.INFO, "warning": logging.WARNING,
              "error": logging.ERROR}

DESCRIPTION = """
Create a 3D model from a series of photos.

Put the object onto a turntable, take a photo after every step of the rotation and let this
tool intersect the silhouettes of all photos ("shape from silhouette").  The result is a
watertight STL file that can be used for toolpath generation with PyCAM.
"""

EPILOG = """
example:
  pycam-photo3d demo --output pawn.stl
  pycam-photo3d prepare ~/scans/cup --object-diameter 90 --object-height 100
  pycam-photo3d reconstruct ~/scans/cup --output cup.stl --resolution 200
"""


def _add_rig_arguments(parser):
    group = parser.add_argument_group("capture setup (all lengths in millimeters)")
    group.add_argument("--distance", type=float,
                       help="horizontal distance between camera and rotation axis")
    group.add_argument("--height", type=float, help="height of the camera above the turntable")
    group.add_argument("--target-z", type=float,
                       help="height of the point that the camera is aimed at")
    group.add_argument("--clockwise", action="store_true",
                       help="the turntable rotates clockwise (seen from above)")
    group.add_argument("--object-diameter", type=float, default=120.0,
                       help="diameter of the volume that is searched for the object")
    group.add_argument("--object-height", type=float, default=120.0,
                       help="height of the volume that is searched for the object")
    group.add_argument("--fov", type=float, default=DEFAULT_FIELD_OF_VIEW,
                       help="horizontal field of view of the camera in degrees")


def _add_reconstruction_arguments(parser):
    group = parser.add_argument_group("reconstruction")
    group.add_argument("--resolution", type=int, default=160,
                       help="number of voxels along the longest axis (higher = more detail)")
    group.add_argument("--max-image-size", type=int, default=900,
                       help="photos are shrunk to this size before they are analyzed")
    group.add_argument("--method", choices=MASK_METHODS, default="auto",
                       help="how the object is separated from the background")
    group.add_argument("--threshold", type=float,
                       help="fixed separation threshold (default: determined automatically)")
    group.add_argument("--max-missing-views", type=int, default=0,
                       help="how many photos may miss the object before a voxel is removed")
    group.add_argument("--smoothing", type=int, default=2,
                       help="number of mesh smoothing passes")
    group.add_argument("--object-size", type=float,
                       help="scale the result until its largest horizontal extent matches this")
    group.add_argument("--keep-position", action="store_true",
                       help="do not move the result onto the center of the X/Y plane")
    group.add_argument("--allow-cropped-photos", action="store_true",
                       help="the object may extend beyond the border of the photos")
    group.add_argument("--debug-directory",
                       help="write the detected silhouettes into this directory")
    group.add_argument("--preview",
                       help="write a rendered image of the result into this file")


def _get_rig(args):
    return TurntableRig(distance=args.distance, height=args.height, target_z=args.target_z,
                        clockwise=args.clockwise, object_diameter=args.object_diameter,
                        object_height=args.object_height)


def _get_config(args):
    silhouette = SilhouetteConfig(method=args.method, threshold=args.threshold)
    return ReconstructionConfig(resolution=args.resolution,
                                max_image_size=args.max_image_size,
                                silhouette=silhouette,
                                max_missing_views=args.max_missing_views,
                                outside_is_background=not args.allow_cropped_photos,
                                mesh_smoothing=args.smoothing,
                                object_size=args.object_size,
                                center_model=not args.keep_position,
                                debug_directory=args.debug_directory)


def _progress_printer(quiet=False):
    if quiet:
        return None
    state = {"message": None}

    def report(message, ratio):
        if message != state["message"]:
            state["message"] = message
            print("[{:3d}%] {}".format(int(round(100 * ratio)), message), file=sys.stderr)

    return report


def _write_result(result, output, ascii_stl=False, preview_file=None):
    output = os.path.expanduser(output)
    directory = os.path.dirname(os.path.abspath(output))
    if directory:
        os.makedirs(directory, exist_ok=True)
    if output.lower().endswith(".obj"):
        result.mesh.write_obj(output)
    else:
        result.mesh.write_stl(output, binary=not ascii_stl)
    if preview_file:
        from pycam.Photogrammetry.images import save_image
        from pycam.Photogrammetry.preview import render_mesh
        preview_file = os.path.expanduser(preview_file)
        save_image(preview_file, render_mesh(result.mesh))
        print("preview: {}".format(preview_file))
    print("model: {}".format(result.mesh.describe()))
    for warning in result.warnings:
        print("warning: {}".format(warning), file=sys.stderr)
    print("written to {}".format(output))


def _load_or_build_session(directory, args):
    """ accept both a prepared session directory and a plain directory of photos """
    directory = os.path.expanduser(directory)
    if os.path.isfile(os.path.join(directory, SESSION_FILENAME)):
        session = load_session(directory)
        # command line arguments override the stored setup
        if args.distance is not None:
            session.rig.distance = args.distance
        if args.height is not None:
            session.rig.height = args.height
        if args.target_z is not None:
            session.rig.target_z = args.target_z
        return session
    return session_from_directory(directory, sweep=args.sweep, background=args.background,
                                  rig=_get_rig(args), field_of_view=args.fov)


def _command_prepare(args):
    session = session_from_directory(args.directory, sweep=args.sweep, start_angle=args.start,
                                     background=args.background, rig=_get_rig(args),
                                     field_of_view=args.fov)
    filename = session.save()
    print("{} photos, angles {:.1f} .. {:.1f} degrees"
          .format(len(session), session.angles[0], session.angles[-1]))
    print("written to {}".format(filename))
    return 0


def _command_reconstruct(args):
    session = _load_or_build_session(args.directory, args)
    result = reconstruct(session, config=_get_config(args), progress=_progress_printer(args.quiet))
    _write_result(result, args.output, args.ascii, args.preview)
    return 0


def _command_capture(args):
    from pycam.Photogrammetry.capture import CameraDevice, CaptureController, sharpness
    session = CaptureSession(args.directory, rig=_get_rig(args), field_of_view=args.fov)
    controller = CaptureController(session=session)
    angles = turntable_angles(args.count, sweep=args.sweep)
    with CameraDevice(index=args.device, width=args.width,
                      height=args.height_pixels) as device:
        if not args.no_background:
            input("Remove the object from the turntable and press ENTER ...")
            image = device.grab_stable()
            controller.store_background(image)
            print("reference photo stored (sharpness: {:.0f})".format(sharpness(image)))
        input("Put the object onto the turntable and press ENTER ...")
        for index, angle in enumerate(angles):
            if index > 0:
                input("Turn the table to {:.1f} degrees and press ENTER ..."
                      .format(angle % 360.0))
            image = device.grab_stable()
            filename = controller.store_shot(image, angle)
            print("{}/{}: {} (sharpness: {:.0f})"
                  .format(index + 1, len(angles), os.path.basename(filename), sharpness(image)))
    print("written to {}".format(controller.save()))
    if args.reconstruct:
        result = reconstruct(controller.session, config=_get_config(args),
                             progress=_progress_printer(args.quiet))
        _write_result(result, args.output, args.ascii, args.preview)
    return 0


def _command_devices(args):
    from pycam.Photogrammetry.capture import list_devices
    devices = list_devices(args.maximum)
    if not devices:
        print("no camera was found", file=sys.stderr)
        return 1
    for index in devices:
        print("camera {}".format(index))
    return 0


def _command_calibrate(args):
    from pycam.Photogrammetry.calibration import calibrate_from_images
    from pycam.Photogrammetry.images import list_images
    pattern = tuple(int(part) for part in args.pattern.lower().split("x"))
    if len(pattern) != 2:
        raise pycam.errors.InvalidDataError(
            "the chessboard pattern must look like '9x6': {}".format(args.pattern))
    intrinsics, error, used = calibrate_from_images(list_images(args.directory), pattern,
                                                    args.square_size)
    print("{} photos used, reprojection error: {:.3f} pixels".format(used, error))
    print("{} (horizontal field of view: {:.1f} degrees)"
          .format(intrinsics, intrinsics.horizontal_fov))
    if args.session:
        session = load_session(args.session)
        session.intrinsics = intrinsics
        print("stored in {}".format(session.save()))
    return 0


def _command_demo(args):
    from pycam.Photogrammetry import synthetic
    from pycam.Photogrammetry.camera import CameraIntrinsics
    from pycam.Photogrammetry.pipeline import reconstruct_from_masks
    rig = _get_rig(args)
    intrinsics = CameraIntrinsics.from_fov(args.width, args.height_pixels, args.fov)
    cameras = turntable_cameras(intrinsics, turntable_angles(args.count), distance=rig.distance,
                                height=rig.height, target_z=rig.target_z,
                                clockwise=rig.clockwise)
    shape = synthetic.demo_object(height=args.object_height * 0.75,
                                  base_radius=args.object_diameter * 0.25)
    points = synthetic.sample_solid(shape, *rig.bounds)
    masks = synthetic.render_masks(cameras, points)
    print("{} virtual photos of a pawn shaped object".format(len(masks)))
    if args.write_photos:
        _write_demo_photos(args, masks, rig)
    result = reconstruct_from_masks(cameras, masks, *rig.bounds, config=_get_config(args),
                                    progress=_progress_printer(args.quiet))
    _write_result(result, args.output, args.ascii, args.preview)
    return 0


def _write_demo_photos(args, masks, rig):
    from pycam.Photogrammetry import synthetic
    from pycam.Photogrammetry.capture import CaptureController
    controller = CaptureController(session=CaptureSession(args.write_photos, rig=rig,
                                                          field_of_view=args.fov))
    for image, angle in zip(synthetic.render_photos(masks), turntable_angles(args.count)):
        controller.store_shot(image, angle)
    print("virtual photos written to {}".format(controller.save()))


def _command_gui(args):
    from pycam.Photogrammetry.gui import run_gui
    return run_gui(directory=args.directory)


def get_parser():
    parser = argparse.ArgumentParser(
        prog="pycam-photo3d", description=DESCRIPTION, epilog=EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--log-level", choices=sorted(LOG_LEVELS.keys()), default="warning",
                        help="choose the verbosity of log messages")
    parser.add_argument("--version", action="version", version="%(prog)s {}".format(_version()))
    parser.add_argument("-q", "--quiet", action="store_true", help="do not report the progress")
    commands = parser.add_subparsers(dest="command", metavar="COMMAND")

    capture = commands.add_parser("capture", help="take photos with a connected camera")
    capture.add_argument("directory", help="directory for the photos of this object")
    capture.add_argument("--device", type=int, default=0, help="index of the camera")
    capture.add_argument("--count", type=int, default=24, help="number of photos")
    capture.add_argument("--sweep", type=float, default=360.0,
                         help="total rotation angle of the turntable")
    capture.add_argument("--width", type=int, help="requested camera width in pixels")
    capture.add_argument("--height-pixels", type=int, dest="height_pixels",
                         help="requested camera height in pixels")
    capture.add_argument("--no-background", action="store_true",
                         help="skip the reference photo of the empty turntable")
    capture.add_argument("--reconstruct", action="store_true",
                         help="reconstruct the model right after the capture")
    capture.add_argument("--output", "-o", default="scan.stl", help="output file")
    capture.add_argument("--ascii", action="store_true", help="write an ASCII STL file")
    _add_rig_arguments(capture)
    _add_reconstruction_arguments(capture)
    capture.set_defaults(func=_command_capture)

    prepare = commands.add_parser("prepare",
                                  help="describe a directory of photos as a capture session")
    prepare.add_argument("directory", help="directory containing the photos")
    prepare.add_argument("--sweep", type=float, default=360.0,
                         help="total rotation angle covered by the photos")
    prepare.add_argument("--start", type=float, default=0.0, help="angle of the first photo")
    prepare.add_argument("--background", help="photo of the empty turntable")
    _add_rig_arguments(prepare)
    prepare.set_defaults(func=_command_prepare)

    build = commands.add_parser("reconstruct", help="create a 3D model from photos")
    build.add_argument("directory", help="a capture session or a directory of photos")
    build.add_argument("--output", "-o", default="scan.stl", help="output file (.stl or .obj)")
    build.add_argument("--ascii", action="store_true", help="write an ASCII STL file")
    build.add_argument("--sweep", type=float, default=360.0,
                       help="total rotation angle (only used without a session file)")
    build.add_argument("--background", help="photo of the empty turntable")
    _add_rig_arguments(build)
    _add_reconstruction_arguments(build)
    build.set_defaults(func=_command_reconstruct)

    devices = commands.add_parser("devices", help="list the available cameras")
    devices.add_argument("--maximum", type=int, default=6, help="highest camera index to probe")
    devices.set_defaults(func=_command_devices)

    calibrate = commands.add_parser("calibrate", help="calibrate a camera with a chessboard")
    calibrate.add_argument("directory", help="directory with photos of a chessboard")
    calibrate.add_argument("--pattern", default="9x6",
                           help="number of inner corners of the chessboard")
    calibrate.add_argument("--square-size", type=float, default=1.0,
                           help="edge length of a single square")
    calibrate.add_argument("--session", help="store the result in this capture session")
    calibrate.set_defaults(func=_command_calibrate)

    demo = commands.add_parser("demo", help="reconstruct a virtual object (no camera needed)")
    demo.add_argument("--count", type=int, default=24, help="number of virtual photos")
    demo.add_argument("--width", type=int, default=640, help="width of the virtual photos")
    demo.add_argument("--height-pixels", type=int, dest="height_pixels", default=480,
                      help="height of the virtual photos")
    demo.add_argument("--output", "-o", default="demo.stl", help="output file")
    demo.add_argument("--ascii", action="store_true", help="write an ASCII STL file")
    demo.add_argument("--write-photos", help="store the virtual photos as a capture session")
    _add_rig_arguments(demo)
    _add_reconstruction_arguments(demo)
    demo.set_defaults(func=_command_demo)

    gui = commands.add_parser("gui", help="start the graphical scanner application")
    gui.add_argument("directory", nargs="?", help="directory of an existing capture session")
    gui.set_defaults(func=_command_gui)
    return parser


def _version():
    try:
        from pycam import VERSION
    except ImportError:
        return "unknown"
    return VERSION


def main_func(arguments=None):
    parser = get_parser()
    args = parser.parse_args(arguments)
    if not getattr(args, "command", None):
        parser.print_help()
        return 1
    _log.setLevel(LOG_LEVELS[args.log_level])
    try:
        return args.func(args) or 0
    except pycam.errors.PycamBaseException as exc:
        print("error: {}".format(exc), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("aborted", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main_func())
