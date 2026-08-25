"""Render a PowerPoint (.pptx) package into positioned HTML slides."""

import html

from docviewer.render.ooxml import (BrokenDocument, escape, local_name, open_package, parse_part,
                                    qn, relationships)


EMU_PER_PX = 9525.0
DEFAULT_WIDTH = 960
DEFAULT_HEIGHT = 540
MAX_SLIDES = 500

_ALIGNMENTS = {"l": "left", "ctr": "center", "r": "right", "just": "justify",
               "dist": "justify"}


def render_pptx(path, media_url=None):
    """Return ``{"kind": "presentation", "slides": [...]}`` for *path*."""
    package = open_package(path)
    try:
        return _PptxRenderer(package, media_url).render()
    finally:
        package.close()


class _PptxRenderer:

    def __init__(self, package, media_url=None):
        self.package = package
        self.media_url = media_url or (lambda part: "")
        self.warnings = []

    def render(self):
        presentation = parse_part(self.package, "ppt/presentation.xml")
        if presentation is None:
            raise BrokenDocument("ppt/presentation.xml 파트를 찾을 수 없습니다.")
        width, height = self._slide_size(presentation)
        rels = relationships(self.package, "ppt/presentation.xml")
        slides = []
        id_list = presentation.find(qn("p:sldIdLst"))
        for node in (id_list if id_list is not None else []):
            if local_name(node) != "sldId":
                continue
            target = rels.get(node.get(qn("r:id")), {}).get("target")
            if not target:
                continue
            if len(slides) >= MAX_SLIDES:
                self.warnings.append("슬라이드가 너무 많아 %d장까지만 표시합니다." % MAX_SLIDES)
                break
            try:
                slides.append(self._render_slide(target, len(slides) + 1))
            except BrokenDocument as exc:
                self.warnings.append("%d번 슬라이드를 읽지 못했습니다: %s" % (len(slides) + 1, exc))
        if not slides:
            raise BrokenDocument("표시할 슬라이드가 없습니다.")
        return {"kind": "presentation", "width": width, "height": height, "slides": slides,
                "warnings": self.warnings}

    def _slide_size(self, presentation):
        size = presentation.find(qn("p:sldSz"))
        if size is None:
            return DEFAULT_WIDTH, DEFAULT_HEIGHT
        width = _px(size.get("cx"), DEFAULT_WIDTH)
        height = _px(size.get("cy"), DEFAULT_HEIGHT)
        return round(width), round(height)

    def _render_slide(self, part, number):
        root = parse_part(self.package, part)
        if root is None:
            raise BrokenDocument("슬라이드 파트가 없습니다.")
        rels = relationships(self.package, part)
        tree = root.find(qn("p:cSld"))
        tree = tree.find(qn("p:spTree")) if tree is not None else None
        shapes = []
        if tree is not None:
            self._collect_shapes(tree, rels, shapes, (0.0, 0.0, 1.0, 1.0))
        return {"number": number, "shapes": shapes, "notes": self._read_notes(rels),
                "title": _slide_title(shapes)}

    def _collect_shapes(self, container, rels, shapes, transform):
        for node in container:
            name = local_name(node)
            if name == "sp":
                shape = self._render_text_shape(node, transform)
                if shape:
                    shapes.append(shape)
            elif name == "pic":
                shape = self._render_picture(node, rels, transform)
                if shape:
                    shapes.append(shape)
            elif name == "graphicFrame":
                shape = self._render_graphic_frame(node, transform)
                if shape:
                    shapes.append(shape)
            elif name == "grpSp":
                self._collect_shapes(node, rels, shapes, _group_transform(node, transform))
            elif name == "cxnSp":
                continue  # connectors carry no readable content

    def _render_text_shape(self, node, transform):
        body = node.find(qn("p:txBody"))
        if body is None:
            return None
        html = self._render_text_body(body)
        if not html.strip():
            return None
        box = _geometry(node.find(qn("p:spPr")), transform)
        return dict(box, kind="text", html=html)

    def _render_text_body(self, body):
        parts = []
        for paragraph in body.findall(qn("a:p")):
            properties = paragraph.find(qn("a:pPr"))
            styles = []
            alignment = _ALIGNMENTS.get((properties.get("algn") if properties is not None else "")
                                        or "")
            if alignment:
                styles.append("text-align:%s" % alignment)
            level = _int(properties.get("lvl") if properties is not None else 0, 0)
            bullet = properties is not None and properties.find(qn("a:buNone")) is None \
                and (properties.find(qn("a:buChar")) is not None
                     or properties.find(qn("a:buAutoNum")) is not None)
            if level or bullet:
                styles.append("margin-left:%dpx" % (level * 24 + (16 if bullet else 0)))
            text = "".join(self._render_run(run) for run in paragraph
                           if local_name(run) in ("r", "br", "fld"))
            classes = "dv-slide-line" + (" dv-bullet" if bullet else "")
            attributes = " style=\"%s\"" % escape(";".join(styles)) if styles else ""
            parts.append("<p class=\"%s\"%s>%s</p>" % (classes, attributes, text or "<br>"))
        return "".join(parts)

    def _render_run(self, run):
        if local_name(run) == "br":
            return "<br>"
        text_node = run.find(qn("a:t"))
        text = escape(text_node.text or "") if text_node is not None else ""
        if not text:
            return ""
        properties = run.find(qn("a:rPr"))
        if properties is None:
            return text
        styles = []
        size = properties.get("sz")
        if size:
            styles.append("font-size:%.1fpx" % (_int(size, 1800) / 100.0 * 96 / 72))
        if properties.get("b") == "1":
            text = "<strong>%s</strong>" % text
        if properties.get("i") == "1":
            text = "<em>%s</em>" % text
        if properties.get("u") not in (None, "none"):
            text = "<u>%s</u>" % text
        color = properties.find(qn("a:solidFill"))
        color = color.find(qn("a:srgbClr")) if color is not None else None
        if color is not None and color.get("val"):
            styles.append("color:#%s" % escape(color.get("val")))
        if styles:
            text = "<span style=\"%s\">%s</span>" % (escape(";".join(styles)), text)
        return text

    def _render_picture(self, node, rels, transform):
        blip = None
        for candidate in node.iter(qn("a:blip")):
            blip = candidate
            break
        if blip is None:
            return None
        part = rels.get(blip.get(qn("r:embed")), {}).get("target")
        if not part:
            return None
        box = _geometry(node.find(qn("p:spPr")), transform)
        return dict(box, kind="image", src=self.media_url(part))

    def _render_graphic_frame(self, node, transform):
        table = None
        for candidate in node.iter(qn("a:tbl")):
            table = candidate
            break
        box = _geometry(node.find(qn("p:xfrm")), transform)
        if table is None:
            for chart in node.iter(qn("c:chart")):
                return dict(box, kind="text",
                            html="<p class=\"dv-slide-line dv-placeholder\">[차트]</p>")
            return None
        rows = []
        for row in table.findall(qn("a:tr")):
            cells = []
            for cell in row.findall(qn("a:tc")):
                body = cell.find(qn("a:txBody"))
                cells.append(self._render_text_body(body) if body is not None else "")
            rows.append(cells)
        html = ["<table class=\"dv-slide-table\">"]
        for index, row in enumerate(rows):
            html.append("<tr>")
            tag = "th" if index == 0 else "td"
            for cell in row:
                html.append("<%s>%s</%s>" % (tag, cell or "&nbsp;", tag))
            html.append("</tr>")
        html.append("</table>")
        return dict(box, kind="text", html="".join(html))

    def _read_notes(self, rels):
        for rel in rels.values():
            if rel.get("type", "").endswith("/notesSlide"):
                root = parse_part(self.package, rel["target"])
                if root is None:
                    continue
                lines = []
                for paragraph in root.iter(qn("a:p")):
                    text = "".join(node.text or "" for node in paragraph.iter(qn("a:t")))
                    if text.strip():
                        lines.append(text)
                # the first line repeats the slide number placeholder in many decks
                return "\n".join(lines).strip()
        return ""


def _group_transform(node, parent):
    """Combine the transform of a group shape with the one of its parent."""
    xfrm = None
    properties = node.find(qn("p:grpSpPr"))
    if properties is not None:
        xfrm = properties.find(qn("a:xfrm"))
    if xfrm is None:
        return parent
    offset = xfrm.find(qn("a:off"))
    extent = xfrm.find(qn("a:ext"))
    child_offset = xfrm.find(qn("a:chOff"))
    child_extent = xfrm.find(qn("a:chExt"))
    if None in (offset, extent, child_offset, child_extent):
        return parent
    scale_x = _ratio(extent.get("cx"), child_extent.get("cx"))
    scale_y = _ratio(extent.get("cy"), child_extent.get("cy"))
    parent_x, parent_y, parent_sx, parent_sy = parent
    x = parent_x + _px(offset.get("x"), 0) * parent_sx
    y = parent_y + _px(offset.get("y"), 0) * parent_sy
    x -= _px(child_offset.get("x"), 0) * scale_x * parent_sx
    y -= _px(child_offset.get("y"), 0) * scale_y * parent_sy
    return (x, y, parent_sx * scale_x, parent_sy * scale_y)


def _geometry(properties, transform):
    """Return the position and size of a shape in slide pixels."""
    offset_x, offset_y, scale_x, scale_y = transform
    xfrm = None
    if properties is not None:
        xfrm = properties if local_name(properties) == "xfrm" else properties.find(qn("a:xfrm"))
    if xfrm is None:
        return {"x": None, "y": None, "w": None, "h": None}
    offset = xfrm.find(qn("a:off"))
    extent = xfrm.find(qn("a:ext"))
    if offset is None or extent is None:
        return {"x": None, "y": None, "w": None, "h": None}
    rotation = _int(xfrm.get("rot"), 0) / 60000.0
    return {"x": round(offset_x + _px(offset.get("x"), 0) * scale_x, 1),
            "y": round(offset_y + _px(offset.get("y"), 0) * scale_y, 1),
            "w": round(_px(extent.get("cx"), 0) * scale_x, 1),
            "h": round(_px(extent.get("cy"), 0) * scale_y, 1),
            "rot": round(rotation, 2) if rotation else 0}


def _slide_title(shapes):
    for shape in shapes:
        if shape.get("kind") != "text":
            continue
        text = shape.get("html", "")
        plain = _strip_tags(text).strip()
        if plain:
            return plain.split("\n")[0][:80]
    return ""


def _strip_tags(markup):
    out = []
    depth = 0
    for char in markup:
        if char == "<":
            depth += 1
        elif char == ">":
            depth -= 1
        elif depth == 0:
            out.append(char)
    return html.unescape("".join(out))


def _px(value, default=0.0):
    try:
        return int(value) / EMU_PER_PX
    except (TypeError, ValueError):
        return default


def _ratio(numerator, denominator):
    try:
        denominator = int(denominator)
        if denominator == 0:
            return 1.0
        return int(numerator) / float(denominator)
    except (TypeError, ValueError):
        return 1.0


def _int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default
