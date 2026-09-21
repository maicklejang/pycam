"""docscan - turn photos of documents into clean, deskewed scans.

The package can be used as a command line tool (``python -m docscan``) or as a
library::

    from docscan import ScanOptions, scan_image, write_pdf
    result = scan_image(photo, ScanOptions(mode="bw"))
    write_pdf("out.pdf", [result.image])

Copyright 2026 PyCAM contributors

This file is part of the docscan document scanner.  It is free software:
you can redistribute it and/or modify it under the terms of the GNU General
Public License as published by the Free Software Foundation, either version 3
of the License, or (at your option) any later version.
"""

VERSION = "1.0.0"

__all__ = ["VERSION", "ScanOptions", "ScanResult", "scan_image", "find_document",
           "four_point_transform", "enhance", "MODES", "write_pdf", "pdf_bytes",
           "CameraScanner", "CameraOptions", "imread", "imwrite"]


def __getattr__(name):
    # imported lazily so that "python -m docscan --version" works even when
    # OpenCV is missing, and to keep the import cost of the package low
    if name in ("ScanOptions", "ScanResult", "scan_image"):
        from docscan import scanner
        return getattr(scanner, name)
    if name == "find_document":
        from docscan.detect import find_document
        return find_document
    if name == "four_point_transform":
        from docscan.transform import four_point_transform
        return four_point_transform
    if name in ("enhance", "MODES"):
        from docscan import enhance as enhance_module
        return getattr(enhance_module, name)
    if name in ("write_pdf", "pdf_bytes"):
        from docscan import pdf
        return getattr(pdf, name)
    if name in ("CameraScanner", "CameraOptions"):
        from docscan import camera
        return getattr(camera, name)
    if name in ("imread", "imwrite"):
        from docscan import io_utils
        return getattr(io_utils, name)
    raise AttributeError("module {!r} has no attribute {!r}".format(__name__, name))
