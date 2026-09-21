#!/usr/bin/env python3
"""앱 아이콘(PNG) 생성기 — 외부 라이브러리 없이 표준 라이브러리만 사용합니다.

사용법:  python3 tools/make_icons.py
결과:    icons/icon-192.png, icons/icon-512.png, icons/icon-maskable-512.png, icons/favicon-64.png
"""
import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")


def mix(a, b, t):
    t = max(0.0, min(1.0, t))
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def over(dst, src, alpha):
    return tuple(dst[i] * (1 - alpha) + src[i] * alpha for i in range(3))


def rounded_rect_alpha(x, y, x0, y0, x1, y1, r):
    """모서리가 둥근 사각형 내부면 1, 밖이면 0."""
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    if x0 <= x <= x1 and y0 <= y <= y1:
        if math.hypot(x - cx, y - cy) <= r or (x0 + r <= x <= x1 - r) or (y0 + r <= y <= y1 - r):
            return 1.0
    return 0.0


def shade(u, v, maskable):
    """0..1 정규 좌표에서 RGBA(0..255) 를 돌려준다."""
    bg_top, bg_bot = (23, 29, 39), (13, 16, 22)
    wood = (196, 138, 74)
    beam = (255, 107, 44)
    hot = (255, 205, 90)

    inside = 1.0 if maskable else rounded_rect_alpha(u, v, 0.0, 0.0, 1.0, 1.0, 0.22)
    if inside <= 0:
        return (0, 0, 0, 0)

    c = mix(bg_top, bg_bot, v)

    # 소재 판
    bar = rounded_rect_alpha(u, v, 0.14, 0.66, 0.86, 0.745, 0.03)
    if bar > 0:
        c = over(c, mix(wood, (120, 78, 38), (v - 0.66) / 0.085), bar)

    # 절단 홈
    if 0.485 < u < 0.515 and 0.66 < v < 0.745:
        c = over(c, (60, 34, 14), 1.0)

    # 레이저 빔 (위에서 아래로 좁아지는 삼각형)
    top_w, bot_w, y0, y1 = 0.055, 0.012, 0.12, 0.70
    if y0 <= v <= y1:
        t = (v - y0) / (y1 - y0)
        w = top_w + (bot_w - top_w) * t
        d = abs(u - 0.5)
        if d <= w:
            edge = 1.0 - (d / w) ** 2
            c = over(c, mix(beam, hot, t), min(1.0, edge * (0.45 + 0.55 * t)))

    # 초점 글로우
    g = math.hypot((u - 0.5) * 1.0, (v - 0.70) * 1.15)
    if g < 0.16:
        c = over(c, hot, (1.0 - g / 0.16) ** 2 * 0.9)

    return (int(c[0]), int(c[1]), int(c[2]), int(255 * inside))


def render(size, maskable=False, ss=3):
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(ss):
                for sx in range(ss):
                    u = (px + (sx + 0.5) / ss) / size
                    v = (py + (sy + 0.5) / ss) / size
                    r, g, b, a = shade(u, v, maskable)
                    acc[0] += r * a
                    acc[1] += g * a
                    acc[2] += b * a
                    acc[3] += a
            n = ss * ss
            a = acc[3] / n
            if a > 0:
                row += bytes((int(acc[0] / acc[3]), int(acc[1] / acc[3]), int(acc[2] / acc[3]), int(a)))
            else:
                row += b"\x00\x00\x00\x00"
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)
    print("%s (%d x %d, %.1f KB)" % (os.path.basename(path), size, size, len(png) / 1024))


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, size, maskable in [
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-512.png", 512, True),
        ("favicon-64.png", 64, False),
    ]:
        write_png(os.path.join(OUT, name), size, render(size, maskable))


if __name__ == "__main__":
    main()
