"""Draw the docviewer launcher icon at any size.

The icon is a rounded blue square with a white page on it.  Keeping it as code
means the web icons and the android launcher icons cannot drift apart, and no
binary editor is needed to change the artwork.

    python3 -m docviewer.icons        # rewrite every icon in the repository
"""

import os
import struct
import zlib


BACKGROUND_TOP = (38, 101, 232)
BACKGROUND_BOTTOM = (68, 141, 212)
PAGE = (255, 255, 255)
LINE = (120, 150, 205)

# (directory, filename, pixel size) of every icon the project ships
TARGETS = (
    ("static", "icon-180.png", 180),
    ("static", "icon-512.png", 512),
    ("android/res/mipmap-mdpi", "ic_launcher.png", 48),
    ("android/res/mipmap-hdpi", "ic_launcher.png", 72),
    ("android/res/mipmap-xhdpi", "ic_launcher.png", 96),
    ("android/res/mipmap-xxhdpi", "ic_launcher.png", 144),
    ("android/res/mipmap-xxxhdpi", "ic_launcher.png", 192),
)


def render(size):
    """Return the png bytes of the icon drawn at *size* pixels."""
    radius = size * 0.22
    margin = size * 0.16
    page_width = size - 2 * margin
    page_height = size - 2 * margin * 0.86
    fold = size * 0.20
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            row.extend(_pixel(x, y, size, radius, margin, page_width, page_height, fold))
        rows.append(row)
    return _png(size, size, rows)


def _pixel(x, y, size, radius, margin, page_width, page_height, fold):
    # rounded square: the corner circles decide where the background stops
    corner_x = min(max(x, radius), size - radius)
    corner_y = min(max(y, radius), size - radius)
    if (x - corner_x) ** 2 + (y - corner_y) ** 2 > radius ** 2:
        return (0, 0, 0, 0)
    ratio = y / float(size)
    color = tuple(int(BACKGROUND_TOP[index]
                      + (BACKGROUND_BOTTOM[index] - BACKGROUND_TOP[index]) * ratio)
                  for index in range(3))
    page_x = x - margin
    page_y = y - margin * 0.86
    if not (0 <= page_x < page_width and 0 <= page_y < page_height):
        return color + (255,)
    # the top right corner of the page is folded away
    if page_x > page_width - fold and page_y < fold and (page_width - page_x) + page_y < fold:
        return color + (255,)
    if _on_text_line(page_x, page_y, page_width, page_height):
        return LINE + (255,)
    return PAGE + (255,)


def _on_text_line(page_x, page_y, page_width, page_height):
    position = (page_y - page_height * 0.34) / (page_height * 0.155)
    if position < 0:
        return False
    index = round(position)
    if index > 3 or abs(position - index) >= 0.20:
        return False
    right = page_width * (0.84 if index % 2 == 0 else 0.62)
    return page_width * 0.16 < page_x < right


def _png(width, height, rows):
    raw = b"".join(b"\x00" + bytes(row) for row in rows)

    def chunk(tag, payload):
        data = tag + payload
        return struct.pack(">I", len(payload)) + data + struct.pack(">I", zlib.crc32(data))

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)  # 8 bit rgba
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def write_all(root=None):
    """Write every icon listed in :data:`TARGETS` and return their paths."""
    root = root or os.path.dirname(os.path.abspath(__file__))
    written = []
    for directory, name, size in TARGETS:
        folder = os.path.join(root, *directory.split("/"))
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, name)
        with open(path, "wb") as handle:
            handle.write(render(size))
        written.append(path)
    return written


if __name__ == "__main__":
    for written in write_all():
        print("%s (%d bytes)" % (written, os.path.getsize(written)))
