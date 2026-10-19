#!/usr/bin/env python3
"""브랜드 이미지 생성기 — 원본 로고에서 앱이 쓰는 이미지들을 만듭니다.

만드는 것
  img/logo.png   전체 로고 (어두운 배경용으로 글자색을 밝게 바꾼 것)
  img/mark.png   4U 마크만 (상단 바용)
  icons/*.png    홈 화면 아이콘 (흰 바탕 + 4U 마크)

사용법:  python3 tools/make_brand.py <원본로고.png>
원본은 투명 배경 PNG 여야 하고, 위쪽이 마크, 아래쪽이 글자인 세로 배치를 가정합니다.
"""
import os
import sys
from PIL import Image

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
WORDMARK_INK = (232, 237, 244)   # 어두운 배경에서 읽히도록 --text 색으로 바꾼다
ICON_BG = (255, 255, 255)


def trim(im):
    box = im.split()[3].getbbox()
    return im.crop(box) if box else im


def split_rows(im):
    """알파가 비어 있는 가장 긴 가로 구간을 찾아 마크/글자로 나눈다."""
    w, h = im.size
    a = im.split()[3]
    empty = [y for y in range(h) if not a.crop((0, y, w, y + 1)).getbbox()]
    if not empty:
        return im, None
    runs, start = [], empty[0]
    for prev, y in zip(empty, empty[1:]):
        if y != prev + 1:
            runs.append((start, prev)); start = y
    runs.append((start, empty[-1]))
    runs = [r for r in runs if r[0] > 0 and r[1] < h - 1]
    if not runs:
        return im, None
    top, bot = max(runs, key=lambda r: r[1] - r[0])
    return im.crop((0, 0, w, top)), im.crop((0, bot + 1, w, h))


def recolor_ink(im, ink):
    """회색 글자만 지정한 색으로 바꾼다 (초록·주황은 그대로 둔다)."""
    out = im.copy()
    px = out.load()
    w, h = out.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a and max(r, g, b) - min(r, g, b) < 30:   # 무채색 = 글자
                px[x, y] = (ink[0], ink[1], ink[2], a)
    return out


def fit(mark, size, pad):
    """정사각 캔버스 가운데에 마크를 넣는다."""
    canvas = Image.new("RGBA", (size, size), ICON_BG + (255,))
    inner = size - pad * 2
    m = mark.copy()
    m.thumbnail((inner, inner), Image.LANCZOS)
    canvas.alpha_composite(m, ((size - m.width) // 2, (size - m.height) // 2))
    return canvas


def main():
    if len(sys.argv) < 2:
        sys.exit("사용법: python3 tools/make_brand.py <원본로고.png>")
    src = Image.open(sys.argv[1]).convert("RGBA")
    mark, word = split_rows(trim(src))
    mark, word = trim(mark), (trim(word) if word else None)

    os.makedirs(os.path.join(ROOT, "img"), exist_ok=True)
    mark.save(os.path.join(ROOT, "img", "mark.png"))

    if word is not None:
        logo = Image.new("RGBA", src.size, (0, 0, 0, 0))
        full = trim(src)
        logo = recolor_ink(full, WORDMARK_INK)
    else:
        logo = mark
    logo.save(os.path.join(ROOT, "img", "logo.png"))

    icons = os.path.join(ROOT, "icons")
    fit(mark, 512, 56).save(os.path.join(icons, "icon-512.png"))
    fit(mark, 192, 21).save(os.path.join(icons, "icon-192.png"))
    fit(mark, 64, 7).save(os.path.join(icons, "favicon-64.png"))
    fit(mark, 512, 108).save(os.path.join(icons, "icon-maskable-512.png"))  # 원형으로 잘려도 남게

    print("mark %dx%d · logo %dx%d" % (mark.width, mark.height, logo.width, logo.height))
    for n in ("icon-512.png", "icon-192.png", "favicon-64.png", "icon-maskable-512.png"):
        print("  icons/%s" % n)


if __name__ == "__main__":
    main()
