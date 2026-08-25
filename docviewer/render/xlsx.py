"""Render spreadsheets (.xlsx and .csv) into a grid the frontend can display."""

import csv
import datetime
import io
import re

from docviewer.render.ooxml import (BrokenDocument, local_name, open_package, parse_part, qn,
                                    read_part, relationships)


MAX_ROWS = 2000
MAX_COLUMNS = 120

# Built in number formats that represent a date and/or a time.
_BUILTIN_DATE_FORMATS = set(range(14, 23)) | set(range(45, 48))
_DATE_CHARS = re.compile(r"[yYdD]")
_TIME_CHARS = re.compile(r"[hHsS]")
_ESCAPED = re.compile(r"\\.|\"[^\"]*\"|\[[^\]]*\]")
_EPOCH = datetime.datetime(1899, 12, 30)


def render_xlsx(path):
    """Return ``{"kind": "spreadsheet", "sheets": [...]}`` for the workbook *path*."""
    package = open_package(path)
    try:
        return _read_workbook(package)
    finally:
        package.close()


def render_csv(path, delimiter=None):
    """Return a single sheet built from a csv/tsv file."""
    text = _read_text(path)
    if delimiter is None:
        delimiter = _sniff_delimiter(text)
    rows = []
    truncated = False
    width = 0
    for index, row in enumerate(csv.reader(io.StringIO(text), delimiter=delimiter)):
        if index >= MAX_ROWS:
            truncated = True
            break
        cells = [_text_cell(value) for value in row[:MAX_COLUMNS]]
        truncated = truncated or len(row) > MAX_COLUMNS
        width = max(width, len(cells))
        rows.append(cells)
    for row in rows:
        row.extend([None] * (width - len(row)))
    sheet = {"name": "CSV", "rows": rows, "merges": [], "widths": [], "truncated": truncated}
    return {"kind": "spreadsheet", "sheets": [sheet], "warnings": []}


def _read_text(path):
    with open(path, "rb") as source:
        data = source.read()
    for encoding in ("utf-8-sig", "cp949", "latin-1"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", "replace")


def _sniff_delimiter(text):
    sample = "\n".join(text.splitlines()[:20])
    try:
        return csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
    except csv.Error:
        return "\t" if sample.count("\t") > sample.count(",") else ","


def _text_cell(value):
    value = (value or "").strip()
    if not value:
        return None
    if _looks_numeric(value):
        return {"v": value, "n": True}
    return {"v": value}


def _looks_numeric(value):
    try:
        float(value.replace(",", ""))
    except ValueError:
        return False
    return True


# -- xlsx -----------------------------------------------------------------

def _read_workbook(package):
    workbook = parse_part(package, "xl/workbook.xml")
    if workbook is None:
        raise BrokenDocument("xl/workbook.xml 파트를 찾을 수 없습니다.")
    rels = relationships(package, "xl/workbook.xml")
    shared = _read_shared_strings(package)
    date_styles = _read_date_styles(package)
    warnings = []
    sheets = []
    sheet_list = workbook.find(qn("s:sheets"))
    for node in (sheet_list if sheet_list is not None else []):
        if local_name(node) != "sheet":
            continue
        if node.get("state") in ("hidden", "veryHidden"):
            continue
        target = rels.get(node.get(qn("r:id")), {}).get("target")
        if not target:
            continue
        try:
            sheets.append(_read_sheet(package, target, node.get("name") or "시트", shared,
                                      date_styles))
        except BrokenDocument as exc:
            warnings.append("%s: %s" % (node.get("name"), exc))
    if not sheets:
        raise BrokenDocument("표시할 수 있는 시트가 없습니다.")
    return {"kind": "spreadsheet", "sheets": sheets, "warnings": warnings}


def _read_shared_strings(package):
    root = parse_part(package, "xl/sharedStrings.xml")
    if root is None:
        return []
    strings = []
    for item in root:
        if local_name(item) != "si":
            continue
        strings.append("".join(node.text or "" for node in item.iter(qn("s:t"))))
    return strings


def _read_date_styles(package):
    """Return a list telling for each cell format whether it renders a date."""
    root = parse_part(package, "xl/styles.xml")
    if root is None:
        return []
    custom = {}
    formats = root.find(qn("s:numFmts"))
    for node in (formats if formats is not None else []):
        try:
            custom[int(node.get("numFmtId"))] = node.get("formatCode") or ""
        except (TypeError, ValueError):
            continue
    result = []
    cell_formats = root.find(qn("s:cellXfs"))
    for node in (cell_formats if cell_formats is not None else []):
        try:
            format_id = int(node.get("numFmtId") or 0)
        except ValueError:
            format_id = 0
        code = custom.get(format_id)
        if code is None:
            result.append("date" if format_id in _BUILTIN_DATE_FORMATS else None)
            continue
        result.append(_classify_format(code))
    return result


def _classify_format(code):
    stripped = _ESCAPED.sub("", code or "")
    has_date = bool(_DATE_CHARS.search(stripped))
    has_time = bool(_TIME_CHARS.search(stripped))
    if has_date and has_time:
        return "datetime"
    if has_date:
        return "date"
    if has_time:
        return "time"
    if "%" in stripped:
        return "percent"
    return None


def _read_sheet(package, part, name, shared, date_styles):
    data = read_part(package, part)
    if data is None:
        raise BrokenDocument("시트 파트가 없습니다: %s" % part)
    root = parse_part(package, part)
    rows = []
    truncated = False
    max_column = 0
    sheet_data = root.find(qn("s:sheetData"))
    for row_node in (sheet_data if sheet_data is not None else []):
        if local_name(row_node) != "row":
            continue
        if len(rows) >= MAX_ROWS:
            truncated = True
            break
        index = _int(row_node.get("r"), len(rows) + 1)
        while len(rows) < index - 1 and len(rows) < MAX_ROWS:
            rows.append([])
        cells = []
        for cell in row_node:
            if local_name(cell) != "c":
                continue
            column = _column_index(cell.get("r"), len(cells))
            if column >= MAX_COLUMNS:
                truncated = True
                continue
            while len(cells) < column:
                cells.append(None)
            cells.append(_read_cell(cell, shared, date_styles))
        max_column = max(max_column, len(cells))
        rows.append(cells)
    for row in rows:
        row.extend([None] * (max_column - len(row)))
    while rows and not any(rows[-1]):
        rows.pop()
    return {"name": name, "rows": rows, "merges": _read_merges(root),
            "widths": _read_widths(root, max_column), "truncated": truncated}


def _read_merges(root):
    merges = []
    container = root.find(qn("s:mergeCells"))
    for node in (container if container is not None else []):
        reference = node.get("ref") or ""
        start, _, end = reference.partition(":")
        if not end:
            continue
        first_column = _column_index(start, 0)
        last_column = _column_index(end, 0)
        first_row = _row_index(start)
        last_row = _row_index(end)
        if None in (first_row, last_row):
            continue
        merges.append({"r": first_row - 1, "c": first_column,
                       "rs": last_row - first_row + 1, "cs": last_column - first_column + 1})
    return merges


def _read_widths(root, columns):
    widths = [None] * columns
    container = root.find(qn("s:cols"))
    for node in (container if container is not None else []):
        try:
            first = int(node.get("min")) - 1
            last = min(int(node.get("max")) - 1, columns - 1)
            width = float(node.get("width") or 0)
        except (TypeError, ValueError):
            continue
        for index in range(max(first, 0), last + 1):
            widths[index] = round(width * 7.5)
    return widths


def _read_cell(cell, shared, date_styles):
    cell_type = cell.get("t") or "n"
    value_node = cell.find(qn("s:v"))
    if cell_type == "inlineStr":
        inline = cell.find(qn("s:is"))
        text = "".join(node.text or "" for node in inline.iter(qn("s:t"))) if inline is not None \
            else ""
        return {"v": text} if text else None
    if value_node is None or value_node.text is None:
        return None
    raw = value_node.text
    if cell_type == "s":
        index = _int(raw, -1)
        if 0 <= index < len(shared):
            return {"v": shared[index]}
        return None
    if cell_type == "b":
        return {"v": "TRUE" if raw not in ("0", "false") else "FALSE"}
    if cell_type == "e":
        return {"v": raw, "e": True}
    if cell_type in ("str", "d"):
        return {"v": raw}
    style = _classify_style(cell, date_styles)
    return _numeric_cell(raw, style)


def _classify_style(cell, date_styles):
    index = _int(cell.get("s"), -1)
    if 0 <= index < len(date_styles):
        return date_styles[index]
    return None


def _numeric_cell(raw, style):
    try:
        number = float(raw)
    except ValueError:
        return {"v": raw}
    if style in ("date", "datetime", "time"):
        formatted = _format_serial(number, style)
        if formatted is not None:
            return {"v": formatted, "n": True}
    if style == "percent":
        return {"v": _format_number(number * 100) + "%", "n": True}
    return {"v": _format_number(number), "n": True}


def _format_serial(serial, style):
    try:
        if serial < 0 or serial > 2958466:
            return None
        # Excel wrongly considers 1900 a leap year; dates before 1900-03-01 shift by one day.
        moment = _EPOCH + datetime.timedelta(days=serial + (1 if serial < 60 else 0))
    except (OverflowError, ValueError):
        return None
    if style == "time":
        return moment.strftime("%H:%M:%S")
    if style == "datetime":
        return moment.strftime("%Y-%m-%d %H:%M:%S")
    return moment.strftime("%Y-%m-%d")


def _format_number(number):
    if number == int(number) and abs(number) < 1e15:
        return str(int(number))
    text = "%.10g" % number
    return text


def _column_index(reference, fallback=0):
    if not reference:
        return fallback
    index = 0
    for char in reference:
        if not char.isalpha():
            break
        index = index * 26 + (ord(char.upper()) - 64)
    return max(index - 1, 0) if index else fallback


def _row_index(reference):
    digits = "".join(char for char in (reference or "") if char.isdigit())
    return int(digits) if digits else None


def _int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default
