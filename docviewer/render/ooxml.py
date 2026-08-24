"""Helpers shared by the OOXML (docx/xlsx/pptx) renderers.

OOXML files are zip archives containing XML parts.  Everything needed for a
read-only viewer can be done with :mod:`zipfile` and :mod:`xml.etree`, so the
renderers below have no third party dependencies.
"""

import html
import posixpath
import xml.etree.ElementTree as ET
import zipfile


NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "c": "http://schemas.openxmlformats.org/drawingml/2006/chart",
    "ct": "http://schemas.openxmlformats.org/package/2006/content-types",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "pkg_rel": "http://schemas.openxmlformats.org/package/2006/relationships",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
}

# Some parts are big enough to hurt: refuse to expand zip bombs.
MAX_PART_SIZE = 80 * 1024 * 1024


class BrokenDocument(Exception):
    """Raised when a file cannot be parsed as the expected OOXML format."""


def qn(name):
    """Expand a ``prefix:tag`` name into ``{namespace}tag``."""
    prefix, _, tag = name.partition(":")
    return "{%s}%s" % (NS[prefix], tag)


def local_name(element):
    """Return the tag of *element* without its namespace."""
    tag = element.tag
    if isinstance(tag, str) and tag.startswith("{"):
        return tag.split("}", 1)[1]
    return tag


def open_package(path):
    """Open *path* as a zip archive, raising :class:`BrokenDocument` if it is not."""
    try:
        return zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError) as exc:
        raise BrokenDocument("파일을 열 수 없습니다: %s" % exc)


def read_part(package, name):
    """Return the raw bytes of the zip entry *name* or ``None`` when missing."""
    try:
        info = package.getinfo(name)
    except KeyError:
        return None
    if info.file_size > MAX_PART_SIZE:
        raise BrokenDocument("내부 파일이 너무 큽니다: %s" % name)
    return package.read(name)


def parse_part(package, name):
    """Parse the XML zip entry *name*, returning ``None`` when it is missing."""
    data = read_part(package, name)
    if data is None:
        return None
    try:
        return ET.fromstring(data)
    except ET.ParseError as exc:
        raise BrokenDocument("XML 구조가 잘못되었습니다 (%s): %s" % (name, exc))


def relationships(package, part_name):
    """Return ``{rId: {"target": ..., "mode": ...}}`` for the given part.

    Targets of internal relationships are resolved to absolute zip entry names,
    external ones (hyperlinks) are kept as they are.
    """
    directory, _, filename = part_name.rpartition("/")
    rels_name = posixpath.join(directory, "_rels", filename + ".rels")
    root = parse_part(package, rels_name)
    result = {}
    if root is None:
        return result
    for rel in root:
        if local_name(rel) != "Relationship":
            continue
        rel_id = rel.get("Id")
        target = rel.get("Target") or ""
        mode = rel.get("TargetMode", "Internal")
        if mode != "External" and not target.startswith("/"):
            target = posixpath.normpath(posixpath.join(directory, target))
        elif mode != "External":
            target = target.lstrip("/")
        result[rel_id] = {"target": target, "mode": mode, "type": rel.get("Type", "")}
    return result


def iter_text(element, tag):
    """Yield the text of every descendant with the given expanded *tag*."""
    for node in element.iter(tag):
        if node.text:
            yield node.text


def escape(text):
    """Escape *text* for inclusion in HTML."""
    return html.escape(text or "", quote=True)


def emu_to_px(value, default=None):
    """Convert English Metric Units to CSS pixels (96 dpi)."""
    try:
        return round(int(value) / 9525.0, 1)
    except (TypeError, ValueError):
        return default
