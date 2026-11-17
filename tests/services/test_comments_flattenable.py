"""``flattenable``: what Flatten All would burn in, counted as the engine sees the document."""

from __future__ import annotations

import shutil
from pathlib import Path

import pikepdf
import pytest

from pdfeditor.core.session import DocumentSession
from pdfeditor.services.comments import flattenable


@pytest.fixture
def mixed_pdf(fixture_pdf, tmp_path: Path) -> Path:
    """The ``annotations`` fixture (six comments) plus a link and a popup on page 1, a hidden
    comment, and a second page that holds only a link."""
    path = tmp_path / "mixed.pdf"
    shutil.copy2(fixture_pdf("annotations"), path)
    with pikepdf.open(path, allow_overwriting_input=True) as pdf:
        page = pdf.pages[0]
        note = next(a for a in page.obj.Annots if a.get("/Subtype") == "/Text")
        link = pdf.make_indirect(
            pikepdf.Dictionary(
                Type=pikepdf.Name.Annot,
                Subtype=pikepdf.Name.Link,
                Rect=[10, 10, 100, 30],
                Border=[0, 0, 0],
            )
        )
        popup = pdf.make_indirect(
            pikepdf.Dictionary(
                Type=pikepdf.Name.Annot,
                Subtype=pikepdf.Name.Popup,
                Rect=[400, 400, 520, 470],
                Parent=note,
                Open=False,
            )
        )
        page.obj.Annots.append(link)
        page.obj.Annots.append(popup)
        # a hidden comment: flatten skips it, so it isn't counted
        square = next(a for a in page.obj.Annots if a.get("/Subtype") == "/Square")
        square.F = 2
        second = pdf.add_blank_page()
        second_link = pdf.make_indirect(
            pikepdf.Dictionary(
                Type=pikepdf.Name.Annot,
                Subtype=pikepdf.Name.Link,
                Rect=[10, 10, 100, 30],
                Border=[0, 0, 0],
            )
        )
        second.obj.Annots = pikepdf.Array([second_link])
        pdf.save(path)
    return path


def test_flattenable_counts_comments_and_pages_and_skips_hidden_ones(mixed_pdf: Path) -> None:
    session = DocumentSession.open(mixed_pdf)
    try:
        with session.lock:
            comments, pages = flattenable(session.document)
        # six comments, minus the hidden square; the link-only second page isn't counted. MuPDF's
        # annotations() doesn't list links or popups, so the rule for them is only in the code.
        assert (comments, pages) == (5, 1)
    finally:
        session.close()


def test_flattenable_of_a_document_without_comments_is_zero(fixture_pdf, tmp_path: Path) -> None:
    path = tmp_path / "plain.pdf"
    shutil.copy2(fixture_pdf("text_multipage"), path)
    session = DocumentSession.open(path)
    try:
        with session.lock:
            assert flattenable(session.document) == (0, 0)
    finally:
        session.close()
