"""Contract tests for ``Engine.html_to_pdf``: HTML laid out into a finished PDF.

Written against the Protocol, so any backend that sets ``capabilities.html_layout`` must pass.
The saved bytes must open in pikepdf and render in pypdfium2, not only in the engine itself.
"""

from __future__ import annotations

import pytest

from pdfeditor.engine.base import Engine, EngineError
from pdfeditor.model.geometry import Rect
from tests.hostcheck import record

PAGE = Rect(0, 0, 595, 842)
CSS = "body{font-family:sans-serif;font-size:10pt} h1{font-size:15pt}"


def _long_html(paragraphs: int) -> str:
    body = "".join(
        f"<p>Paragraph {i}: the quick brown fox jumps over the lazy dog, again and again.</p>"
        for i in range(paragraphs)
    )
    return f"<h1>Long text</h1>{body}"


@pytest.fixture(autouse=True)
def _require_html_layout(engine: Engine) -> None:
    if not engine.capabilities.html_layout:
        pytest.skip(f"{engine.name} cannot lay out HTML")


def test_long_html_flows_onto_several_pages(engine: Engine) -> None:
    pdf = engine.html_to_pdf(_long_html(200), CSS, PAGE, 54)
    doc = engine.open(pdf)
    assert doc.page_count >= 2
    assert doc.page(0).rect.width == pytest.approx(PAGE.width)
    assert doc.page(0).rect.height == pytest.approx(PAGE.height)
    record("page_count_pikepdf", pdf, pages=doc.page_count)


def test_short_html_is_one_page(engine: Engine) -> None:
    pdf = engine.html_to_pdf("<p>One line.</p>", CSS, PAGE, 54)
    assert engine.open(pdf).page_count == 1


def test_text_extracts_back_with_accents_and_cyrillic(engine: Engine) -> None:
    html = "<h1>Résumé</h1><p>Привет, мир. Café au lait.</p>"
    pdf = engine.html_to_pdf(html, CSS, PAGE, 54)
    text = engine.open(pdf).page(0).text_page().text
    assert "Résumé" in text
    assert "Привет" in text and "мир" in text
    assert "Café" in text
    record("text_contains_pdfium", pdf, page=0, text="Привет")


def test_margin_too_large_for_the_page_is_refused(engine: Engine) -> None:
    with pytest.raises(EngineError):
        engine.html_to_pdf("<p>x</p>", CSS, Rect(0, 0, 100, 100), 60)
