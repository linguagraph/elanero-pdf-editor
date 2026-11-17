"""Editing text must not leave a contentless form object behind (user report, Phase E follow-up).

MuPDF's HTML text layout draws through a Form XObject; unless it's inlined, the Edit tool lists
it as an extra, empty "form" box on top of every edited or added text.
"""

from __future__ import annotations

import pytest

from pdfeditor.engine.registry import get_engine
from pdfeditor.model.geometry import Matrix, Rect
from pdfeditor.model.objects import ObjectType, TextStyle
from tests.hostcheck import record

ENGINE = get_engine()


def forms(page) -> list:
    return [o for o in page.content_objects() if o.type is ObjectType.FORM]


def texts(page) -> dict:
    return {o.text: o for o in page.content_objects() if o.type is ObjectType.TEXT}


@pytest.fixture
def columns(fixture_pdf):
    d = ENGINE.open(fixture_pdf("two_columns"))
    yield d
    d.close()


def test_edit_leaves_no_empty_form(columns) -> None:
    page = columns.page(0)
    before = len(page.content_objects())
    page.replace_text(texts(page)["Допълнително вода"].key, "Вода")
    assert forms(page) == []
    assert len(page.content_objects()) == before  # one text replaced by one text


def test_repeated_edits_do_not_pile_up(columns, tmp_path) -> None:
    page = columns.page(0)
    before = len(page.content_objects())
    current = "Бързо"
    for n in range(5):
        new = f"Бързо {n}"
        page.replace_text(texts(page)[current].key, new)
        current = new
    assert forms(page) == [] and len(page.content_objects()) == before
    out = columns.save(tmp_path / "edited.pdf")
    record("page_count_pikepdf", out, pages=1)
    record("text_contains_pdfium", out, page=0, text=current)
    record("text_contains_pdfium", out, page=0, text="Заключване на вратата")


def test_move_and_add_text_leave_no_form(columns) -> None:
    page = columns.page(0)
    page.transform_objects([texts(page)["Предпране"].key], Matrix.translate(5, 0))
    page.add_text(Rect(40, 400, 300, 430), "Нов текст", TextStyle())
    assert forms(page) == []
    assert "Нов текст" in texts(page) and "Предпране" in texts(page)


def test_existing_form_is_kept(fixture_pdf) -> None:
    doc = ENGINE.open(fixture_pdf("mixed_content"))
    page = doc.page(0)
    (logo,) = forms(page)
    page.replace_text(texts(page)["A second paragraph that stays put."].key, "Edited paragraph.")
    (still,) = forms(page)
    assert still.bbox == logo.bbox
    doc.close()
