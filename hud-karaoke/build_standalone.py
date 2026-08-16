#!/usr/bin/env python3
"""Bundle the app into one self-contained HTML file.

The point is a file you can hand to a phone directly — mail it, drop it in
cloud storage, or upload it to any static host — and open without a server,
a build tool or a network connection.

The modules are concatenated in dependency order and their import/export
keywords removed, which works because every top level name across them is
unique. ``check_collisions`` fails the build if that ever stops being true.

Usage::

    python3 build_standalone.py                 # -> standalone.html
    python3 build_standalone.py --fragment out.html   # no <html>/<head>/<body>
"""

import argparse
import base64
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent

# Dependency order: a module may only use names defined above it.
MODULES = [
    "js/lrc.js",
    "js/clock.js",
    "js/settings.js",
    "js/library.js",
    "js/safety.js",
    "js/hudview.js",
    "js/main.js",
]

IMPORT_LINE = re.compile(r"^import\s.*?;\s*$", re.MULTILINE)
EXPORT_KEYWORD = re.compile(r"^export\s+(?=(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\b)",
                            re.MULTILINE)
NAMESPACE_USE = re.compile(r"\blibrary\.(?=[A-Za-z_$])")
TOP_LEVEL_NAME = re.compile(
    r"^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)",
    re.MULTILINE)


def check_collisions(sources):
    """Refuse to build if two modules define the same top level name."""
    seen = {}
    clashes = []
    for name, text in sources.items():
        for match in TOP_LEVEL_NAME.finditer(text):
            symbol = match.group(1)
            if symbol in seen and seen[symbol] != name:
                clashes.append(f"{symbol}: {seen[symbol]} and {name}")
            seen[symbol] = name
    if clashes:
        raise SystemExit("duplicate top level names, rename one of each:\n  "
                         + "\n  ".join(clashes))


def bundle():
    sources = {path: (HERE / path).read_text(encoding="utf-8") for path in MODULES}
    check_collisions(sources)

    parts = []
    for path, text in sources.items():
        text = IMPORT_LINE.sub("", text)
        text = EXPORT_KEYWORD.sub("", text)
        text = NAMESPACE_USE.sub("", text)
        parts.append(f"/* ==== {path} ==== */\n{text.strip()}\n")
    return "\n".join(parts)


def data_uri(path, mime):
    encoded = base64.b64encode((HERE / path).read_bytes()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def js_string(text):
    """Embed text in a script without letting it close the script element."""
    return (text.replace("\\", "\\\\")
                .replace("`", "\\`")
                .replace("${", "\\${")
                .replace("</script", "<\\/script"))


def build(fragment):
    html = (HERE / "index.html").read_text(encoding="utf-8")
    css = (HERE / "css/hud.css").read_text(encoding="utf-8")
    demo = (HERE / "songs/demo.lrc").read_text(encoding="utf-8")

    scripts = (
        "<script>\n"
        "window.HUD_STANDALONE = true;\n"
        f"window.HUD_DEMO_LRC = `{js_string(demo)}`;\n"
        "</script>\n"
        f'<script type="module">\n{bundle()}</script>'
    )

    html = html.replace('<link rel="stylesheet" href="css/hud.css">',
                        f"<style>\n{css}</style>")
    html = html.replace('<script type="module" src="js/main.js"></script>', scripts)
    html = html.replace('<link rel="manifest" href="manifest.webmanifest">\n', "")
    for tag in ('<link rel="icon" href="assets/icon.svg" type="image/svg+xml">',
                '<link rel="apple-touch-icon" href="assets/icon.svg">'):
        html = html.replace(tag, tag.replace("assets/icon.svg",
                                             data_uri("assets/icon.svg", "image/svg+xml")))

    # The module banners mention the paths, so look for the tags themselves.
    for reference in ('href="css/', 'src="js/', 'href="assets/', 'href="manifest'):
        if reference in html:
            raise SystemExit(f"an external reference survived the bundle: {reference}")

    if not fragment:
        return html

    # Artifact hosting supplies <html>, <head> and <body>, so hand back only the
    # content. The viewport meta still works from inside the body.
    head = re.search(r"<head>(.*?)</head>", html, re.S).group(1)
    body = re.search(r"<body>(.*?)</body>", html, re.S).group(1)
    keep = [line for line in head.splitlines()
            if line.strip().startswith(("<title", "<meta name=\"viewport\"",
                                        "<meta name=\"theme-color\"", "<style"))
            or not line.strip().startswith(("<meta", "<link", "<title"))]
    return "\n".join(keep).strip() + "\n" + body.strip() + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fragment", metavar="PATH",
                        help="also write a head/body-less copy for embedding")
    parser.add_argument("--out", default="standalone.html")
    args = parser.parse_args()

    full = build(fragment=False)
    target = HERE / args.out
    target.write_text(full, encoding="utf-8")
    print(f"{target}: {len(full) / 1024:.0f} KB", file=sys.stderr)

    if args.fragment:
        piece = build(fragment=True)
        pathlib.Path(args.fragment).write_text(piece, encoding="utf-8")
        print(f"{args.fragment}: {len(piece) / 1024:.0f} KB", file=sys.stderr)


if __name__ == "__main__":
    main()
