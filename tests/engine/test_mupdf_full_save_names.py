"""Naming of unnamed annotations on a full save (issue #168), checked with pikepdf.

PyMuPDF builds the files here; the engine under test is the MuPDF backend.
"""

from __future__ import annotations

from pathlib import Path

import pymupdf

from pdfeditor.core.commands.snapshot import SNAPSHOT_OPTIONS
from pdfeditor.engine.registry import get_engine
from tests.hostcheck import record

PREFIX = "pdfeditor-"


def _strip_names(doc: pymupdf.Document) -> None:
    xrefs = [a.xref for p in doc for a in p.annots()]
    for xref in xrefs:
        doc.xref_set_key(xref, "NM", "null")


def _many_squares(path: Path, count: int) -> None:
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    for i in range(count):
        top = 20 + i * 30
        page.add_rect_annot(pymupdf.Rect(72, top, 200, top + 20)).update()
    _strip_names(doc)
    doc.save(path)
    doc.close()


def test_a_full_save_names_every_one_of_many_unnamed_annotations(tmp_path: Path) -> None:
    src = tmp_path / "many.pdf"
    _many_squares(src, 20)
    doc = get_engine("mupdf").open(src)
    names_before = [a.name for a in doc.page(0).annotations()]
    assert len(names_before) == 20 and all(n.startswith("#") for n in names_before)

    out = tmp_path / "named.pdf"
    doc.save(out)
    in_memory = [a.name for a in doc.page(0).annotations()]
    assert len(in_memory) == 20 and len(set(in_memory)) == 20
    assert all(n.startswith(PREFIX) for n in in_memory)
    doc.close()

    record("comment_names_pikepdf", out, count=20, prefix=PREFIX)


def test_to_bytes_for_a_snapshot_names_nothing(tmp_path: Path, fixture_pdf) -> None:
    doc = get_engine("mupdf").open(fixture_pdf("annotations_unnamed"))
    try:
        data = doc.to_bytes(SNAPSHOT_OPTIONS)
        names = [a.name for a in doc.page(0).annotations()]
        assert names and all(n.startswith("#") for n in names)  # still synthetic in memory
    finally:
        doc.close()
    record("no_prefixed_names_pikepdf", data, prefix=PREFIX)


def test_widgets_links_and_popups_are_not_named_by_a_full_save(tmp_path: Path) -> None:
    src = tmp_path / "mixed.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.add_text_annot((100, 100), "A note").update()
    page.insert_link(
        {"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(72, 300, 200, 320), "uri": "https://e.test"}
    )
    widget = pymupdf.Widget()
    widget.field_type = pymupdf.PDF_WIDGET_TYPE_TEXT
    widget.field_name = "field1"
    widget.field_value = "value"
    widget.rect = pymupdf.Rect(72, 400, 250, 420)
    page.add_widget(widget)
    _strip_names(doc)
    doc.save(src)
    doc.close()

    engine_doc = get_engine("mupdf").open(src)
    out = tmp_path / "named-mixed.pdf"
    engine_doc.save(out)
    engine_doc.close()

    record("widget_link_names_pikepdf", out, prefix=PREFIX)


def test_naming_one_annotation_matches_the_many_case(tmp_path: Path) -> None:
    src = tmp_path / "one.pdf"
    _many_squares(src, 1)
    doc = get_engine("mupdf").open(src)
    out = tmp_path / "one-named.pdf"
    doc.save(out)
    doc.close()
    record("first_comment_name_pikepdf", out, prefix=PREFIX)
