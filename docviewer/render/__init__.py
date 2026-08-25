"""Renderers turning office files into data the frontend can display."""

from docviewer.render.docx import render_docx
from docviewer.render.pptx import render_pptx
from docviewer.render.xlsx import render_xlsx, render_csv

__all__ = ["render_docx", "render_pptx", "render_xlsx", "render_csv"]
