"""The engine keeps at most ``PAGE_OBJECT_LIMIT`` pages' MuPDF objects loaded.

Loaded pages (a fz page and their display lists) are evicted least recently used first, under
the engine lock. An evicted MuPage keeps its revision and reloads on its next access, so a
render after eviction must match the first render, and an edit after eviction must save and
read back in pikepdf and pypdfium2.
"""

from __future__ import annotations

from pathlib import Path

import pymupdf
import pytest

from pdfeditor.engine.base import ColorMode, RenderRequest, SaveOptions
from pdfeditor.engine.mupdf import page as mu_page
from pdfeditor.engine.mupdf.document import PAGE_OBJECT_LIMIT, open_document
from pdfeditor.model.geometry import Matrix

PAGES = PAGE_OBJECT_LIMIT + 6  # more pages than the bound, so the first ones are evicted


@pytest.fixture
def long_pdf(tmp_path: Path) -> Path:
    path = tmp_path / "long.pdf"
    doc = pymupdf.open()
    for i in range(PAGES):
        page = doc.new_page(width=200, height=300)
        page.insert_text((20, 60), f"page {i}", fontsize=24)
        page.draw_rect(pymupdf.Rect(20, 100, 100 + i, 180), color=(0, 0, 1), fill=(i / PAGES, 0, 0))
    doc.save(path)
    doc.close()
    return path


def _request() -> RenderRequest:
    return RenderRequest(matrix=Matrix(0.5, 0, 0, 0.5, 0, 0), color=ColorMode.RGB)


def test_loaded_pages_never_exceed_the_limit(long_pdf: Path) -> None:
    doc = open_document(long_pdf, None)
    try:
        for index in range(doc.page_count):
            doc.page(index).render(_request())
            assert doc.loaded_page_count <= PAGE_OBJECT_LIMIT
        assert doc.loaded_page_count == PAGE_OBJECT_LIMIT
    finally:
        doc.close()


def test_render_after_eviction_matches_the_first_render(long_pdf: Path) -> None:
    doc = open_document(long_pdf, None)
    try:
        first = doc.page(0)
        before = first.render(_request())
        revision = first.revision
        for index in range(1, doc.page_count):
            doc.page(index).render(_request())
        assert first._fz_page is None  # evicted: its MuPDF objects are gone
        assert first.revision == revision  # eviction is not a change
        after = first.render(_request())
        assert (after.width, after.height, after.stride) == (
            before.width,
            before.height,
            before.stride,
        )
        assert after.samples == before.samples
    finally:
        doc.close()


def test_getting_a_page_loads_and_evicts_nothing(
    long_pdf: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[int] = []
    original = mu_page.MuPage.invalidate

    def counting(self: mu_page.MuPage) -> None:
        calls.append(self.index)
        original(self)

    monkeypatch.setattr(mu_page.MuPage, "invalidate", counting)
    doc = open_document(long_pdf, None)
    try:
        for index in range(doc.page_count):
            doc.page(index)
        assert calls == []
        assert doc.loaded_page_count == 0
    finally:
        doc.close()


@pytest.mark.desktop_only  # needs pikepdf and pypdfium2, which the Pyodide run does not have
def test_edit_after_eviction_saves_and_reads_back(long_pdf: Path, tmp_path: Path) -> None:
    pikepdf = pytest.importorskip("pikepdf")
    pdfium = pytest.importorskip("pypdfium2")

    doc = open_document(long_pdf, None)
    try:
        for index in range(doc.page_count):
            doc.page(index).render(_request())
        target = doc.page(0)
        assert target._fz_page is None  # page 0 was evicted before the edit
        original_width = target.rect.width
        target.set_rotation(90)
        out = tmp_path / "edited.pdf"
        doc.save(out, SaveOptions())
    finally:
        doc.close()

    with pikepdf.open(out) as saved:
        assert int(saved.pages[0].obj.get("/Rotate", 0)) == 90
        assert saved.pages[1].obj.get("/Rotate", 0) == 0
    rendered = pdfium.PdfDocument(out)
    try:
        width, height = rendered[0].get_size()
        assert width == pytest.approx(300) and height == pytest.approx(original_width)
    finally:
        rendered.close()
