"""Comment threads (annotations + replies) and exportable summaries."""

from __future__ import annotations

import csv
import html
import io
from dataclasses import dataclass, field
from datetime import datetime

from pdfeditor.engine.base import Document, Engine, UnsupportedFeature
from pdfeditor.model.annotations import AnnotationModel, AnnotationType, ReviewState
from pdfeditor.model.geometry import Rect

TYPE_LABELS = {
    AnnotationType.TEXT: "Note",
    AnnotationType.FREE_TEXT: "Text Box",
    AnnotationType.LINE: "Line",
    AnnotationType.SQUARE: "Rectangle",
    AnnotationType.CIRCLE: "Oval",
    AnnotationType.POLYGON: "Polygon",
    AnnotationType.POLYLINE: "Polyline",
    AnnotationType.HIGHLIGHT: "Highlight",
    AnnotationType.UNDERLINE: "Underline",
    AnnotationType.SQUIGGLY: "Squiggly",
    AnnotationType.STRIKEOUT: "Strikethrough",
    AnnotationType.STAMP: "Stamp",
    AnnotationType.INK: "Drawing",
    AnnotationType.FILE_ATTACHMENT: "Attachment",
    AnnotationType.CARET: "Caret",
    AnnotationType.REDACT: "Redaction mark",
}


_EPOCH = datetime(1970, 1, 1)


def type_label(t: AnnotationType) -> str:
    return TYPE_LABELS.get(t, t.value)


@dataclass
class Thread:
    comment: AnnotationModel
    replies: list[AnnotationModel] = field(default_factory=list)

    @property
    def status(self) -> ReviewState:
        """The latest review state set on the comment or any reply."""
        states = [r.state for r in [self.comment, *self.replies] if r.state is not ReviewState.NONE]
        return states[-1] if states else ReviewState.NONE


def _root_of(a: AnnotationModel, by_id: dict[int | None, AnnotationModel]) -> AnnotationModel:
    seen: set[int | None] = set()
    while a.in_reply_to is not None and a.in_reply_to in by_id and a.id not in seen:
        seen.add(a.id)
        a = by_id[a.in_reply_to]
    return a


def comment_threads(doc: Document) -> list[Thread]:
    """All comments in page order, each with its (transitive) replies, oldest first."""
    threads: list[Thread] = []
    for index in range(doc.page_count):
        models = [a for a in doc.page(index).annotations() if a.type.is_comment]
        by_id = {a.id: a for a in models}

        page_threads: dict[int | None, Thread] = {}
        for a in models:
            if a.in_reply_to is None:
                page_threads[a.id] = Thread(a)
        for a in models:
            if a.in_reply_to is not None:
                root = _root_of(a, by_id)
                thread = page_threads.setdefault(root.id, Thread(root))
                if a is not root:
                    thread.replies.append(a)
        for thread in page_threads.values():
            thread.replies.sort(
                key=lambda r: (r.created or r.modified or _EPOCH).replace(tzinfo=None)
            )
        threads.extend(
            sorted(page_threads.values(), key=lambda t: (t.comment.rect.y0, t.comment.rect.x0))
        )
    return threads


def flattenable(doc: Document) -> tuple[int, int]:
    """Comments Flatten All would burn in, and on how many pages (as the engine counts:
    links, form fields, popups and hidden ones stay). Callers hold the engine lock."""
    skip = {AnnotationType.POPUP, AnnotationType.LINK, AnnotationType.WIDGET}
    per_page = [
        sum(1 for a in doc.page(p).annotations() if a.type not in skip and not a.flags & 2)
        for p in range(doc.page_count)
    ]
    return sum(per_page), sum(1 for n in per_page if n)


def summary_csv(threads: list[Thread], page_labels: list[str] | None = None) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["Page", "Type", "Author", "Date", "Status", "Comment", "Reply to"])
    for t in threads:
        for a, parent in [(t.comment, ""), *((r, t.comment.name) for r in t.replies)]:
            label = page_labels[a.page_index] if page_labels else str(a.page_index + 1)
            stamp = a.modified or a.created
            when = stamp.strftime("%Y-%m-%d %H:%M") if stamp else ""
            status = a.state.value if a.state is not ReviewState.NONE else ""
            writer.writerow([label, type_label(a.type), a.author, when, status, a.contents, parent])
    return buf.getvalue()


SUMMARY_CSS = (
    "body{font-family:sans-serif;font-size:10pt} h1{font-size:15pt} h2{font-size:12pt;"
    "border-bottom:1px solid #999;margin-top:14pt} .c{margin:6pt 0} .meta{color:#555}"
    " .reply{margin-left:18pt;border-left:2px solid #ccc;padding-left:6pt}"
)

# A4 in points, and the margin every side of a summary page gets.
SUMMARY_PAGE = Rect(0, 0, 595, 842)
SUMMARY_MARGIN = 54.0


def page_labels(doc: Document) -> list[str]:
    """The label each page shows in the summary: its PDF page label, or its number."""
    return [doc.page_label(i) or str(i + 1) for i in range(doc.page_count)]


def summary_body_html(threads: list[Thread], title: str, labels: list[str] | None = None) -> str:
    """The summary's body (no document wrapper or style): shared by the HTML and PDF forms."""
    parts = [
        f"<h1>Comments summary: {html.escape(title)}</h1>",
        f"<p class='meta'>{sum(1 + len(t.replies) for t in threads)} comments</p>",
    ]
    page = None
    for t in threads:
        if t.comment.page_index != page:
            page = t.comment.page_index
            label = labels[page] if labels else str(page + 1)
            parts.append(f"<h2>Page {html.escape(label)}</h2>")
        parts.append(_entry_html(t.comment, "c"))
        parts.extend(_entry_html(r, "c reply") for r in t.replies)
    return "".join(parts)


def summary_html(threads: list[Thread], title: str, page_labels: list[str] | None = None) -> str:
    """A printable summary (turned into PDF by the UI through Qt's HTML printing)."""
    return "".join(
        [
            "<html><head><meta charset='utf-8'><style>",
            SUMMARY_CSS,
            "</style></head><body>",
            summary_body_html(threads, title, page_labels),
            "</body></html>",
        ]
    )


def summary_pdf(
    engine: Engine, threads: list[Thread], title: str, labels: list[str] | None = None
) -> bytes:
    """The summary as a finished PDF, laid out by the engine (no Qt, so the web can use it).

    The caller holds the engine lock. Raises ``UnsupportedFeature`` when the engine cannot lay
    out HTML.
    """
    if not engine.capabilities.html_layout:
        raise UnsupportedFeature("this engine cannot lay out HTML")
    body = summary_body_html(threads, title, labels)
    return engine.html_to_pdf(body, SUMMARY_CSS, SUMMARY_PAGE, SUMMARY_MARGIN)


def _entry_html(a: AnnotationModel, css: str) -> str:
    when = a.modified or a.created
    meta = " · ".join(
        x
        for x in (
            type_label(a.type),
            a.author,
            when.strftime("%Y-%m-%d %H:%M") if when else "",
            a.state.value if a.state is not ReviewState.NONE else "",
        )
        if x
    )
    text = html.escape(a.contents).replace("\n", "<br>") if a.contents else "<i>(no text)</i>"
    return f"<div class='{css}'><div class='meta'>{html.escape(meta)}</div>{text}</div>"
