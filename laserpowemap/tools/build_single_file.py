#!/usr/bin/env python3
"""단일 파일(.html) 빌드 — CSS·JS·아이콘을 모두 index.html 안에 넣습니다.

인터넷 없이 파일 하나만 열면 동작하므로, 카카오톡·메일로 그대로 보내거나
USB에 담아 배포할 수 있습니다.

사용법:  python3 tools/build_single_file.py
결과:    dist/레이저소재가이드.html
"""
import base64
import os
import re

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
OUT_DIR = os.path.join(ROOT, "dist")
OUT_FILE = os.path.join(OUT_DIR, "레이저소재가이드.html")


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as fh:
        return fh.read()


def data_uri(rel, mime="image/png"):
    with open(os.path.join(ROOT, rel), "rb") as fh:
        return "data:%s;base64,%s" % (mime, base64.b64encode(fh.read()).decode())


def main():
    html = read("index.html")

    # 스타일 인라인
    html = html.replace(
        '<link rel="stylesheet" href="css/app.css">',
        "<style>\n%s\n</style>" % read("css/app.css"),
    )

    # 스크립트 인라인 (선언 순서 유지)
    for src in re.findall(r'<script src="([^"]+)"></script>', html):
        html = html.replace(
            '<script src="%s"></script>' % src,
            "<script>\n%s\n</script>" % read(src),
        )

    # 아이콘은 data URI 로, 설치 관련 링크는 제거 (파일 단독 실행용)
    icon = data_uri("icons/favicon-64.png")
    html = html.replace('<link rel="icon" href="icons/icon-192.png">', '<link rel="icon" href="%s">' % icon)
    html = html.replace('<link rel="apple-touch-icon" href="icons/icon-192.png">',
                        '<link rel="apple-touch-icon" href="%s">' % data_uri("icons/icon-192.png"))
    html = html.replace('<link rel="manifest" href="manifest.webmanifest">', "")

    # 파일 단독 실행에서는 서비스워커를 등록하지 않는다
    html = html.replace('if ("serviceWorker" in navigator) {', 'if ("serviceWorker" in navigator && location.protocol !== "file:") {')

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(OUT_FILE, "w", encoding="utf-8") as fh:
        fh.write(html)
    print("%s (%.0f KB)" % (OUT_FILE, os.path.getsize(OUT_FILE) / 1024))


if __name__ == "__main__":
    main()
