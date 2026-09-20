"""Command line interface of the docscan document scanner.

Copyright 2026 PyCAM contributors

This file is part of the docscan document scanner.  It is free software:
you can redistribute it and/or modify it under the terms of the GNU General
Public License as published by the Free Software Foundation, either version 3
of the License, or (at your option) any later version.
"""

import argparse
import pathlib
import sys

from docscan import VERSION
from docscan.camera import (CameraError, CameraOptions, CameraScanner, HeadlessError,
                            probe_devices)
from docscan.detect import draw_outline
from docscan.enhance import MODE_DESCRIPTIONS, MODES
from docscan.io_utils import (ImageReadError, collect_images, default_scan_name,
                              describe_path, human_size, imread, imwrite, unique_path)
from docscan.pdf import PAPER_SIZES, write_pdf
from docscan.scanner import ScanOptions, scan_image
from docscan.transform import PAPER_RATIOS

IMAGE_FORMATS = ("jpg", "png", "webp")
ASPECT_CHOICES = ("auto", "projective", "edges") + tuple(sorted(PAPER_RATIOS))
PAGE_SIZE_CHOICES = ("auto",) + tuple(sorted(PAPER_SIZES))


def build_parser():
    parser = argparse.ArgumentParser(
        prog="docscan",
        description="Turn photos of documents into clean, deskewed scans (PDF or image).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    parser.add_argument("--version", action="version", version="docscan {}".format(VERSION))
    subparsers = parser.add_subparsers(dest="command")

    camera = subparsers.add_parser(
        "camera", help="capture pages from a live camera",
        description="Show a live preview, capture pages and save them as PDF or images.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    camera.add_argument("-d", "--device", default="0",
                        help="camera index, device path or stream URL")
    camera.add_argument("--width", type=int, default=1920, help="requested capture width")
    camera.add_argument("--height", type=int, default=1080, help="requested capture height")
    camera.add_argument("--preview-width", type=int, default=960,
                        help="width of the preview window")
    camera.add_argument("--detect-size", type=int, default=480,
                        help="analysis size of the live detection (smaller is faster)")
    camera.add_argument("--detect-interval", type=int, default=2,
                        help="run the detection on every N-th frame")
    camera.add_argument("--auto", action="store_true",
                        help="start with automatic capture of a steadily held page")
    camera.add_argument("--stable-frames", type=int, default=8,
                        help="detections the page must hold still for before an auto capture")
    camera.add_argument("--mirror", action="store_true",
                        help="mirror the preview (natural for a front facing webcam)")
    camera.add_argument("--no-preview", action="store_true",
                        help="capture from the terminal, for machines without a display")
    _add_common_arguments(camera)

    shot = subparsers.add_parser(
        "shot", help="capture a single page and exit",
        description="Grab one frame from the camera, scan it and save it.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    shot.add_argument("-d", "--device", default="0",
                      help="camera index, device path or stream URL")
    shot.add_argument("--width", type=int, default=1920, help="requested capture width")
    shot.add_argument("--height", type=int, default=1080, help="requested capture height")
    _add_common_arguments(shot)

    scan = subparsers.add_parser(
        "scan", help="scan photos that are already on disk",
        description="Process image files or folders of images.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    scan.add_argument("inputs", nargs="+", help="image files or directories")
    scan.add_argument("-r", "--recursive", action="store_true",
                      help="search directories recursively")
    scan.add_argument("--debug-dir", metavar="DIR",
                      help="also write the input with the detected outline drawn on it")
    _add_common_arguments(scan)

    subparsers.add_parser("devices", help="list the cameras that can be opened")
    subparsers.add_parser("modes", help="explain the available colour modes")
    return parser


def _add_common_arguments(parser):
    output = parser.add_argument_group("output")
    output.add_argument("-o", "--output", metavar="PATH",
                        help="output file (*.pdf) or directory for image files")
    output.add_argument("-f", "--format", choices=IMAGE_FORMATS, default="jpg",
                        help="image format when writing single pages")
    output.add_argument("--pdf", metavar="PATH",
                        help="additionally collect every page in this PDF file")
    output.add_argument("--dpi", type=int, default=300, help="resolution recorded in the PDF")
    output.add_argument("--quality", type=int, default=92, help="JPEG/WebP quality (1-100)")
    output.add_argument("--page-size", choices=PAGE_SIZE_CHOICES, default="auto",
                        help="PDF page size; 'auto' keeps the size implied by --dpi")
    output.add_argument("--overwrite", action="store_true",
                        help="overwrite existing files instead of adding a counter")

    processing = parser.add_argument_group("processing")
    processing.add_argument("-m", "--mode", choices=MODES, default="color",
                            help="colour mode of the finished page")
    processing.add_argument("-a", "--aspect", choices=ASPECT_CHOICES, default="auto",
                            help="how the page proportions are restored")
    processing.add_argument("--margin", type=float, default=-0.004,
                            help="grow (positive) or shrink (negative) the detected outline; "
                                 "the small default shrink avoids a rim of background")
    processing.add_argument("--shadow", type=float, default=1.0,
                            help="strength of the shadow/lighting removal (0-1)")
    processing.add_argument("--sharpen", type=float, default=None,
                            help="extra sharpening amount, e.g. 0.5")
    processing.add_argument("--rotate", type=int, default=0, choices=(0, 90, 180, 270),
                            help="rotate the finished page clockwise")
    processing.add_argument("--no-crop", action="store_true",
                            help="keep the full photo instead of cropping to the page")
    processing.add_argument("--no-flatten", action="store_true",
                            help="skip the curvature correction and only straighten the "
                                 "perspective (a curled page then keeps its bent lines)")
    processing.add_argument("--min-area", type=float, default=0.08, metavar="RATIO",
                            help="smallest page area relative to the photo")
    processing.add_argument("--max-side", type=int, default=None,
                            help="limit the longest side of the output in pixels")

    parser.add_argument("-q", "--quiet", action="store_true", help="only report errors")
    parser.add_argument("-v", "--verbose", action="store_true", help="report every step")


def scan_options_from_args(args):
    return ScanOptions(mode=args.mode, aspect=args.aspect, margin=args.margin,
                       shadow=args.shadow, sharpen=args.sharpen, rotate=args.rotate,
                       crop=not args.no_crop, flatten=not args.no_flatten,
                       min_area_ratio=args.min_area, max_side=args.max_side).validate()


def camera_options_from_args(args):
    return CameraOptions(device=args.device, width=args.width, height=args.height,
                         preview_width=getattr(args, "preview_width", 960),
                         detect_interval=getattr(args, "detect_interval", 2),
                         detect_size=getattr(args, "detect_size", 480),
                         auto_capture=getattr(args, "auto", False),
                         stable_frames=getattr(args, "stable_frames", 8),
                         mirror=getattr(args, "mirror", False))


class Reporter:
    """Tiny logger honouring --quiet and --verbose."""

    def __init__(self, quiet=False, verbose=False):
        self.quiet = quiet
        self.verbose = verbose

    def info(self, message):
        if not self.quiet:
            print(message)

    def detail(self, message):
        if self.verbose and not self.quiet:
            print(message)

    def warn(self, message):
        print("warning: {}".format(message), file=sys.stderr)

    def error(self, message):
        print("error: {}".format(message), file=sys.stderr)


def _target_path(path, overwrite):
    return pathlib.Path(path) if overwrite else unique_path(path)


def _write_pdf(pages, path, args, report, title=None):
    path = _target_path(path, args.overwrite)
    path.parent.mkdir(parents=True, exist_ok=True)
    size = write_pdf(path, [page.image for page in pages], dpi=args.dpi,
                     quality=args.quality, title=title or path.stem,
                     page_size=args.page_size)
    report.info("wrote {} ({} pages, {})".format(describe_path(path), len(pages),
                                                 human_size(size)))
    return path


def _write_image(page, path, args, report):
    path = _target_path(path, args.overwrite)
    imwrite(path, page.image, quality=args.quality)
    report.info("wrote {} ({}x{})".format(describe_path(path), *page.size))
    return path


def _save_pages(pages, args, report, stems=None, default_stem="scan"):
    """Write the collected pages according to the output options."""
    if not pages:
        report.warn("nothing was scanned")
        return []

    written = []
    output = pathlib.Path(args.output) if args.output else None
    if output is not None and output.suffix.lower() == ".pdf":
        written.append(_write_pdf(pages, output, args, report))
    else:
        directory = output if output is not None else pathlib.Path.cwd()
        for index, page in enumerate(pages):
            if stems and index < len(stems):
                stem = "{}_scan".format(stems[index])
            else:
                stem = "{}-{:03d}".format(default_stem, index + 1)
            written.append(_write_image(page, directory / "{}.{}".format(stem, args.format),
                                        args, report))
    if args.pdf:
        written.append(_write_pdf(pages, pathlib.Path(args.pdf), args, report))
    return written


def command_scan(args, report):
    options = scan_options_from_args(args)
    try:
        paths = collect_images(args.inputs, recursive=args.recursive)
    except ImageReadError as exc:
        report.error(str(exc))
        return 1
    if not paths:
        report.error("no image files found in: {}".format(", ".join(args.inputs)))
        return 1

    output = pathlib.Path(args.output) if args.output else None
    single_pdf = output is not None and output.suffix.lower() == ".pdf"
    pages, stems, failures, undetected = [], [], 0, 0

    for path in paths:
        try:
            image = imread(path)
        except ImageReadError as exc:
            report.warn(str(exc))
            failures += 1
            continue
        result = scan_image(image, options)
        if options.crop and not result.cropped:
            undetected += 1
            report.warn("{}: no page outline found, keeping the full photo".format(
                describe_path(path)))
        else:
            report.detail("{}: {} ({:.0%} of the photo) -> {}x{}{}".format(
                describe_path(path), result.detection.method, result.detection.area_ratio,
                *result.size, ", flattened" if result.flattened else ""))
        pages.append(result)
        stems.append(path.stem)

        if args.debug_dir and result.quad is not None:
            debug_path = pathlib.Path(args.debug_dir) / "{}_detected.jpg".format(path.stem)
            debug_path.parent.mkdir(parents=True, exist_ok=True)
            imwrite(debug_path, draw_outline(image, result.quad, label=True),
                    quality=args.quality)
            report.detail("wrote {}".format(describe_path(debug_path)))

        if not single_pdf and output is None and not args.pdf:
            # no output location at all: write next to the input file
            _write_image(result, path.with_name("{}_scan.{}".format(path.stem, args.format)),
                         args, report)

    if not pages:
        report.error("no image could be processed")
        return 1

    if single_pdf or output is not None or args.pdf:
        _save_pages(pages, args, report, stems=stems)

    report.info("{} page(s) processed{}{}".format(
        len(pages),
        ", {} without a detected outline".format(undetected) if undetected else "",
        ", {} unreadable file(s)".format(failures) if failures else ""))
    return 0 if not failures else 1


def _default_camera_output(args):
    if args.output or args.pdf:
        return None
    return pathlib.Path("scans") / default_scan_name()


def command_camera(args, report):
    options = scan_options_from_args(args)
    scanner = CameraScanner(options, camera_options_from_args(args))
    default_output = _default_camera_output(args)
    if default_output is not None:
        args.output = str(default_output)

    try:
        if args.no_preview:
            pages = scanner.run_without_preview(echo=report.info)
        else:
            report.info("keys: SPACE capture | A auto | M mode | R rotate | U undo | "
                        "S save and quit | Q discard")
            pages = scanner.run()
    except HeadlessError as exc:
        report.error(str(exc))
        return 1
    except CameraError as exc:
        report.error(str(exc))
        return 1
    except KeyboardInterrupt:
        report.info("")
        pages = scanner.pages

    if not pages:
        report.info("no pages captured")
        return 0
    _save_pages(pages, args, report)
    return 0


def command_shot(args, report):
    from docscan.camera import capture_single
    try:
        result = capture_single(camera_options_from_args(args), scan_options_from_args(args))
    except CameraError as exc:
        report.error(str(exc))
        return 1
    if result is None:
        report.error("no frame received from the camera")
        return 1
    if not result.cropped and not args.no_crop:
        report.warn("no page outline found, keeping the full photo")
    if not args.output and not args.pdf:
        args.output = str(pathlib.Path("scans") / default_scan_name(suffix=".pdf"))
    _save_pages([result], args, report)
    return 0


def command_devices(args, report):
    devices = probe_devices()
    if not devices:
        report.error("no usable camera found")
        return 1
    for index, width, height in devices:
        print("camera {}: {}x{}".format(index, width, height))
    return 0


def command_modes(args, report):
    width = max(len(mode) for mode in MODES)
    for mode in MODES:
        print("{:<{}}  {}".format(mode, width, MODE_DESCRIPTIONS[mode]))
    return 0


COMMANDS = {
    "camera": command_camera,
    "shot": command_shot,
    "scan": command_scan,
    "devices": command_devices,
    "modes": command_modes,
}


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return 2
    report = Reporter(quiet=getattr(args, "quiet", False),
                      verbose=getattr(args, "verbose", False))
    try:
        return COMMANDS[args.command](args, report)
    except ValueError as exc:
        report.error(str(exc))
        return 1
    except KeyboardInterrupt:
        report.error("interrupted")
        return 130


if __name__ == "__main__":
    sys.exit(main())
