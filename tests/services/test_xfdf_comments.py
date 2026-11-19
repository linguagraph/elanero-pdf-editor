from __future__ import annotations

import shutil
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import cast

import pytest

from pdfeditor.core.commands import AddAnnotationCommand
from pdfeditor.core.session import DocumentSession
from pdfeditor.engine.base import Capabilities, Engine, UnsupportedFeature
from pdfeditor.engine.registry import get_engine
from pdfeditor.model.annotations import (
    AnnotationModel,
    AnnotationType,
    ReviewState,
    callout_line,
)
from pdfeditor.model.color import Color
from pdfeditor.model.geometry import Point, Quad, Rect
from pdfeditor.services.comments import (
    comment_threads,
    page_labels,
    summary_csv,
    summary_html,
    summary_pdf,
)
from pdfeditor.services.xfdf import (
    MAX_XFDF_BYTES,
    XfdfTooLarge,
    check_size,
    export_xfdf,
    import_command,
    parse_xfdf,
    preview_xfdf,
)
from tests.hostcheck import record


@pytest.fixture
def session(fixture_pdf, tmp_path: Path):
    path = tmp_path / "doc.pdf"
    shutil.copy2(fixture_pdf("rotated_pages"), path)
    s = DocumentSession.open(path)
    yield s
    s.close()


def _populate(session: DocumentSession) -> None:
    for page in (0, 1):
        session.execute(
            AddAnnotationCommand(
                AnnotationModel(
                    AnnotationType.SQUARE,
                    page,
                    Rect(100, 150, 220, 230),
                    color=Color(1, 0, 0),
                    author="Ann",
                    contents=f"box on {page}",
                )
            )
        )
        session.execute(
            AddAnnotationCommand(
                AnnotationModel(
                    AnnotationType.HIGHLIGHT,
                    page,
                    Rect(0, 0, 0, 0),
                    color=Color(1, 1, 0),
                    quads=(Quad.from_rect(Rect(80, 300, 300, 315)),),
                    author="Bob",
                )
            )
        )
        session.execute(
            AddAnnotationCommand(
                AnnotationModel(
                    AnnotationType.INK,
                    page,
                    Rect(0, 0, 0, 0),
                    color=Color(0, 0, 1),
                    ink=((Point(300, 400), Point(340, 450), Point(380, 410)),),
                )
            )
        )
        session.execute(
            AddAnnotationCommand(
                AnnotationModel(
                    AnnotationType.LINE,
                    page,
                    Rect(0, 0, 0, 0),
                    color=Color(0, 0, 1),
                    vertices=(Point(100, 500), Point(250, 520)),
                    line_endings=("None", "OpenArrow"),
                )
            )
        )
    parent = session.document.page(0).annotations()[0]
    reply = AnnotationModel(
        AnnotationType.TEXT,
        0,
        parent.rect,
        contents="Agreed",
        author="Cy",
        state=ReviewState.ACCEPTED,
    )
    reply.extra = {"irt_name": parent.name}
    session.execute(AddAnnotationCommand(reply))


def test_xfdf_roundtrip_including_rotated_page(
    session: DocumentSession, fixture_pdf, tmp_path: Path
) -> None:
    _populate(session)
    xml = export_xfdf(session.document, "doc.pdf")
    assert 'xmlns="http://ns.adobe.com/xfdf/"' in xml and "<square" in xml and "inreplyto=" in xml

    # import into a fresh copy of the original document
    fresh_path = tmp_path / "fresh.pdf"
    shutil.copy2(fixture_pdf("rotated_pages"), fresh_path)
    fresh = DocumentSession.open(fresh_path)
    fresh.execute(import_command(xml, fresh.document))
    assert len(fresh.undo_stack) == 1  # one undo step for the whole import
    for page in (0, 1):
        src = {
            a.type: a for a in session.document.page(page).annotations() if a.in_reply_to is None
        }
        dst = {a.type: a for a in fresh.document.page(page).annotations() if a.in_reply_to is None}
        assert dst[AnnotationType.SQUARE].rect.intersects(src[AnnotationType.SQUARE].rect)
        assert (
            dst[AnnotationType.SQUARE].author == "Ann"
            and dst[AnnotationType.SQUARE].contents == f"box on {page}"
        )
        assert dst[AnnotationType.HIGHLIGHT].quads[0].rect.x0 == pytest.approx(80, abs=1)
        assert dst[AnnotationType.INK].ink[0][1].x == pytest.approx(340, abs=1)
        line = dst[AnnotationType.LINE]
        assert (
            line.vertices[1].y == pytest.approx(520, abs=1) and line.line_endings[1] == "OpenArrow"
        )
    replies = [a for a in fresh.document.page(0).annotations() if a.in_reply_to is not None]
    assert replies and replies[0].contents == "Agreed" and replies[0].state is ReviewState.ACCEPTED
    parent = next(a for a in fresh.document.page(0).annotations() if a.id == replies[0].in_reply_to)
    assert parent.type is AnnotationType.SQUARE
    fresh.undo()
    assert fresh.document.page(0).annotations() == []
    fresh.close()


def test_import_twice_avoids_duplicate_names(session: DocumentSession) -> None:
    _populate(session)
    xml = export_xfdf(session.document)
    session.execute(import_command(xml, session.document))
    names = [a.name for p in (0, 1) for a in session.document.page(p).annotations()]
    assert len(names) == len(set(names))


def test_parse_ignores_unknown_and_out_of_range(session: DocumentSession) -> None:
    xml = (
        '<xfdf xmlns="http://ns.adobe.com/xfdf/"><annots>'
        '<sound page="0" rect="0,0,1,1"/>'
        '<square page="99" rect="0,0,10,10"/>'
        '<square page="0" rect="10,10,50,50" color="#00FF00"><contents>ok</contents></square>'
        "</annots></xfdf>"
    )
    (model,) = parse_xfdf(xml, session.document)
    assert model.contents == "ok" and model.color == Color(0, 1, 0)


def test_threads_and_summaries(session: DocumentSession) -> None:
    _populate(session)
    threads = comment_threads(session.document)
    assert len(threads) == 8
    boxed = next(t for t in threads if t.comment.contents == "box on 0")
    assert [r.contents for r in boxed.replies] == [
        "Agreed"
    ] and boxed.status is ReviewState.ACCEPTED
    csv_text = summary_csv(threads)
    assert csv_text.splitlines()[0].startswith("Page,Type,Author")
    assert "Agreed" in csv_text and "Rectangle" in csv_text
    html_text = summary_html(threads, "doc.pdf")
    assert "Comments summary: doc.pdf" in html_text and "Page 2" in html_text


def test_xfdf_callout_roundtrip(session: DocumentSession, fixture_pdf, tmp_path: Path) -> None:
    box = Rect(250, 200, 420, 250)
    session.execute(
        AddAnnotationCommand(
            AnnotationModel(
                AnnotationType.FREE_TEXT,
                1,
                box,
                contents="See this",
                color=Color(1, 0, 0),
                text_color=Color(1, 0, 0),
                vertices=callout_line(Point(90, 120), box),
                line_endings=("OpenArrow", "None"),
            )
        )
    )
    xml = export_xfdf(session.document)
    assert "callout=" in xml
    fresh_path = tmp_path / "fresh.pdf"
    shutil.copy2(fixture_pdf("rotated_pages"), fresh_path)
    fresh = DocumentSession.open(fresh_path)
    fresh.execute(import_command(xml, fresh.document))
    (callout,) = fresh.document.page(1).annotations()
    assert callout.is_callout and callout.line_endings[0] == "OpenArrow"
    assert callout.vertices[0].x == pytest.approx(90, abs=1.5)
    assert callout.vertices[0].y == pytest.approx(120, abs=1.5)
    assert callout.rect.x0 == pytest.approx(250, abs=1.5)
    fresh.close()


def test_summary_pdf_opens_renders_and_keeps_labels(session: DocumentSession) -> None:
    _populate(session)
    with session.lock:
        engine = get_engine("mupdf")
        threads = comment_threads(session.document)
        labels = page_labels(session.document)
        pdf = summary_pdf(engine, threads, session.display_name, labels)
        pages = engine.open(pdf).page_count
    assert pdf.startswith(b"%PDF") and pages >= 1
    first = threads[0].comment
    record("page_count_pikepdf", pdf, pages=pages)
    record("text_contains_pdfium", pdf, page=0, text=first.contents)
    record("text_contains_pdfium", pdf, page=0, text=f"Page {labels[first.page_index]}")


@dataclass
class _NoHtmlEngine:
    """Only what summary_pdf reads before it refuses: a capability set without html_layout."""

    capabilities: Capabilities = field(default_factory=Capabilities)


def test_summary_pdf_refuses_without_html_layout(session: DocumentSession) -> None:
    _populate(session)
    with session.lock:
        threads = comment_threads(session.document)
        labels = page_labels(session.document)
        engine = cast(Engine, _NoHtmlEngine())
        assert not engine.capabilities.html_layout
        with pytest.raises(UnsupportedFeature, match="cannot lay out HTML"):
            summary_pdf(engine, threads, session.display_name, labels)


def test_page_labels_fall_back_to_numbers(session: DocumentSession) -> None:
    with session.lock:
        labels = page_labels(session.document)
    assert len(labels) == session.document.page_count
    assert all(label for label in labels)


def test_xfdf_with_doctype_or_entity_is_refused(session: DocumentSession) -> None:
    body = '<annots><text page="0" rect="0,0,10,10" contents="x"/></annots>'
    hostile = [
        f'<?xml version="1.0"?><!DOCTYPE xfdf [<!ENTITY a "b">]>'
        f'<xfdf xmlns="http://ns.adobe.com/xfdf/">{body}</xfdf>',
        f'<?xml version="1.0"?><!ENTITY a "b"><xfdf xmlns="http://ns.adobe.com/xfdf/">{body}</xfdf>',
    ]
    for text in hostile:
        with session.lock, pytest.raises(ValueError, match="not XFDF"):
            parse_xfdf(text, session.document)


def test_non_xfdf_root_is_refused(session: DocumentSession) -> None:
    with session.lock, pytest.raises(ValueError, match="not XFDF"):
        parse_xfdf("<html><body/></html>", session.document)


def test_text_over_the_limit_is_refused_before_any_parsing(
    session: DocumentSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    def parsed(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("an over-size XFDF reached the XML parser")

    monkeypatch.setattr(ET, "fromstring", parsed)
    with session.lock, pytest.raises(XfdfTooLarge):
        parse_xfdf("x" * (MAX_XFDF_BYTES + 1), session.document)
    assert issubclass(XfdfTooLarge, ValueError)


def test_size_is_measured_in_utf8_bytes_not_characters() -> None:
    # 'é' is one character but two UTF-8 bytes: under the limit by len(), over it when encoded.
    text = "é" * (MAX_XFDF_BYTES // 2 + 1)
    assert len(text) <= MAX_XFDF_BYTES < len(text.encode("utf-8"))
    with pytest.raises(XfdfTooLarge):
        check_size(text)


def test_exactly_at_the_limit_passes_the_size_check() -> None:
    check_size("x" * MAX_XFDF_BYTES)
    check_size("é" * (MAX_XFDF_BYTES // 2))  # exactly MAX_XFDF_BYTES bytes


PREVIEW_XFDF = """<?xml version="1.0" encoding="UTF-8"?>
<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">
<annots>
<text name="note-1" page="0" rect="72,600,92,620"><contents>first</contents></text>
<square name="box-1" page="1" rect="100,100,200,200"><contents>second</contents></square>
<text name="reply-1" page="1" rect="72,600,92,620" inreplyto="note-1">
<contents>reply</contents>
</text>
<text name="off-page" page="99" rect="0,0,10,10"><contents>not counted</contents></text>
<bogus name="unknown" page="0" rect="0,0,10,10"/>
</annots>
</xfdf>
"""


def test_preview_counts_what_the_import_adds(session: DocumentSession) -> None:
    with session.lock:
        preview = preview_xfdf(PREVIEW_XFDF, session.document)
        imported = import_command(PREVIEW_XFDF, session.document)
    # Off-page comments and unknown tags are skipped by both, so the counts agree.
    assert preview.comments == 3
    assert preview.replies == 1
    assert preview.pages == (0, 1)
    assert preview.comments == len(imported.commands)


def test_preview_refuses_what_import_refuses(session: DocumentSession) -> None:
    body = '<annots><text page="0" rect="0,0,10,10" contents="x"/></annots>'
    with session.lock:
        with pytest.raises(XfdfTooLarge):
            preview_xfdf("x" * (MAX_XFDF_BYTES + 1), session.document)
        with pytest.raises(ValueError, match="not XFDF"):
            preview_xfdf(f'<?xml version="1.0"?><!DOCTYPE xfdf []>{body}', session.document)
    assert not session.undo_stack.can_undo
