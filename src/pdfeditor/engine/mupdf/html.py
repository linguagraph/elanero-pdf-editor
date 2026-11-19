"""HTML-to-PDF layout through MuPDF's Story (the engine behind ``Page.insert_htmlbox``).

Used for documents that are made from HTML rather than edited, such as the comment summary.
The output is a new PDF; no document object leaves this module.
"""

from __future__ import annotations

from io import BytesIO

import pymupdf

from pdfeditor.engine.base import EngineError
from pdfeditor.engine.mupdf.convert import to_fz_rect
from pdfeditor.model.geometry import Rect

# A guard against a layout that never runs out of content. Story stops when the text is placed;
# a summary of a few thousand comments is far below this.
_MAX_PAGES = 2000


def html_to_pdf(html: str, css: str, page: Rect, margin: float) -> bytes:
    story = pymupdf.Story(html=html, user_css=css)
    media = to_fz_rect(page)
    where = pymupdf.Rect(media.x0 + margin, media.y0 + margin, media.x1 - margin, media.y1 - margin)
    if where.is_empty:
        raise EngineError("the page is too small for the margin")
    out = BytesIO()
    writer = pymupdf.DocumentWriter(out)
    try:
        pages = 0
        more = True
        while more:
            pages += 1
            if pages > _MAX_PAGES:
                raise EngineError("the HTML is too long to lay out")
            device = writer.begin_page(media)
            more, _filled = story.place(where)
            story.draw(device)
            writer.end_page()
    finally:
        writer.close()
    return out.getvalue()
