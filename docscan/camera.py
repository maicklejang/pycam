"""Live camera capture with a preview of the detected page outline.

Copyright 2026 PyCAM contributors

This file is part of the docscan document scanner.  It is free software:
you can redistribute it and/or modify it under the terms of the GNU General
Public License as published by the Free Software Foundation, either version 3
of the License, or (at your option) any later version.
"""

import time
from dataclasses import dataclass
from typing import Optional

import numpy as np

import cv2

from docscan.detect import draw_outline, find_document, touches_border
from docscan.enhance import MODES
from docscan.scanner import ScanOptions, ScanResult, scan_image

WINDOW_TITLE = "docscan"

#: the preview can only use ASCII, because OpenCV cannot render Hangul glyphs
HELP_LINES = ("SPACE capture   A auto   M mode   R rotate   U undo",
              "S save and quit   Q discard and quit")

KEY_ESCAPE = 27
#: both values show up as "Enter", depending on the platform and the backend
KEY_ENTER = (10, 13)


class CameraError(Exception):
    """Raised when the camera cannot be opened or read."""


class HeadlessError(Exception):
    """Raised when OpenCV has no window support (headless build or no display)."""


@dataclass
class CameraOptions:
    """Settings of the live capture session."""

    device: str = "0"
    width: int = 1920
    height: int = 1080
    preview_width: int = 960
    detect_interval: int = 2
    detect_size: int = 480
    auto_capture: bool = False
    stable_frames: int = 8
    stable_tolerance: float = 0.015
    cooldown: float = 2.0
    mirror: bool = False

    def resolve_device(self):
        """Camera indices are given as numbers, everything else is a URL or file."""
        text = str(self.device)
        return int(text) if text.lstrip("-").isdigit() else text


def open_camera(options):
    """Open the capture device and apply the requested resolution."""
    capture = cv2.VideoCapture(options.resolve_device())
    if not capture.isOpened():
        capture.release()
        raise CameraError(
            "cannot open camera {!r} - check that it is connected, not in use by "
            "another program, and that this program may access it".format(options.device))
    if options.width:
        capture.set(cv2.CAP_PROP_FRAME_WIDTH, options.width)
    if options.height:
        capture.set(cv2.CAP_PROP_FRAME_HEIGHT, options.height)
    return capture


def probe_devices(maximum=6):
    """Return the indices of cameras that deliver a frame (used by ``docscan devices``)."""
    available = []
    for index in range(maximum):
        capture = cv2.VideoCapture(index)
        try:
            if capture.isOpened():
                success, frame = capture.read()
                if success and frame is not None:
                    height, width = frame.shape[:2]
                    available.append((index, width, height))
        finally:
            capture.release()
    return available


def _check_gui():
    """Fail early (and with a helpful message) when no window can be shown."""
    try:
        cv2.namedWindow(WINDOW_TITLE, cv2.WINDOW_NORMAL)
        cv2.destroyWindow(WINDOW_TITLE)
    except cv2.error as exc:
        raise HeadlessError(
            "this OpenCV build cannot open a window ({}).\n"
            "Install the GUI build with 'pip install opencv-python' (instead of "
            "opencv-python-headless), make sure a display is available, or use "
            "'--no-preview' to capture from the terminal.".format(
                str(exc).strip().splitlines()[-1] if str(exc).strip() else "no GUI support"))


def _banner(image, text, position="top", colour=(255, 255, 255), background=(0, 0, 0),
            scale=0.6, thickness=1):
    """Draw a readable text line on a translucent bar."""
    height, width = image.shape[:2]
    (text_width, text_height), baseline = cv2.getTextSize(
        text, cv2.FONT_HERSHEY_SIMPLEX, scale, thickness)
    padding = 8
    bar_height = text_height + baseline + 2 * padding
    top = 0 if position == "top" else height - bar_height
    overlay = image.copy()
    cv2.rectangle(overlay, (0, top), (width, top + bar_height), background, -1)
    cv2.addWeighted(overlay, 0.55, image, 0.45, 0, image)
    cv2.putText(image, text, (padding, top + padding + text_height),
                cv2.FONT_HERSHEY_SIMPLEX, scale, colour, thickness, cv2.LINE_AA)
    return image


def _fit_preview(frame, preview_width):
    """Return a *copy* of the frame scaled down for the preview window.

    The copy matters: the banners and the outline are drawn onto the preview,
    and the very same frame is handed to the scanner when the user hits the
    capture key - a shared buffer would burn the overlay into the page.
    """
    if not preview_width or frame.shape[1] <= preview_width:
        return frame.copy(), 1.0
    scale = preview_width / float(frame.shape[1])
    resized = cv2.resize(frame, (preview_width, max(1, int(round(frame.shape[0] * scale)))),
                         interpolation=cv2.INTER_AREA)
    return resized, scale


def _smooth_quad(previous, current, factor=0.5):
    """Damp the jitter of the detected outline between frames."""
    if previous is None or current is None:
        return current
    return previous * (1.0 - factor) + current * factor


class CameraScanner:
    """Interactive multi page capture session."""

    def __init__(self, scan_options=None, camera_options=None, on_capture=None):
        self.scan_options = (scan_options or ScanOptions()).validate()
        self.camera_options = camera_options or CameraOptions()
        self.on_capture = on_capture
        self.pages = []
        self._mode_index = MODES.index(self.scan_options.mode)
        self._last_capture_time = 0.0

    # -- capturing ---------------------------------------------------------

    def capture(self, frame, detection=None):
        """Process one frame and append it to the collected pages."""
        if detection is None and self.scan_options.crop:
            # re-detect on the full resolution frame: the preview works on a
            # downscaled copy, which is good enough for drawing but not for the
            # final corner positions
            detection = find_document(frame, min_area_ratio=self.scan_options.min_area_ratio,
                                      working_size=self.scan_options.working_size)
        result = scan_image(frame, self.scan_options, detection=detection)
        self.pages.append(result)
        self._last_capture_time = time.monotonic()
        if self.on_capture:
            self.on_capture(result, len(self.pages))
        return result

    def undo(self):
        return self.pages.pop() if self.pages else None

    def cycle_mode(self, step=1):
        self._mode_index = (self._mode_index + step) % len(MODES)
        self.scan_options.mode = MODES[self._mode_index]
        return self.scan_options.mode

    def rotate(self, degrees=90):
        self.scan_options.rotate = (self.scan_options.rotate + degrees) % 360
        return self.scan_options.rotate

    # -- interactive loops -------------------------------------------------

    def run(self):
        """Show the live preview and return the captured pages."""
        _check_gui()
        options = self.camera_options
        capture = open_camera(options)
        cv2.namedWindow(WINDOW_TITLE, cv2.WINDOW_NORMAL)
        frame_index = 0
        detection = None
        smoothed = None
        stable_count = 0
        previous_quad = None
        auto = options.auto_capture
        flash_until = 0.0
        message = ""
        message_until = 0.0
        discarded = False
        try:
            while True:
                success, frame = capture.read()
                if not success or frame is None:
                    raise CameraError("lost the connection to camera {!r}".format(options.device))
                if options.mirror:
                    frame = cv2.flip(frame, 1)
                frame_index += 1

                if frame_index % max(1, options.detect_interval) == 0:
                    detection = find_document(frame,
                                              min_area_ratio=self.scan_options.min_area_ratio,
                                              working_size=options.detect_size)
                    quad = None if detection is None else detection.quad
                    diagonal = float(np.hypot(*frame.shape[:2]))
                    if quad is not None and previous_quad is not None:
                        movement = float(np.max(np.linalg.norm(quad - previous_quad, axis=1)))
                        stable_count = (stable_count + 1
                                        if movement < options.stable_tolerance * diagonal else 0)
                    else:
                        stable_count = 0
                    previous_quad = quad
                    smoothed = _smooth_quad(smoothed, quad) if quad is not None else None

                now = time.monotonic()
                ready = (auto and detection is not None
                         and stable_count >= options.stable_frames
                         and now - self._last_capture_time > options.cooldown)
                if ready:
                    result = self.capture(frame, detection)
                    flash_until = now + 0.12
                    message = "page {} captured ({}x{})".format(
                        len(self.pages), *result.size)
                    message_until = now + 1.5
                    stable_count = 0

                preview, scale = _fit_preview(frame, options.preview_width)
                if smoothed is not None:
                    outside = touches_border(smoothed, frame.shape)
                    colour = (0, 180, 255) if outside else (0, 220, 0)
                    if auto and stable_count >= options.stable_frames // 2 and not outside:
                        colour = (0, 255, 255)
                    preview = draw_outline(preview, smoothed * scale, colour=colour)
                    status = "page detected ({}, {:.0%})".format(detection.method,
                                                                 detection.area_ratio)
                    if outside:
                        status = "page touches the frame - step back a little"
                else:
                    status = "no page detected - use a contrasting, evenly lit surface"

                header = "pages: {}   mode: {}   rotate: {}   auto: {}   |   {}".format(
                    len(self.pages), self.scan_options.mode, self.scan_options.rotate,
                    "on" if auto else "off", status)
                _banner(preview, header, "top")
                _banner(preview, HELP_LINES[0] + "   " + HELP_LINES[1], "bottom", scale=0.5)
                if now < message_until and message:
                    _banner(preview, message, "top", colour=(0, 255, 0))
                if now < flash_until:
                    preview = cv2.addWeighted(preview, 0.3,
                                              np.full_like(preview, 255), 0.7, 0)
                cv2.imshow(WINDOW_TITLE, preview)

                key = cv2.waitKey(1) & 0xFF
                if key in (255, 0xFF):
                    # no key pressed; also stop when the user closed the window
                    if cv2.getWindowProperty(WINDOW_TITLE, cv2.WND_PROP_VISIBLE) < 1:
                        break
                    continue
                if key == ord(" ") or key in KEY_ENTER:
                    result = self.capture(frame, detection)
                    flash_until = time.monotonic() + 0.12
                    message = "page {} captured ({}x{})".format(len(self.pages), *result.size)
                    message_until = time.monotonic() + 1.5
                elif key in (ord("a"), ord("A")):
                    auto = not auto
                    stable_count = 0
                elif key in (ord("m"), ord("M")):
                    message = "mode: {}".format(self.cycle_mode())
                    message_until = time.monotonic() + 1.2
                elif key in (ord("r"), ord("R")):
                    message = "rotation: {} degrees".format(self.rotate())
                    message_until = time.monotonic() + 1.2
                elif key in (ord("u"), ord("U")):
                    removed = self.undo()
                    message = ("removed page {}".format(len(self.pages) + 1) if removed
                               else "nothing to undo")
                    message_until = time.monotonic() + 1.2
                elif key in (ord("s"), ord("S")):
                    break
                elif key in (ord("q"), ord("Q"), KEY_ESCAPE):
                    discarded = True
                    break
        finally:
            capture.release()
            try:
                cv2.destroyWindow(WINDOW_TITLE)
            except cv2.error:
                pass
        if discarded:
            self.pages = []
        return self.pages

    def run_without_preview(self, prompt=input, echo=print):
        """Capture pages from the terminal - for machines without a display."""
        options = self.camera_options
        capture = open_camera(options)
        echo("Camera ready. Press ENTER to capture a page, 'u' to undo, "
             "'q' to finish, 'x' to discard everything.")
        try:
            while True:
                try:
                    answer = prompt("[pages: {}] > ".format(len(self.pages))).strip().lower()
                except (EOFError, KeyboardInterrupt):
                    echo("")
                    break
                if answer in ("q", "quit", "s", "save"):
                    break
                if answer in ("x", "discard"):
                    self.pages = []
                    break
                if answer in ("u", "undo"):
                    echo("removed a page" if self.undo() else "nothing to undo")
                    continue
                if answer in ("m", "mode"):
                    echo("mode: {}".format(self.cycle_mode()))
                    continue
                # drop a few frames so that the camera has adjusted its exposure
                frame = None
                for _ in range(5):
                    success, frame = capture.read()
                    if not success or frame is None:
                        raise CameraError("cannot read from camera {!r}".format(options.device))
                result = self.capture(frame)
                echo("page {} captured: {}x{} ({})".format(
                    len(self.pages), result.size[0], result.size[1],
                    "cropped" if result.cropped else "no page outline found, kept full frame"))
        finally:
            capture.release()
        return self.pages


def capture_single(camera_options, scan_options=None, warmup=5) -> Optional[ScanResult]:
    """Grab exactly one page and return it (used by ``docscan shot``)."""
    capture = open_camera(camera_options)
    try:
        frame = None
        for _ in range(max(1, warmup)):
            success, frame = capture.read()
            if not success or frame is None:
                raise CameraError("cannot read from camera {!r}".format(camera_options.device))
        return scan_image(frame, scan_options or ScanOptions())
    finally:
        capture.release()
