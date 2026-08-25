"""Build the phone page as one self contained html file.

The result has no external references at all: the script, the manifest and the
icons are inlined, so the file can be copied to a phone, mailed, put on any
static host or opened straight from local storage.
"""

import base64
import json
import os
import re


STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")


def build(target=None):
    """Write the single file build to *target* and return the html."""
    html = _read("standalone.html")
    script = _read("viewer.js")
    manifest = json.loads(_read("manifest.webmanifest"))
    icon_180 = _data_uri("icon-180.png")
    icon_512 = _data_uri("icon-512.png")
    manifest["icons"] = [
        {"src": icon_180, "sizes": "180x180", "type": "image/png"},
        {"src": icon_512, "sizes": "512x512", "type": "image/png", "purpose": "any maskable"},
    ]
    manifest["start_url"] = "."
    manifest["scope"] = "."
    html = html.replace('<script src="/static/viewer.js"></script>',
                        "<script>\n%s\n</script>" % script)
    html = html.replace('<link rel="manifest" href="/static/manifest.webmanifest">',
                        '<link rel="manifest" href=\'data:application/manifest+json,%s\'>'
                        % _quote_manifest(manifest))
    html = html.replace('href="/static/icon-180.png"', 'href="%s"' % icon_180)
    html = html.replace('logo.src = "/static/icon-180.png";', 'logo.src = "%s";' % icon_180)
    if target:
        with open(target, "w", encoding="utf-8") as handle:
            handle.write(html)
    return html


def build_fragment(target=None):
    """Build the page without the html/head/body skeleton.

    Useful when the viewer has to live inside a page that somebody else owns:
    the result is a title, a style block, the markup and one script, and the
    script adds the icon and manifest tags to whatever head it ends up in.
    """
    html = build()
    title = _between(html, "<title>", "</title>")
    style = _between(html, "<style>", "</style>")
    body = _between(html, "<body>", "</body>")
    script = _between(body, "<script>", "</script>")
    markup = body.split("<script>")[0]
    prelude = ("window.DOCVIEWER_ICON = %s;\nwindow.DOCVIEWER_MANIFEST = %s;\n"
               % (json.dumps(_data_uri("icon-180.png")),
                  json.dumps("data:application/manifest+json,"
                             + _manifest_uri())))
    fragment = ("<title>%s</title>\n<style>\n%s\n</style>\n%s\n<script>\n%s%s\n</script>\n"
                % (title, style, markup.strip(), prelude, script))
    if target:
        with open(target, "w", encoding="utf-8") as handle:
            handle.write(fragment)
    return fragment


def _manifest_uri():
    manifest = json.loads(_read("manifest.webmanifest"))
    manifest["icons"] = [{"src": _data_uri("icon-512.png"), "sizes": "512x512",
                          "type": "image/png", "purpose": "any maskable"}]
    manifest["start_url"] = "."
    manifest["scope"] = "."
    return _quote_manifest(manifest)


def _between(text, start, end):
    first = text.index(start) + len(start)
    return text[first:text.index(end, first)]


def _read(name):
    with open(os.path.join(STATIC, name), encoding="utf-8") as handle:
        return handle.read()


def _data_uri(name):
    with open(os.path.join(STATIC, name), "rb") as handle:
        return "data:image/png;base64," + base64.b64encode(handle.read()).decode("ascii")


def _quote_manifest(manifest):
    text = json.dumps(manifest, ensure_ascii=False, separators=(",", ":"))
    # only the characters that would end the attribute or confuse the url parser
    return re.sub(r"[#'\"%]", lambda match: "%%%02X" % ord(match.group()), text)


if __name__ == "__main__":
    import sys
    destination = sys.argv[1] if len(sys.argv) > 1 else "docviewer-phone.html"
    build(destination)
    print("만들었습니다: %s (%d KB)" % (destination, os.path.getsize(destination) // 1024))
