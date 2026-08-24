"""Mapping of file extensions to viewer kinds and mime types."""

import os


# Kinds understood by the frontend:
#   "pdf"          -> embedded in an iframe (browser pdf viewer)
#   "image"        -> <img>
#   "document"     -> rendered html (docx)
#   "spreadsheet"  -> rendered sheets (xlsx, csv)
#   "presentation" -> rendered slides (pptx)
#   "text"         -> plain text / source code
#   "legacy"       -> old binary office formats, converted on demand
EXTENSION_KINDS = {
    # portable documents
    ".pdf": "pdf",
    # images
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".jfif": "image",
    ".gif": "image",
    ".bmp": "image",
    ".webp": "image",
    ".svg": "image",
    ".ico": "image",
    ".avif": "image",
    # word processing
    ".docx": "document",
    ".docm": "document",
    # spreadsheets
    ".xlsx": "spreadsheet",
    ".xlsm": "spreadsheet",
    ".csv": "spreadsheet",
    ".tsv": "spreadsheet",
    # presentations
    ".pptx": "presentation",
    ".pptm": "presentation",
    # plain text
    ".txt": "text",
    ".md": "text",
    ".log": "text",
    ".json": "text",
    ".xml": "text",
    ".yml": "text",
    ".yaml": "text",
    ".ini": "text",
    ".cfg": "text",
    ".py": "text",
    ".c": "text",
    ".h": "text",
    ".js": "text",
    ".html": "text",
    ".css": "text",
    ".sh": "text",
    ".ngc": "text",
    ".gcode": "text",
    # old binary office formats and open document formats (need a converter)
    ".doc": "legacy",
    ".xls": "legacy",
    ".ppt": "legacy",
    ".rtf": "legacy",
    ".odt": "legacy",
    ".ods": "legacy",
    ".odp": "legacy",
    ".hwp": "legacy",
}

# Extensions that a converter turns the legacy format into.
LEGACY_TARGETS = {
    ".doc": ".docx",
    ".rtf": ".docx",
    ".odt": ".docx",
    ".hwp": ".docx",
    ".xls": ".xlsx",
    ".ods": ".xlsx",
    ".ppt": ".pptx",
    ".odp": ".pptx",
}

MIME_TYPES = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".jfif": "image/jpeg",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".avif": "image/avif",
    ".emf": "image/emf",
    ".wmf": "image/wmf",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
}

# Human readable labels shown in the file list.
KIND_LABELS = {
    "pdf": "PDF",
    "image": "그림",
    "document": "문서",
    "spreadsheet": "표",
    "presentation": "슬라이드",
    "text": "텍스트",
    "legacy": "구형 문서",
}


def extension(path):
    """Return the lower case extension of *path* (including the dot)."""
    return os.path.splitext(path)[1].lower()


def kind_of(path):
    """Return the viewer kind for *path* or ``None`` when unsupported."""
    return EXTENSION_KINDS.get(extension(path))


def is_supported(path):
    return kind_of(path) is not None


def mime_type(path, default="application/octet-stream"):
    """Return a mime type suitable for serving *path* inline."""
    return MIME_TYPES.get(extension(path), default)
