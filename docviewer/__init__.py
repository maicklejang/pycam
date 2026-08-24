"""docviewer: a small, dependency-free viewer for documents, spreadsheets,
presentations, PDFs and images.

The package ships a tiny HTTP server (:mod:`docviewer.server`) that serves a
single page application.  Office files (docx/xlsx/pptx) are parsed directly
from their OOXML packages, so no third party libraries are required.
"""

__version__ = "1.0.0"

__all__ = ["__version__"]
