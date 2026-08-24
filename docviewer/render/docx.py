"""Render a Word (.docx) package into HTML."""

from docviewer.render.ooxml import (BrokenDocument, escape, local_name, open_package, parse_part,
                                    qn, relationships)


# Word style ids that should become headings.
_HEADING_STYLES = {
    "title": "h1",
    "subtitle": "h2",
    "heading1": "h1",
    "heading2": "h2",
    "heading3": "h3",
    "heading4": "h4",
    "heading5": "h5",
    "heading6": "h6",
}

_ALIGNMENTS = {"left": "left", "start": "left", "center": "center", "right": "right",
               "end": "right", "both": "justify", "distribute": "justify"}

# Enough for any sane document - protects against pathological files.
MAX_BLOCKS = 20000


def render_docx(path, media_url=None):
    """Return ``{"kind": "document", "html": ..., "warnings": [...]}`` for *path*."""
    package = open_package(path)
    try:
        return _DocxRenderer(package, media_url).render()
    finally:
        package.close()


class _DocxRenderer:

    def __init__(self, package, media_url=None):
        self.package = package
        self.media_url = media_url or (lambda part: "")
        self.rels = relationships(package, "word/document.xml")
        self.numbering = _read_numbering(package)
        self.warnings = []
        self.blocks = 0
        self.list_stack = []

    def render(self):
        document = parse_part(self.package, "word/document.xml")
        if document is None:
            raise BrokenDocument("word/document.xml 파트를 찾을 수 없습니다.")
        body = document.find(qn("w:body"))
        if body is None:
            raise BrokenDocument("문서 본문이 비어 있습니다.")
        out = []
        self._render_blocks(body, out)
        self._close_lists(0, out)
        if not out:
            self.warnings.append("표시할 내용이 없는 문서입니다.")
        return {"kind": "document", "html": "".join(out), "warnings": self.warnings}

    # -- block level ------------------------------------------------------

    def _render_blocks(self, container, out):
        for child in container:
            name = local_name(child)
            if self.blocks >= MAX_BLOCKS:
                self.warnings.append("문서가 너무 길어 일부만 표시합니다.")
                return
            if name == "p":
                self.blocks += 1
                self._render_paragraph(child, out)
            elif name == "tbl":
                self.blocks += 1
                self._close_lists(0, out)
                self._render_table(child, out)
            elif name in ("sdt", "smartTag"):
                content = child.find(qn("w:sdtContent")) if name == "sdt" else child
                if content is not None:
                    self._render_blocks(content, out)

    def _render_paragraph(self, paragraph, out):
        properties = paragraph.find(qn("w:pPr"))
        style = _style_id(properties)
        list_info = self._list_info(properties)
        inline = self._render_runs(paragraph)
        if list_info is None:
            self._close_lists(0, out)
        else:
            self._open_lists(list_info, out)
        if not inline.strip():
            if list_info is None:
                out.append("<p class=\"dv-empty\"></p>")
            else:
                out.append("<li></li>")
            return
        if list_info is not None:
            out.append("<li>%s</li>" % inline)
            return
        tag = _HEADING_STYLES.get(style)
        attributes = _paragraph_style(properties)
        if tag:
            out.append("<%s%s>%s</%s>" % (tag, attributes, inline, tag))
        else:
            out.append("<p%s>%s</p>" % (attributes, inline))

    def _list_info(self, properties):
        """Return ``(level, ordered)`` when the paragraph belongs to a list."""
        if properties is None:
            return None
        num_pr = properties.find(qn("w:numPr"))
        if num_pr is None:
            return None
        num_id = _val(num_pr.find(qn("w:numId")))
        level = _val(num_pr.find(qn("w:ilvl"))) or "0"
        try:
            level = max(0, min(int(level), 8))
        except ValueError:
            level = 0
        if num_id in (None, "0"):
            return None
        ordered = self.numbering.get((num_id, level), True)
        return level, ordered

    def _open_lists(self, list_info, out):
        level, ordered = list_info
        self._close_lists(level + 1, out)
        while len(self.list_stack) <= level:
            tag = "ol" if ordered else "ul"
            self.list_stack.append(tag)
            out.append("<%s>" % tag)
        if self.list_stack[level] != ("ol" if ordered else "ul"):
            # the list type changed on the same level: restart the list
            self._close_lists(level, out)
            tag = "ol" if ordered else "ul"
            self.list_stack.append(tag)
            out.append("<%s>" % tag)

    def _close_lists(self, depth, out):
        while len(self.list_stack) > depth:
            out.append("</%s>" % self.list_stack.pop())

    def _render_table(self, table, out):
        rows = [child for child in table if local_name(child) == "tr"]
        if not rows:
            return
        out.append("<div class=\"dv-table-wrap\"><table class=\"dv-table\">")
        cells = []
        merge_owner = {}
        for row in rows:
            out.append("<tr>")
            column = 0
            for cell in row:
                if local_name(cell) != "tc":
                    continue
                span, merge = _cell_properties(cell)
                if merge == "continue" and column in merge_owner:
                    merge_owner[column]["rowspan"] += 1
                    column += span
                    continue
                content = []
                self._render_blocks(cell, content)
                self._close_lists(0, content)
                info = {"index": len(out), "span": span, "rowspan": 1, "out": out}
                cells.append(info)
                out.append("")  # placeholder for the opening tag, filled in below
                out.append("".join(content) or "&nbsp;")
                out.append("</td>")
                if merge == "restart":
                    merge_owner[column] = info
                else:
                    merge_owner.pop(column, None)
                column += span
            out.append("</tr>")
        for info in cells:
            _finish_cell(info)
        out.append("</table></div>")

    # -- inline level -----------------------------------------------------

    def _render_runs(self, container):
        parts = []
        for child in container:
            name = local_name(child)
            if name == "r":
                parts.append(self._render_run(child))
            elif name == "hyperlink":
                inner = self._render_runs(child)
                target = self.rels.get(child.get(qn("r:id")), {})
                anchor = child.get(qn("w:anchor"))
                href = target.get("target") if target.get("mode") == "External" else None
                if href:
                    parts.append("<a href=\"%s\" target=\"_blank\" rel=\"noopener\">%s</a>"
                                 % (escape(href), inner))
                elif anchor:
                    parts.append("<a href=\"#%s\">%s</a>" % (escape(anchor), inner))
                else:
                    parts.append(inner)
            elif name in ("sdt", "smartTag", "ins", "bookmarkStart"):
                content = child.find(qn("w:sdtContent")) if name == "sdt" else child
                if content is not None and name != "bookmarkStart":
                    parts.append(self._render_runs(content))
            elif name == "del":
                continue  # tracked deletion: not part of the current text
        return "".join(parts)

    def _render_run(self, run):
        properties = run.find(qn("w:rPr"))
        pieces = []
        for child in run:
            name = local_name(child)
            if name == "t":
                pieces.append(escape(child.text or ""))
            elif name == "tab":
                pieces.append("<span class=\"dv-tab\"></span>")
            elif name in ("br", "cr"):
                pieces.append("<br>")
            elif name in ("drawing", "pict", "object"):
                pieces.append(self._render_image(child))
            elif name == "noBreakHyphen":
                pieces.append("&#8209;")
            elif name == "sym":
                char = child.get(qn("w:char"))
                if char:
                    try:
                        pieces.append("&#%d;" % int(char, 16))
                    except ValueError:
                        pass
        text = "".join(pieces)
        if not text:
            return ""
        return _wrap_run(text, properties)

    def _render_image(self, element):
        part = None
        for blip in element.iter(qn("a:blip")):
            part = self.rels.get(blip.get(qn("r:embed")), {}).get("target")
            if part:
                break
        if part is None:
            for data in element.iter("{urn:schemas-microsoft-com:vml}imagedata"):
                part = self.rels.get(data.get(qn("r:id")), {}).get("target")
                if part:
                    break
        if not part:
            return ""
        width = ""
        for extent in element.iter(qn("a:ext")):
            pixels = extent.get("cx")
            if pixels:
                try:
                    width = " style=\"width:%.0fpx\"" % (int(pixels) / 9525.0)
                except ValueError:
                    width = ""
                break
        return "<img class=\"dv-inline-image\" src=\"%s\" alt=\"\" loading=\"lazy\"%s>" % (
            escape(self.media_url(part)), width)


def _cell_properties(cell):
    """Return ``(gridSpan, vMerge)`` of a table cell."""
    properties = cell.find(qn("w:tcPr"))
    if properties is None:
        return 1, None
    span = max(1, _int(_val(properties.find(qn("w:gridSpan"))), 1))
    merge_element = properties.find(qn("w:vMerge"))
    merge = None
    if merge_element is not None:
        merge = merge_element.get(qn("w:val"), "continue")
        if merge not in ("restart", "continue"):
            merge = "continue"
    return span, merge


def _finish_cell(info):
    attributes = ""
    if info["span"] > 1:
        attributes += " colspan=\"%d\"" % info["span"]
    if info["rowspan"] > 1:
        attributes += " rowspan=\"%d\"" % info["rowspan"]
    info["out"][info["index"]] = "<td%s>" % attributes


def _wrap_run(text, properties):
    if properties is None:
        return text
    styles = []
    if _flag(properties, "w:b"):
        text = "<strong>%s</strong>" % text
    if _flag(properties, "w:i"):
        text = "<em>%s</em>" % text
    if _flag(properties, "w:u"):
        text = "<u>%s</u>" % text
    if _flag(properties, "w:strike") or _flag(properties, "w:dstrike"):
        text = "<s>%s</s>" % text
    vertical = _val(properties.find(qn("w:vertAlign")))
    if vertical == "superscript":
        text = "<sup>%s</sup>" % text
    elif vertical == "subscript":
        text = "<sub>%s</sub>" % text
    color = _val(properties.find(qn("w:color")))
    if color and color not in ("auto", "000000"):
        styles.append("color:#%s" % escape(color))
    highlight = _val(properties.find(qn("w:highlight")))
    if highlight and highlight != "none":
        styles.append("background-color:%s" % escape(highlight))
    size = _val(properties.find(qn("w:sz")))
    if size:
        try:
            styles.append("font-size:%.2fem" % (int(size) / 2.0 / 11.0))
        except ValueError:
            pass
    if styles:
        text = "<span style=\"%s\">%s</span>" % (escape(";".join(styles)), text)
    return text


def _paragraph_style(properties):
    if properties is None:
        return ""
    styles = []
    alignment = _ALIGNMENTS.get(_val(properties.find(qn("w:jc"))) or "")
    if alignment:
        styles.append("text-align:%s" % alignment)
    indent = properties.find(qn("w:ind"))
    if indent is not None:
        left = indent.get(qn("w:left")) or indent.get(qn("w:start"))
        try:
            if left and int(left) > 0:
                styles.append("margin-left:%.1fpx" % (int(left) / 20.0 * 96 / 72))
        except ValueError:
            pass
    if not styles:
        return ""
    return " style=\"%s\"" % escape(";".join(styles))


def _style_id(properties):
    if properties is None:
        return ""
    style = _val(properties.find(qn("w:pStyle"))) or ""
    return style.replace(" ", "").replace("-", "").lower()


def _flag(properties, name):
    element = properties.find(qn(name))
    if element is None:
        return False
    value = element.get(qn("w:val"))
    return value not in ("0", "false", "none", "off")


def _val(element):
    if element is None:
        return None
    return element.get(qn("w:val"))


def _int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _read_numbering(package):
    """Return ``{(numId, level): ordered}`` extracted from word/numbering.xml."""
    root = parse_part(package, "word/numbering.xml")
    if root is None:
        return {}
    abstract = {}
    for node in root.findall(qn("w:abstractNum")):
        abstract_id = node.get(qn("w:abstractNumId"))
        for level in node.findall(qn("w:lvl")):
            index = _int(level.get(qn("w:ilvl")), 0)
            fmt = _val(level.find(qn("w:numFmt"))) or "decimal"
            abstract[(abstract_id, index)] = fmt not in ("bullet", "none")
    numbering = {}
    for node in root.findall(qn("w:num")):
        num_id = node.get(qn("w:numId"))
        abstract_id = _val(node.find(qn("w:abstractNumId")))
        for (candidate, index), ordered in abstract.items():
            if candidate == abstract_id:
                numbering[(num_id, index)] = ordered
    return numbering
