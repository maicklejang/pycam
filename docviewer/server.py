"""A small HTTP server exposing the document viewer.

The server only reads files below a single root directory and binds to the
loopback interface by default, so it behaves like a local application rather
than a file share.
"""

import json
import mimetypes
import os
import posixpath
import re
import socket
import threading
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from docviewer import __version__, convert, documents, filetypes


STATIC_DIRECTORY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]"}
RANGE_PATTERN = re.compile(r"bytes=(\d*)-(\d*)")
MAX_ENTRIES = 5000


class ForbiddenPath(Exception):
    """Raised when a request tries to leave the served root directory."""


class ViewerServer(ThreadingHTTPServer):
    """Serves the viewer for a single root directory."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, root, host="127.0.0.1", port=8800, allow_any_host=False,
                 show_hidden=False, quiet=False):
        self.root = os.path.realpath(root)
        self.allow_any_host = allow_any_host
        self.show_hidden = show_hidden
        self.quiet = quiet
        self.initial_file = ""
        if not os.path.isdir(self.root):
            raise NotADirectoryError(self.root)
        super().__init__((host, port), ViewerRequestHandler)

    @property
    def url(self):
        host, port = self.server_address[:2]
        if ":" in str(host):
            host = "[%s]" % host
        if host in ("0.0.0.0", "[::]"):
            host = "127.0.0.1"
        return "http://%s:%d/" % (host, port)

    def resolve(self, relative):
        """Turn a client supplied relative path into an absolute one below root."""
        relative = urllib.parse.unquote(relative or "")
        relative = relative.replace("\\", "/").lstrip("/")
        candidate = os.path.realpath(os.path.join(self.root, relative))
        if candidate != self.root and not candidate.startswith(self.root + os.sep):
            raise ForbiddenPath(relative)
        return candidate

    def relative(self, absolute):
        if absolute == self.root:
            return ""
        return os.path.relpath(absolute, self.root).replace(os.sep, "/")

    def serve_in_background(self):
        thread = threading.Thread(target=self.serve_forever, name="docviewer", daemon=True)
        thread.start()
        return thread


class ViewerRequestHandler(BaseHTTPRequestHandler):

    server_version = "docviewer/" + __version__
    protocol_version = "HTTP/1.1"

    # -- routing ----------------------------------------------------------

    def do_GET(self):
        self._handle(with_body=True)

    def do_HEAD(self):
        self._handle(with_body=False)

    def _handle(self, with_body):
        if not self._check_host():
            return
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path.rstrip("/") or "/"
        query = urllib.parse.parse_qs(parsed.query)
        try:
            if route == "/":
                self._send_static("index.html", with_body)
            elif route in ("/phone", "/standalone"):
                self._send_static("standalone.html", with_body)
            elif route == "/manifest.webmanifest":
                self._send_static("manifest.webmanifest", with_body)
            elif route.startswith("/static/"):
                self._send_static(posixpath.basename(route), with_body)
            elif route == "/api/config":
                self._send_json(self._config())
            elif route == "/api/browse":
                self._send_json(self._browse(_first(query, "path")))
            elif route == "/api/document":
                self._send_json(self._document(_first(query, "path")))
            elif route == "/api/media":
                self._send_media(_first(query, "path"), _first(query, "part"), with_body)
            elif route == "/file" or route.startswith("/file/"):
                # the trailing name is cosmetic: it makes the browser pdf viewer
                # show the document name instead of "file"
                self._send_file(_first(query, "path"), _first(query, "download") == "1",
                                with_body)
            else:
                self._send_error_json(HTTPStatus.NOT_FOUND, "존재하지 않는 주소입니다.")
        except ForbiddenPath:
            self._send_error_json(HTTPStatus.FORBIDDEN, "허용되지 않은 경로입니다.")
        except FileNotFoundError:
            self._send_error_json(HTTPStatus.NOT_FOUND, "파일을 찾을 수 없습니다.")
        except PermissionError:
            self._send_error_json(HTTPStatus.FORBIDDEN, "파일을 읽을 권한이 없습니다.")
        except BrokenPipeError:
            pass
        except OSError as exc:
            self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, str(exc))

    def _check_host(self):
        """Reject requests from other origins when bound to loopback."""
        if self.server.allow_any_host:
            return True
        bound_host = str(self.server.server_address[0])
        if bound_host not in ("127.0.0.1", "::1", "localhost"):
            return True
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
        if host in {name.strip("[]") for name in LOOPBACK_HOSTS} or host == "":
            return True
        self._send_error_json(HTTPStatus.FORBIDDEN,
                              "로컬 주소(localhost)로만 접속할 수 있습니다.")
        return False

    # -- endpoints --------------------------------------------------------

    def _config(self):
        return {"version": __version__,
                "root": self.server.root,
                "initial": self.server.initial_file,
                "converter": convert.converter_command() is not None,
                "kinds": filetypes.KIND_LABELS}

    def _browse(self, relative):
        directory = self.server.resolve(relative)
        if not os.path.isdir(directory):
            directory = os.path.dirname(directory)
        directories = []
        files = []
        with os.scandir(directory) as entries:
            for entry in entries:
                if len(directories) + len(files) >= MAX_ENTRIES:
                    break
                if entry.name.startswith(".") and not self.server.show_hidden:
                    continue
                try:
                    if entry.is_dir():
                        directories.append({"name": entry.name,
                                            "path": self.server.relative(entry.path)})
                    elif filetypes.is_supported(entry.name):
                        files.append(documents.describe(entry.path,
                                                        self.server.relative(entry.path)))
                except OSError:
                    continue
        directories.sort(key=lambda item: item["name"].lower())
        files.sort(key=lambda item: item["name"].lower())
        relative_directory = self.server.relative(directory)
        return {"path": relative_directory,
                "parent": None if directory == self.server.root
                else self.server.relative(os.path.dirname(directory)),
                "breadcrumbs": _breadcrumbs(relative_directory),
                "directories": directories,
                "files": files}

    def _document(self, relative):
        path = self.server.resolve(relative)
        if not os.path.isfile(path):
            raise FileNotFoundError(path)
        quoted = urllib.parse.quote(self.server.relative(path))

        def media_url(part):
            return "/api/media?path=%s&part=%s" % (quoted, urllib.parse.quote(part))

        return documents.render(path, self.server.relative(path), media_url)

    def _send_media(self, relative, part, with_body):
        path = self.server.resolve(relative)
        if not part:
            raise FileNotFoundError(part)
        try:
            data, mime = documents.read_media(path, part)
        except Exception as exc:  # noqa: BLE001 - report any parsing problem as 404
            self._send_error_json(HTTPStatus.NOT_FOUND, str(exc))
            return
        self._send_bytes(data, mime, with_body, cache="private, max-age=600")

    def _send_file(self, relative, as_download, with_body):
        path = self.server.resolve(relative)
        if not os.path.isfile(path):
            raise FileNotFoundError(path)
        size = os.path.getsize(path)
        mime = filetypes.mime_type(path) or mimetypes.guess_type(path)[0] \
            or "application/octet-stream"
        start, end = _parse_range(self.headers.get("Range"), size)
        with open(path, "rb") as source:
            if start is None:
                self.send_response(HTTPStatus.OK)
                length = size
            else:
                self.send_response(HTTPStatus.PARTIAL_CONTENT)
                self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
                source.seek(start)
                length = end - start + 1
            disposition = "attachment" if as_download else "inline"
            filename = os.path.basename(path)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Disposition", "%s; filename*=UTF-8''%s"
                             % (disposition, urllib.parse.quote(filename)))
            self.send_header("Cache-Control", "private, max-age=60")
            self.end_headers()
            if with_body:
                _copy(source, self.wfile, length)

    def _send_static(self, name, with_body=True):
        name = posixpath.basename(name)
        path = os.path.join(STATIC_DIRECTORY, name)
        if not os.path.isfile(path):
            self._send_error_json(HTTPStatus.NOT_FOUND, "정적 파일이 없습니다: %s" % name)
            return
        with open(path, "rb") as source:
            data = source.read()
        mime = filetypes.mime_type(name) or "text/plain; charset=utf-8"
        if name.endswith(".html"):
            mime = "text/html; charset=utf-8"
        self._send_bytes(data, mime, with_body, cache="no-cache")

    # -- helpers ----------------------------------------------------------

    def _send_json(self, payload, status=HTTPStatus.OK):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send_bytes(data, "application/json; charset=utf-8", True, status=status,
                         cache="no-store")

    def _send_error_json(self, status, message):
        self._send_json({"error": message}, status=status)

    def _send_bytes(self, data, mime, with_body=True, status=HTTPStatus.OK, cache="no-store"):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if with_body:
            self.wfile.write(data)

    def log_message(self, format, *args):  # noqa: A002 - signature defined by the base class
        if getattr(self.server, "quiet", False):
            return
        super().log_message(format, *args)


def _copy(source, target, length, chunk_size=64 * 1024):
    while length > 0:
        chunk = source.read(min(chunk_size, length))
        if not chunk:
            break
        target.write(chunk)
        length -= len(chunk)


def _parse_range(header, size):
    if not header or size == 0:
        return None, None
    match = RANGE_PATTERN.fullmatch(header.strip())
    if not match:
        return None, None
    start, end = match.group(1), match.group(2)
    if start == "":
        if end == "":
            return None, None
        length = min(int(end), size)
        return size - length, size - 1
    start = int(start)
    end = int(end) if end else size - 1
    if start >= size:
        return None, None
    return start, min(end, size - 1)


def _breadcrumbs(relative):
    crumbs = [{"name": "홈", "path": ""}]
    parts = [part for part in relative.split("/") if part and part != "."]
    for index, part in enumerate(parts):
        crumbs.append({"name": part, "path": "/".join(parts[:index + 1])})
    return crumbs


def _first(query, name, default=""):
    values = query.get(name)
    return values[0] if values else default


def find_free_port(host, preferred):
    """Return *preferred* when it is free, otherwise a port picked by the OS."""
    for candidate in (preferred, 0):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind((host, candidate))
            except OSError:
                continue
            return probe.getsockname()[1]
    return preferred


def create_server(target, host="127.0.0.1", port=8800, **kwargs):
    """Create a :class:`ViewerServer` for a file or directory *target*."""
    target = os.path.realpath(os.path.expanduser(target))
    initial = ""
    if os.path.isfile(target):
        root = os.path.dirname(target)
        initial = os.path.basename(target)
    else:
        root = target
    server = ViewerServer(root, host=host, port=port, **kwargs)
    server.initial_file = initial
    return server


__all__ = ["ViewerServer", "create_server", "find_free_port", "ForbiddenPath"]
