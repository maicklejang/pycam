#!/usr/bin/env python3
"""Generate the PWA icons.

Kept as a script rather than checked-in binaries only, so the icons can be
regenerated after a colour change without any image editor or third party
library. Run it from this directory: ``python3 make_icons.py``.
"""

import struct
import zlib

BACKGROUND = (0, 0, 0, 255)
# The dim bars are pre-blended against the black plate rather than drawn with
# alpha, so the icon stays fully opaque wherever the plate is.
DIM = (0, 80, 90, 255)
BRIGHT = (0, 229, 255, 255)

# Lyric bars as (top, height, left, width), in fractions of the icon size.
BARS = (
    (0.30, 0.055, 0.24, 0.52, DIM),
    (0.44, 0.10, 0.16, 0.68, BRIGHT),
    (0.62, 0.055, 0.30, 0.40, DIM),
)


def rounded(x, y, left, top, right, bottom, radius):
    """True if (x, y) lies inside the rounded rectangle."""
    if not (left <= x < right and top <= y < bottom):
        return False
    for corner_x, corner_y in ((left + radius, top + radius),
                               (right - radius, top + radius),
                               (left + radius, bottom - radius),
                               (right - radius, bottom - radius)):
        near_x = x < left + radius or x >= right - radius
        near_y = y < top + radius or y >= bottom - radius
        if near_x and near_y:
            if abs(x - corner_x) <= radius and abs(y - corner_y) <= radius:
                if (x - corner_x) ** 2 + (y - corner_y) ** 2 > radius ** 2:
                    return False
    return True


def render(size, maskable):
    """Return the icon as a list of rows of RGBA tuples."""
    # A maskable icon must survive an aggressive circular crop, so the artwork
    # is shrunk into the safe zone and the plate covers the whole canvas.
    inset = 0 if maskable else round(size * 0.06)
    plate_radius = size * 0.5 if maskable else size * 0.22
    scale = 0.78 if maskable else 1.0
    offset = (1 - scale) / 2

    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            pixel = (0, 0, 0, 0)
            if rounded(x + 0.5, y + 0.5, inset, inset, size - inset, size - inset,
                       plate_radius):
                pixel = BACKGROUND
                for top, height, left, width, colour in BARS:
                    bar_top = (offset + top * scale) * size
                    bar_left = (offset + left * scale) * size
                    bar_height = height * scale * size
                    bar_width = width * scale * size
                    if rounded(x + 0.5, y + 0.5, bar_left, bar_top,
                               bar_left + bar_width, bar_top + bar_height,
                               bar_height / 2):
                        pixel = colour
            row.append(pixel)
        rows.append(row)
    return rows


def write_png(path, rows):
    size = len(rows)
    raw = bytearray()
    for row in rows:
        raw.append(0)  # filter type: none
        for red, green, blue, alpha in row:
            raw += bytes((red, green, blue, alpha))

    def chunk(tag, payload):
        head = struct.pack(">I", len(payload)) + tag
        return head + payload + struct.pack(">I", zlib.crc32(tag + payload))

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", header)
           + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as handle:
        handle.write(png)
    print(f"{path}: {size}x{size}, {len(png)} bytes")


if __name__ == "__main__":
    write_png("icon-192.png", render(192, maskable=False))
    write_png("icon-512.png", render(512, maskable=False))
    write_png("icon-maskable-512.png", render(512, maskable=True))
