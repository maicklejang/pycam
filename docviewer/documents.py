"""Turn a file on disk into something the frontend can display."""

import os

from docviewer import convert, filetypes
from docviewer.render import render_csv, render_docx, render_pptx, render_xlsx
from docviewer.render.ooxml import BrokenDocument, local_name, open_package, parse_part


MAX_TEXT_BYTES = 2 * 1024 * 1024
IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".emf", ".wmf",
                    ".tif", ".tiff", ".ico")


def describe(path, relative=""):
    """Return metadata about *path* without reading its content."""
    stat = os.stat(path)
    return {"name": os.path.basename(path) or relative,
            "path": relative,
            "size": stat.st_size,
            "modified": int(stat.st_mtime),
            "extension": filetypes.extension(path),
            "kind": filetypes.kind_of(path),
            "label": filetypes.KIND_LABELS.get(filetypes.kind_of(path) or "", "")}


def render(path, relative="", media_url=None):
    """Return the payload describing how to display *path*.

    ``media_url`` is called with the name of an image part inside an office
    package and must return a url the browser can fetch.
    """
    info = describe(path, relative)
    kind = info["kind"]
    payload = {"file": info}
    try:
        payload.update(_render_by_kind(path, kind, media_url))
    except BrokenDocument as exc:
        payload.update({"kind": "error", "message": str(exc)})
    except convert.ConversionError as exc:
        payload.update({"kind": "unsupported", "message": str(exc)})
    except (OSError, ValueError) as exc:
        payload.update({"kind": "error", "message": "파일을 읽지 못했습니다: %s" % exc})
    payload.setdefault("properties", {})
    return payload


def _render_by_kind(path, kind, media_url):
    if kind in ("pdf", "image"):
        # both are handed to the browser directly
        return {"kind": kind}
    if kind == "document":
        result = render_docx(path, media_url)
        result["properties"] = core_properties(path)
        return result
    if kind == "spreadsheet":
        if filetypes.extension(path) in (".csv", ".tsv"):
            return render_csv(path)
        result = render_xlsx(path)
        result["properties"] = core_properties(path)
        return result
    if kind == "presentation":
        result = render_pptx(path, media_url)
        result["properties"] = core_properties(path)
        return result
    if kind == "text":
        return _render_text(path)
    if kind == "legacy":
        converted = convert.convert(path)
        converted_kind = filetypes.kind_of(converted)
        result = _render_by_kind(converted, converted_kind, media_url)
        result["converted"] = True
        return result
    return {"kind": "unsupported", "message": "지원하지 않는 형식입니다."}


def _render_text(path):
    size = os.path.getsize(path)
    with open(path, "rb") as source:
        data = source.read(MAX_TEXT_BYTES)
    for encoding in ("utf-8-sig", "cp949", "latin-1"):
        try:
            text = data.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:
        text = data.decode("utf-8", "replace")
    return {"kind": "text", "text": text, "truncated": size > MAX_TEXT_BYTES}


def core_properties(path):
    """Return the title/author/date stored in an OOXML package."""
    try:
        package = open_package(path)
    except BrokenDocument:
        return {}
    try:
        root = parse_part(package, "docProps/core.xml")
    except BrokenDocument:
        return {}
    finally:
        package.close()
    if root is None:
        return {}
    wanted = {"title": "제목", "creator": "작성자", "lastModifiedBy": "최종 수정자",
              "created": "만든 날짜", "modified": "수정한 날짜", "subject": "주제"}
    properties = {}
    for node in root:
        name = local_name(node)
        if name in wanted and (node.text or "").strip():
            properties[wanted[name]] = node.text.strip()
    return properties


def read_media(path, part):
    """Return ``(bytes, mime type)`` for an image *part* stored inside *path*."""
    if filetypes.kind_of(path) == "legacy":
        path = convert.convert(path)
    package = open_package(path)
    try:
        if not part.lower().endswith(IMAGE_EXTENSIONS):
            raise BrokenDocument("이미지 파트가 아닙니다.")
        try:
            data = package.read(part)
        except KeyError:
            raise BrokenDocument("이미지를 찾을 수 없습니다.")
    finally:
        package.close()
    return data, filetypes.mime_type(part, "application/octet-stream")
