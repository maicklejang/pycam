"""Tests for the document viewer: renderers, path handling and the http api."""

import json
import os
import shutil
import tempfile
import unittest
import urllib.error
import urllib.parse
import urllib.request

from docviewer import documents, filetypes, server
from docviewer.render.docx import render_docx
from docviewer.render.ooxml import BrokenDocument
from docviewer.render.pptx import render_pptx
from docviewer.render.xlsx import render_csv, render_xlsx
from docviewer import samples as builders


class FileTypeTest(unittest.TestCase):

    def test_kind_detection_ignores_case(self):
        self.assertEqual(filetypes.kind_of("/tmp/Report.DOCX"), "document")
        self.assertEqual(filetypes.kind_of("a.pdf"), "pdf")
        self.assertEqual(filetypes.kind_of("a.JPG"), "image")
        self.assertEqual(filetypes.kind_of("a.pptx"), "presentation")
        self.assertEqual(filetypes.kind_of("a.csv"), "spreadsheet")
        self.assertEqual(filetypes.kind_of("a.doc"), "legacy")

    def test_unsupported_extension(self):
        self.assertIsNone(filetypes.kind_of("archive.zip"))
        self.assertFalse(filetypes.is_supported("archive.zip"))

    def test_mime_types(self):
        self.assertEqual(filetypes.mime_type("a.pdf"), "application/pdf")
        self.assertEqual(filetypes.mime_type("a.unknown"), "application/octet-stream")


class RendererTestCase(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.mkdtemp(prefix="docviewer-test-")
        cls.files = builders.build_all(cls.directory)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.directory, ignore_errors=True)


class DocxTest(RendererTestCase):

    def setUp(self):
        self.result = render_docx(self.files["docx"], lambda part: "/media/" + part)
        self.html = self.result["html"]

    def test_heading_and_text_styles(self):
        self.assertIn("<h1>보고서 제목</h1>", self.html)
        self.assertIn("<strong>굵은 글씨 </strong>", self.html)
        self.assertIn("<em>기울임</em>", self.html)

    def test_special_characters_are_escaped(self):
        self.assertIn("보통 글씨 &amp; 특수문자", self.html)
        self.assertNotIn("보통 글씨 & 특수", self.html)

    def test_bullet_list(self):
        self.assertIn("<ul><li>첫 번째 항목</li><li>두 번째 항목</li></ul>", self.html)

    def test_table_with_horizontal_merge(self):
        self.assertIn("<td colspan=\"2\">", self.html)
        self.assertIn("<td><p>B1</p></td>", self.html)

    def test_images_and_links(self):
        self.assertIn("src=\"/media/word/media/image1.png\"", self.html)
        self.assertIn("href=\"http://pycam.sf.net/\"", self.html)

    def test_core_properties(self):
        properties = documents.core_properties(self.files["docx"])
        self.assertEqual(properties["제목"], "예제 문서")
        self.assertEqual(properties["작성자"], "docviewer")

    def test_broken_file_is_reported(self):
        broken = os.path.join(self.directory, "broken.docx")
        with open(broken, "wb") as target:
            target.write(b"not a zip file at all")
        with self.assertRaises(BrokenDocument):
            render_docx(broken)


class XlsxTest(RendererTestCase):

    def setUp(self):
        self.result = render_xlsx(self.files["xlsx"])
        self.sheets = self.result["sheets"]

    def test_sheet_names_and_order(self):
        self.assertEqual([sheet["name"] for sheet in self.sheets], ["판매", "요약"])

    def test_shared_strings_and_numbers(self):
        rows = self.sheets[0]["rows"]
        self.assertEqual(rows[0][0]["v"], "품목")
        self.assertEqual(rows[1][1], {"v": "12", "n": True})
        self.assertEqual(rows[2][1]["v"], "7.5")

    def test_date_formats_are_converted(self):
        self.assertEqual(self.sheets[0]["rows"][1][2]["v"], "2023-03-15")

    def test_inline_strings(self):
        self.assertEqual(self.sheets[1]["rows"][0][0]["v"], "합계")

    def test_merged_cells_and_column_widths(self):
        self.assertEqual(self.sheets[0]["merges"], [{"r": 4, "c": 0, "rs": 1, "cs": 2}])
        self.assertEqual(self.sheets[0]["widths"][0], 135)

    def test_column_index_helper(self):
        from docviewer.render.xlsx import _column_index
        self.assertEqual(_column_index("A1"), 0)
        self.assertEqual(_column_index("Z9"), 25)
        self.assertEqual(_column_index("AA3"), 26)

    def test_csv_is_read_as_a_single_sheet(self):
        result = render_csv(self.files["csv"])
        sheet = result["sheets"][0]
        self.assertEqual(sheet["rows"][0][0]["v"], "공구")
        self.assertTrue(sheet["rows"][1][1]["n"])

    def test_csv_falls_back_to_cp949(self):
        path = os.path.join(self.directory, "cp949.csv")
        with open(path, "wb") as target:
            target.write("이름,값\n한글,1\n".encode("cp949"))
        sheet = render_csv(path)["sheets"][0]
        self.assertEqual(sheet["rows"][1][0]["v"], "한글")


class PptxTest(RendererTestCase):

    def setUp(self):
        self.result = render_pptx(self.files["pptx"], lambda part: "/media/" + part)

    def test_slide_count_and_size(self):
        self.assertEqual(len(self.result["slides"]), 2)
        self.assertEqual((self.result["width"], self.result["height"]), (960, 540))

    def test_text_and_titles(self):
        first = self.result["slides"][0]
        self.assertEqual(first["title"], "발표 제목")
        self.assertIn("첫째 줄", first["shapes"][1]["html"])
        self.assertIn("dv-bullet", first["shapes"][1]["html"])

    def test_shape_geometry_in_pixels(self):
        shape = self.result["slides"][0]["shapes"][0]
        self.assertEqual((shape["x"], shape["y"]), (48.0, 56.0))
        self.assertEqual(shape["w"], 864.0)

    def test_images_are_linked(self):
        picture = self.result["slides"][1]["shapes"][1]
        self.assertEqual(picture["kind"], "image")
        self.assertEqual(picture["src"], "/media/ppt/media/image1.png")

    def test_speaker_notes(self):
        self.assertEqual(self.result["slides"][0]["notes"], "발표자 노트 예시입니다.")


class DocumentsTest(RendererTestCase):

    def test_pdf_and_image_are_handed_to_the_browser(self):
        self.assertEqual(documents.render(self.files["pdf"])["kind"], "pdf")
        self.assertEqual(documents.render(self.files["png"])["kind"], "image")

    def test_text_files(self):
        path = os.path.join(self.directory, "note.txt")
        with open(path, "w", encoding="utf-8") as target:
            target.write("가나다\nabc\n")
        payload = documents.render(path)
        self.assertEqual(payload["kind"], "text")
        self.assertIn("가나다", payload["text"])
        self.assertFalse(payload["truncated"])

    def test_broken_document_becomes_an_error_payload(self):
        broken = os.path.join(self.directory, "broken2.xlsx")
        with open(broken, "wb") as target:
            target.write(b"nope")
        payload = documents.render(broken)
        self.assertEqual(payload["kind"], "error")
        self.assertTrue(payload["message"])

    def test_legacy_without_converter_is_reported_not_crashed(self):
        legacy = os.path.join(self.directory, "old.doc")
        with open(legacy, "wb") as target:
            target.write(b"\xd0\xcf\x11\xe0")
        payload = documents.render(legacy)
        self.assertIn(payload["kind"], ("unsupported", "document", "error"))

    def test_media_extraction(self):
        data, mime = documents.read_media(self.files["docx"], "word/media/image1.png")
        self.assertEqual(mime, "image/png")
        self.assertTrue(data.startswith(b"\x89PNG"))

    def test_media_rejects_non_image_parts(self):
        with self.assertRaises(BrokenDocument):
            documents.read_media(self.files["docx"], "word/document.xml")


class ServerTest(RendererTestCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        os.makedirs(os.path.join(cls.directory, "하위폴더"), exist_ok=True)
        cls.server = server.create_server(cls.directory, port=0, quiet=True)
        cls.server.serve_in_background()
        cls.base = cls.server.url

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        super().tearDownClass()

    def get(self, path, headers=None):
        request = urllib.request.Request(self.base.rstrip("/") + path,
                                         headers=headers or {})
        return urllib.request.urlopen(request, timeout=10)

    def get_json(self, path):
        with self.get(path) as response:
            return json.loads(response.read().decode("utf-8"))

    def test_index_is_served(self):
        with self.get("/") as response:
            body = response.read().decode("utf-8")
        self.assertIn("문서 뷰어", body)
        self.assertEqual(response.headers["Content-Type"], "text/html; charset=utf-8")

    def test_static_assets(self):
        for name in ("style.css", "app.js"):
            with self.get("/static/" + name) as response:
                self.assertEqual(response.status, 200)
                self.assertTrue(response.read())

    def test_config(self):
        config = self.get_json("/api/config")
        self.assertEqual(config["root"], os.path.realpath(self.directory))
        self.assertIn("converter", config)

    def test_browse_lists_supported_files_only(self):
        listing = self.get_json("/api/browse?path=")
        names = [item["name"] for item in listing["files"]]
        self.assertIn("예제문서.docx", names)
        self.assertIn("하위폴더", [item["name"] for item in listing["directories"]])
        self.assertEqual(listing["breadcrumbs"][0]["path"], "")

    def test_document_endpoint_renders_docx(self):
        payload = self.get_json("/api/document?path=" + _quote("예제문서.docx"))
        self.assertEqual(payload["kind"], "document")
        self.assertIn("보고서 제목", payload["html"])
        self.assertIn("/api/media?path=", payload["html"])

    def test_media_endpoint_serves_embedded_images(self):
        with self.get("/api/media?path=%s&part=%s"
                      % (_quote("예제문서.docx"), _quote("word/media/image1.png"))) as response:
            self.assertEqual(response.headers["Content-Type"], "image/png")
            self.assertTrue(response.read().startswith(b"\x89PNG"))

    def test_raw_file_is_served_inline_with_range_support(self):
        with self.get("/file?path=" + _quote("예제.pdf")) as response:
            self.assertEqual(response.headers["Content-Type"], "application/pdf")
            self.assertIn("inline", response.headers["Content-Disposition"])
            full = response.read()
        with self.get("/file?path=" + _quote("예제.pdf"), {"Range": "bytes=0-9"}) as response:
            self.assertEqual(response.status, 206)
            partial = response.read()
        self.assertEqual(partial, full[:10])

    def test_file_route_accepts_a_cosmetic_name_suffix(self):
        # the name in the url makes the browser pdf viewer show the document name
        with self.get("/file/%s?path=%s" % (_quote("예제.pdf"), _quote("예제.pdf"))) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers["Content-Type"], "application/pdf")

    def test_download_uses_attachment_disposition(self):
        with self.get("/file?download=1&path=" + _quote("예제.pdf")) as response:
            self.assertIn("attachment", response.headers["Content-Disposition"])

    def test_directory_traversal_is_blocked(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.get("/file?path=../../etc/passwd")
        self.assertEqual(caught.exception.code, 403)

    def test_absolute_paths_stay_inside_the_root(self):
        # a leading slash is treated as "relative to the root", never as a system path
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.get("/api/document?path=/etc/passwd")
        self.assertEqual(caught.exception.code, 404)
        self.assertEqual(self.server.resolve("/etc/passwd"),
                         os.path.join(self.server.root, "etc/passwd"))

    def test_unknown_route(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.get("/nope")
        self.assertEqual(caught.exception.code, 404)

    def test_missing_file(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.get("/api/document?path=" + _quote("없는파일.docx"))
        self.assertEqual(caught.exception.code, 404)

    def test_foreign_host_header_is_rejected(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.get("/api/config", {"Host": "evil.example.com"})
        self.assertEqual(caught.exception.code, 403)

    def test_resolve_rejects_paths_outside_the_root(self):
        with self.assertRaises(server.ForbiddenPath):
            self.server.resolve("../..")
        self.assertEqual(self.server.resolve(""), self.server.root)


def _quote(text):
    return urllib.parse.quote(text)


if __name__ == "__main__":
    unittest.main()
