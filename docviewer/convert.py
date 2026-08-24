"""Convert legacy office formats (.doc/.xls/.ppt, OpenDocument, ...) on demand.

The conversion is delegated to LibreOffice when it happens to be installed.
Nothing else in docviewer depends on it - without LibreOffice the viewer simply
reports that the format cannot be displayed.
"""

import hashlib
import os
import shutil
import subprocess
import tempfile

from docviewer.filetypes import LEGACY_TARGETS, extension


CONVERTER_CANDIDATES = ("soffice", "libreoffice")
TIMEOUT = 180


class ConversionError(Exception):
    """Raised when a legacy document could not be converted."""


def converter_command():
    """Return the path of an installed LibreOffice binary or ``None``."""
    for name in CONVERTER_CANDIDATES:
        path = shutil.which(name)
        if path:
            return path
    return None


def cache_directory():
    directory = os.path.join(tempfile.gettempdir(), "docviewer-cache")
    os.makedirs(directory, exist_ok=True)
    return directory


def convert(path):
    """Convert *path* to a modern OOXML file and return the converted path.

    Results are cached, so opening the same document twice converts it once.
    """
    source_extension = extension(path)
    target_extension = LEGACY_TARGETS.get(source_extension)
    if target_extension is None:
        raise ConversionError("변환할 수 없는 형식입니다: %s" % source_extension)
    binary = converter_command()
    if binary is None:
        raise ConversionError(
            "이 형식을 보려면 LibreOffice가 필요합니다. "
            "설치 후 다시 열거나 문서를 %s 형식으로 저장해 주세요." % target_extension)
    target = os.path.join(cache_directory(), _cache_name(path) + target_extension)
    if os.path.exists(target):
        return target
    with tempfile.TemporaryDirectory(dir=cache_directory()) as workdir:
        command = [binary, "--headless", "--norestore",
                   "-env:UserInstallation=file://%s" % os.path.join(workdir, "profile"),
                   "--convert-to", target_extension.lstrip("."), "--outdir", workdir, path]
        try:
            result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    timeout=TIMEOUT, check=False)
        except subprocess.TimeoutExpired:
            raise ConversionError("변환 시간이 초과되었습니다.")
        except OSError as exc:
            raise ConversionError("변환기를 실행할 수 없습니다: %s" % exc)
        produced = os.path.join(
            workdir, os.path.splitext(os.path.basename(path))[0] + target_extension)
        if not os.path.exists(produced):
            detail = (result.stdout or b"").decode("utf-8", "replace").strip().splitlines()
            raise ConversionError("변환에 실패했습니다. %s" % (detail[-1] if detail else ""))
        shutil.move(produced, target)
    return target


def _cache_name(path):
    try:
        stat = os.stat(path)
        signature = "%s:%s:%s" % (os.path.abspath(path), stat.st_mtime_ns, stat.st_size)
    except OSError:
        signature = os.path.abspath(path)
    return hashlib.sha1(signature.encode("utf-8")).hexdigest()
