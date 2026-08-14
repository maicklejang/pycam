#!/usr/bin/env python3
"""Generate the PyCAM Viewer PWA icons.

Draws the isometric-cube mark with analytic anti-aliasing and writes plain
RGBA PNG files - no third party imaging library required.

Usage:  python3 mobile/tools/make_icons.py
"""

import math
import os
import struct
import zlib


BACKGROUND = (0x13, 0x18, 0x22)
ACCENT = (0x4C, 0x8D, 0xFF)
ACCENT_DIM = (0x35, 0x63, 0xB4)


def write_png(path, width, height, pixels):
    """pixels: bytearray of RGBA rows."""
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)  # filter type "none"
        raw.extend(pixels[y * stride:(y + 1) * stride])

    def chunk(tag, data):
        out = struct.pack(">I", len(data)) + tag + data
        return out + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", header)
           + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as handle:
        handle.write(png)


def distance_to_segment(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    if length_sq < 1e-9:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_sq))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def rounded_rect_coverage(px, py, size, radius):
    """Signed coverage of a rounded square covering the whole canvas."""
    cx = cy = size / 2.0
    half = size / 2.0
    qx = abs(px - cx) - (half - radius)
    qy = abs(py - cy) - (half - radius)
    outside = math.hypot(max(qx, 0.0), max(qy, 0.0))
    dist = outside + min(max(qx, qy), 0.0) - radius
    return max(0.0, min(1.0, 0.5 - dist))


def cube_segments(size, scale):
    """Isometric cube: outer hexagon plus the three edges meeting in the middle."""
    cx = cy = size / 2.0
    radius = size * scale
    top = (cx, cy - radius)
    bottom = (cx, cy + radius)
    upper_left = (cx - radius * math.sqrt(3) / 2, cy - radius / 2)
    upper_right = (cx + radius * math.sqrt(3) / 2, cy - radius / 2)
    lower_left = (cx - radius * math.sqrt(3) / 2, cy + radius / 2)
    lower_right = (cx + radius * math.sqrt(3) / 2, cy + radius / 2)
    center = (cx, cy)
    outline = [
        (top, upper_right), (upper_right, lower_right), (lower_right, bottom),
        (bottom, lower_left), (lower_left, upper_left), (upper_left, top),
    ]
    inner = [(center, top), (center, lower_left), (center, lower_right)]
    return outline, inner


def render(size, maskable=False):
    pixels = bytearray(size * size * 4)
    scale = 0.30 if maskable else 0.36
    radius = size * 0.235
    stroke = size * 0.045
    inner_stroke = size * 0.032
    outline, inner = cube_segments(size, scale)

    for y in range(size):
        py = y + 0.5
        row = y * size * 4
        for x in range(size):
            px = x + 0.5
            if maskable:
                bg_alpha = 1.0
            else:
                bg_alpha = rounded_rect_coverage(px, py, size, radius)

            r, g, b = BACKGROUND
            alpha = bg_alpha

            if bg_alpha > 0.0:
                best_outline = min(distance_to_segment(px, py, a[0], a[1], c[0], c[1])
                                   for a, c in outline)
                best_inner = min(distance_to_segment(px, py, a[0], a[1], c[0], c[1])
                                 for a, c in inner)
                cover_outline = max(0.0, min(1.0, stroke / 2 - best_outline + 0.5))
                cover_inner = max(0.0, min(1.0, inner_stroke / 2 - best_inner + 0.5))
                if cover_inner > 0.0:
                    r = int(r + (ACCENT_DIM[0] - r) * cover_inner)
                    g = int(g + (ACCENT_DIM[1] - g) * cover_inner)
                    b = int(b + (ACCENT_DIM[2] - b) * cover_inner)
                if cover_outline > 0.0:
                    r = int(r + (ACCENT[0] - r) * cover_outline)
                    g = int(g + (ACCENT[1] - g) * cover_outline)
                    b = int(b + (ACCENT[2] - b) * cover_outline)

            offset = row + x * 4
            pixels[offset] = r
            pixels[offset + 1] = g
            pixels[offset + 2] = b
            pixels[offset + 3] = int(round(alpha * 255))
    return pixels


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    icons = os.path.join(os.path.dirname(here), "icons")
    os.makedirs(icons, exist_ok=True)
    for size in (192, 512):
        write_png(os.path.join(icons, "icon-%d.png" % size), size, size, render(size))
        print("wrote icon-%d.png" % size)
    write_png(os.path.join(icons, "icon-maskable-512.png"), 512, 512,
              render(512, maskable=True))
    print("wrote icon-maskable-512.png")


if __name__ == "__main__":
    main()
