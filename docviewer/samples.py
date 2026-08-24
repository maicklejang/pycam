"""Build small but valid sample files for every supported format.

They are used by the test suite and by ``python3 -m docviewer --samples DIR``,
which fills a folder with examples to try the viewer out.  Everything is
written with the standard library, so no office suite is needed to create them.
"""

import os
import struct
import zlib
import zipfile


CONTENT_TYPES_DOCX = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""

ROOT_RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="{target}"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>"""

CORE_PROPERTIES = """<?xml version="1.0" encoding="UTF-8"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">
  <dc:title>{title}</dc:title>
  <dc:creator>docviewer</dc:creator>
  <dcterms:modified>2026-01-01T00:00:00Z</dcterms:modified>
</cp:coreProperties>"""

W_NS = ('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"')

DOCUMENT_XML = """<?xml version="1.0" encoding="UTF-8"?>
<w:document {ns}>
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>보고서 제목</w:t></w:r></w:p>
    <w:p>
      <w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">굵은 글씨 </w:t></w:r>
      <w:r><w:rPr><w:i/></w:rPr><w:t>기울임</w:t></w:r>
      <w:r><w:t xml:space="preserve"> 그리고 보통 글씨 &amp; 특수문자</w:t></w:r>
    </w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>
      <w:r><w:t>첫 번째 항목</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>
      <w:r><w:t>두 번째 항목</w:t></w:r></w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>병합된 머리글</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:p><w:r><w:drawing><wp:inline><wp:extent cx="1905000" cy="1905000"/>
      <a:graphic><a:graphicData><a:blip r:embed="rIdImg"/></a:graphicData></a:graphic>
    </wp:inline></w:drawing></w:r></w:p>
    <w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>PyCAM 홈페이지</w:t></w:r></w:hyperlink></w:p>
  </w:body>
</w:document>""".replace("{ns}", W_NS)

DOCUMENT_RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
  <Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="http://pycam.sf.net/" TargetMode="External"/>
  <Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>"""

NUMBERING_XML = """<?xml version="1.0" encoding="UTF-8"?>
<w:numbering {ns}>
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>""".replace("{ns}", W_NS)


def build_docx(path):
    """Write a small Word document exercising headings, lists, tables and images."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr("[Content_Types].xml", CONTENT_TYPES_DOCX)
        package.writestr("_rels/.rels", ROOT_RELS.format(target="word/document.xml"))
        package.writestr("docProps/core.xml", CORE_PROPERTIES.format(title="예제 문서"))
        package.writestr("word/document.xml", DOCUMENT_XML)
        package.writestr("word/_rels/document.xml.rels", DOCUMENT_RELS)
        package.writestr("word/numbering.xml", NUMBERING_XML)
        package.writestr("word/media/image1.png", png_bytes(120, 90, (46, 111, 235)))
    return path


CONTENT_TYPES_XLSX = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
</Types>"""

S_NS = ('xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"')

WORKBOOK_XML = """<?xml version="1.0" encoding="UTF-8"?>
<workbook {ns}>
  <sheets>
    <sheet name="판매" sheetId="1" r:id="rId1"/>
    <sheet name="요약" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>""".replace("{ns}", S_NS)

WORKBOOK_RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"""

SHARED_STRINGS = """<?xml version="1.0" encoding="UTF-8"?>
<sst {ns} count="5" uniqueCount="5">
  <si><t>품목</t></si>
  <si><t>수량</t></si>
  <si><t>날짜</t></si>
  <si><t>볼트</t></si>
  <si><t>너트</t></si>
</sst>""".replace("{ns}", S_NS)

STYLES_XML = """<?xml version="1.0" encoding="UTF-8"?>
<styleSheet {ns}>
  <cellXfs count="2">
    <xf numFmtId="0"/>
    <xf numFmtId="14"/>
  </cellXfs>
</styleSheet>""".replace("{ns}", S_NS)

SHEET1_XML = """<?xml version="1.0" encoding="UTF-8"?>
<worksheet {ns}>
  <cols><col min="1" max="1" width="18"/></cols>
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="s"><v>1</v></c>
      <c r="C1" t="s"><v>2</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>3</v></c>
      <c r="B2"><v>12</v></c>
      <c r="C2" s="1"><v>45000</v></c>
    </row>
    <row r="3">
      <c r="A3" t="s"><v>4</v></c>
      <c r="B3"><v>7.5</v></c>
      <c r="C3" s="1"><v>45001</v></c>
    </row>
  </sheetData>
  <mergeCells count="1"><mergeCell ref="A5:B5"/></mergeCells>
</worksheet>""".replace("{ns}", S_NS)

SHEET2_XML = """<?xml version="1.0" encoding="UTF-8"?>
<worksheet {ns}>
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>합계</t></is></c><c r="B1"><v>19.5</v></c></row>
  </sheetData>
</worksheet>""".replace("{ns}", S_NS)


def build_xlsx(path):
    """Write a small workbook with two sheets, shared strings and a date column."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr("[Content_Types].xml", CONTENT_TYPES_XLSX)
        package.writestr("_rels/.rels", ROOT_RELS.format(target="xl/workbook.xml"))
        package.writestr("docProps/core.xml", CORE_PROPERTIES.format(title="예제 통합 문서"))
        package.writestr("xl/workbook.xml", WORKBOOK_XML)
        package.writestr("xl/_rels/workbook.xml.rels", WORKBOOK_RELS)
        package.writestr("xl/sharedStrings.xml", SHARED_STRINGS)
        package.writestr("xl/styles.xml", STYLES_XML)
        package.writestr("xl/worksheets/sheet1.xml", SHEET1_XML)
        package.writestr("xl/worksheets/sheet2.xml", SHEET2_XML)
    return path


CONTENT_TYPES_PPTX = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
</Types>"""

P_NS = ('xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"')

PRESENTATION_XML = """<?xml version="1.0" encoding="UTF-8"?>
<p:presentation {ns}>
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId1"/>
    <p:sldId id="257" r:id="rId2"/>
  </p:sldIdLst>
  <p:sldSz cx="9144000" cy="5143500"/>
</p:presentation>""".replace("{ns}", P_NS)

PRESENTATION_RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
</Relationships>"""

SLIDE1_XML = """<?xml version="1.0" encoding="UTF-8"?>
<p:sld {ns}><p:cSld><p:spTree>
  <p:sp>
    <p:spPr><a:xfrm><a:off x="457200" y="533400"/><a:ext cx="8229600" cy="1143000"/></a:xfrm></p:spPr>
    <p:txBody><a:p><a:r><a:rPr sz="4000" b="1"/><a:t>발표 제목</a:t></a:r></a:p></p:txBody>
  </p:sp>
  <p:sp>
    <p:spPr><a:xfrm><a:off x="457200" y="2057400"/><a:ext cx="8229600" cy="2286000"/></a:xfrm></p:spPr>
    <p:txBody>
      <a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:t>첫째 줄</a:t></a:r></a:p>
      <a:p><a:pPr lvl="1"><a:buChar char="-"/></a:pPr><a:r><a:t>둘째 줄</a:t></a:r></a:p>
    </p:txBody>
  </p:sp>
</p:spTree></p:cSld></p:sld>""".replace("{ns}", P_NS)

SLIDE2_XML = """<?xml version="1.0" encoding="UTF-8"?>
<p:sld {ns}><p:cSld><p:spTree>
  <p:sp>
    <p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="4000000" cy="800000"/></a:xfrm></p:spPr>
    <p:txBody><a:p><a:r><a:rPr sz="3200"/><a:t>그림이 있는 장</a:t></a:r></a:p></p:txBody>
  </p:sp>
  <p:pic>
    <p:spPr><a:xfrm><a:off x="4800000" y="1200000"/><a:ext cx="3000000" cy="2250000"/></a:xfrm></p:spPr>
    <p:blipFill><a:blip r:embed="rIdImg"/></p:blipFill>
  </p:pic>
</p:spTree></p:cSld></p:sld>""".replace("{ns}", P_NS)

SLIDE1_RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdNotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
</Relationships>"""

SLIDE2_RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
</Relationships>"""

NOTES_XML = """<?xml version="1.0" encoding="UTF-8"?>
<p:notes {ns}><p:cSld><p:spTree>
  <p:sp><p:txBody><a:p><a:r><a:t>발표자 노트 예시입니다.</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:notes>""".replace("{ns}", P_NS)


def build_pptx(path):
    """Write a two slide deck with text, a bullet list, an image and notes."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr("[Content_Types].xml", CONTENT_TYPES_PPTX)
        package.writestr("_rels/.rels", ROOT_RELS.format(target="ppt/presentation.xml"))
        package.writestr("docProps/core.xml", CORE_PROPERTIES.format(title="예제 발표"))
        package.writestr("ppt/presentation.xml", PRESENTATION_XML)
        package.writestr("ppt/_rels/presentation.xml.rels", PRESENTATION_RELS)
        package.writestr("ppt/slides/slide1.xml", SLIDE1_XML)
        package.writestr("ppt/slides/slide2.xml", SLIDE2_XML)
        package.writestr("ppt/slides/_rels/slide1.xml.rels", SLIDE1_RELS)
        package.writestr("ppt/slides/_rels/slide2.xml.rels", SLIDE2_RELS)
        package.writestr("ppt/notesSlides/notesSlide1.xml", NOTES_XML)
        package.writestr("ppt/media/image1.png", png_bytes(200, 150, (240, 160, 60)))
    return path


def png_bytes(width, height, color=(60, 120, 220)):
    """Return the bytes of a solid colour png image."""
    raw = b"".join(b"\x00" + bytes(color) * width for _ in range(height))

    def chunk(tag, payload):
        data = tag + payload
        return struct.pack(">I", len(payload)) + data + struct.pack(">I", zlib.crc32(data))

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def build_png(path, width=320, height=200, color=(60, 120, 220)):
    with open(path, "wb") as target:
        target.write(png_bytes(width, height, color))
    return path


def build_pdf(path, text="docviewer sample PDF"):
    """Write a minimal one page PDF with a line of text."""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        None,  # filled in below
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    stream = ("BT /F1 16 Tf 24 120 Td (%s) Tj ET" % text).encode("ascii", "replace")
    objects[3] = b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream)
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (number, body)
    xref_position = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1, xref_position)
    with open(path, "wb") as target:
        target.write(bytes(out))
    return path


def build_csv(path):
    with open(path, "w", encoding="utf-8") as target:
        target.write("공구,지름(mm),재질\n엔드밀,6,초경\n드릴,3.2,HSS\n")
    return path


def build_all(directory):
    """Create one sample of every supported format inside *directory*."""
    os.makedirs(directory, exist_ok=True)
    return {
        "docx": build_docx(os.path.join(directory, "예제문서.docx")),
        "xlsx": build_xlsx(os.path.join(directory, "예제표.xlsx")),
        "pptx": build_pptx(os.path.join(directory, "예제발표.pptx")),
        "pdf": build_pdf(os.path.join(directory, "예제.pdf")),
        "png": build_png(os.path.join(directory, "예제그림.png")),
        "csv": build_csv(os.path.join(directory, "예제표.csv")),
    }
