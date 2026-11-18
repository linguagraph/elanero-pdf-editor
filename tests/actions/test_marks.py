"""Page-mark actions on real documents: results, labels, undo, refusals and the round-trip rule.

No Qt. Saved files must open in pikepdf and render in pypdfium2 (independent implementations),
not only in MuPDF.
"""

from __future__ import annotations

import base64
import copy
import io
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from typing import cast

import pytest
from PIL import Image

from pdfeditor.actions import REGISTRY, marks, run
from pdfeditor.actions.base import NotSupported
from pdfeditor.actions.marks import AddBackground, AddHeaderFooter, AddWatermark, RemoveMarks
from pdfeditor.core.session import DocumentSession
from pdfeditor.engine.registry import get_engine
from pdfeditor.model.color import Color
from pdfeditor.model.fonts import FontRef, FontRefKind
from pdfeditor.model.pages import MarkKind
from pdfeditor.services import stamping
from pdfeditor.services.stamping import (
    HeaderFooter,
    Slot,
    Watermark,
    background_from_settings,
    header_footer_from_settings,
    watermark_from_settings,
)
from tests.actions.conftest import Opener
from tests.hostcheck import record

# One minimal value per action; the Busy test in test_registry.py runs each one.
BUSY_CASES: dict[str, object] = {
    "marks.header_footer": AddHeaderFooter(HeaderFooter(texts={Slot.FOOTER_RIGHT: "x"}), (0,)),
    "marks.watermark": AddWatermark(Watermark(text="x"), (0,)),
    "marks.background": AddBackground(Color(1, 1, 1), 0.5, (0,)),
    "marks.remove": RemoveMarks(MarkKind.HEADER_FOOTER),
}


def texts(session: DocumentSession) -> list[str]:
    with session.lock:
        doc = session.document
        return [doc.page(i).text_page(with_chars=False).text for i in range(doc.page_count)]


def marks_of(session: DocumentSession, kind: MarkKind) -> stamping.MarkInfo | None:
    with session.lock:
        return stamping.find_marks(session.engine, session.document, [kind]).get(kind)


def mark_counts(session: DocumentSession, kind: MarkKind) -> list[int]:
    """How many marks of ``kind`` each page carries."""
    with session.lock:
        doc = session.document
        return [
            sum(1 for m in doc.page(i).page_marks() if m.kind is kind)
            for i in range(doc.page_count)
        ]


def png_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (40, 20), (200, 30, 30)).save(buf, "PNG")
    return buf.getvalue()


def header_spec() -> HeaderFooter:
    return HeaderFooter(
        texts={Slot.HEADER_LEFT: "<<file>>", Slot.FOOTER_RIGHT: "Page <<page>> of <<pages>>"},
        font="tiro",
        font_size=8.0,
        color=Color(0.2, 0.3, 0.4),
        margin_x=40.0,
        margin_top=30.0,
        margin_bottom=28.0,
        date_format="%d.%m.%Y",
    )


def bates_spec() -> HeaderFooter:
    return HeaderFooter(
        texts={Slot.FOOTER_RIGHT: "<<bates>>"},
        bates_prefix="BX-",
        bates_start=7,
        bates_digits=4,
        bates_suffix="/A",
    )


def assert_reads_everywhere(path: Path, pages: int) -> None:
    """The saved file opens in pikepdf and renders page 1 in pypdfium2."""
    record("page_count_pikepdf", path, pages=pages)
    record("page_count_pdfium", path, pages=pages)
    record("render_first_page_pdfium", path)


def close(session: DocumentSession) -> None:
    with session.lock:
        session.document.close()


# -- specs travel unchanged ----------------------------------------------------------------


def test_header_footer_spec_survives_the_stored_settings(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    spec = header_spec()
    before = copy.deepcopy(spec)
    result = marks.header_footer(s, AddHeaderFooter(spec, (0, 1), file_name="report.pdf"))
    assert spec == before  # the action doesn't change the spec it was given
    info = marks_of(s, MarkKind.HEADER_FOOTER)
    assert info is not None and info.pages == [0, 1]
    assert header_footer_from_settings(info.settings) == spec
    assert result.value == 4  # two texts on two pages


def test_watermark_spec_survives_the_stored_settings(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    spec = Watermark(
        image=png_bytes(),
        image_path="logo.png",
        font_size=44.0,
        color=Color(0.1, 0.5, 0.2),
        opacity=0.25,
        angle=10.0,
        scale=0.4,
        on_top=False,
        font_ref=FontRef(FontRefKind.STANDARD, "Times-Bold"),
    )
    before = copy.deepcopy(spec)
    marks.watermark(s, AddWatermark(spec, (0,)))
    assert spec == before
    info = marks_of(s, MarkKind.WATERMARK)
    assert info is not None
    # The settings keep the image's path, not its bytes: "Update Watermark" reads the file again.
    rebuilt = watermark_from_settings(info.settings)
    assert rebuilt == replace(spec, image=None)
    assert rebuilt is not None and rebuilt.image_path == "logo.png"


# -- each action: result, document after, undo -----------------------------------------------


def test_header_footer_draws_the_expanded_text_and_undo_removes_it(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    before = texts(s)
    result = marks.header_footer(s, AddHeaderFooter(header_spec(), (0, 2), file_name="report.pdf"))
    assert result.label == "Add Header & Footer"
    assert result.executed and result.value == 4
    assert s.undo_stack.undo_label == "Add Header & Footer"
    after = texts(s)
    assert "report.pdf" in after[0] and "Page 1 of " in after[0]
    assert "Page 3 of " in after[2] and "Page 2 of " not in after[1]
    assert s.undo()
    assert texts(s) == before and marks_of(s, MarkKind.HEADER_FOOTER) is None


def test_bates_numbers_are_their_own_kind_and_expand(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    result = marks.header_footer(s, AddHeaderFooter(bates_spec(), (0, 1), bates=True))
    assert result.label == "Add Bates Numbers" and result.value == 2
    after = texts(s)
    assert "BX-0007/A" in after[0] and "BX-0008/A" in after[1]
    assert marks_of(s, MarkKind.BATES) is not None
    assert marks_of(s, MarkKind.HEADER_FOOTER) is None
    assert s.undo()
    assert marks_of(s, MarkKind.BATES) is None


def test_bates_and_header_footer_do_not_replace_each_other(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    marks.header_footer(s, AddHeaderFooter(header_spec(), (0,), file_name="a.pdf"))
    marks.header_footer(s, AddHeaderFooter(bates_spec(), (0,), bates=True))
    assert marks_of(s, MarkKind.HEADER_FOOTER) is not None
    assert marks_of(s, MarkKind.BATES) is not None


def test_header_footer_update_leaves_one_set_of_marks(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    marks.header_footer(s, AddHeaderFooter(header_spec(), (0, 1), file_name="a.pdf"))
    result = marks.header_footer(
        s, AddHeaderFooter(header_spec(), (0, 1), file_name="a.pdf", replace_existing=True)
    )
    assert result.label == "Update Header & Footer" and result.executed
    counts = mark_counts(s, MarkKind.HEADER_FOOTER)
    assert counts[:2] == [1, 1] and sum(counts) == 2
    assert texts(s)[0].count("Page 1 of ") == 1
    assert s.undo()
    assert texts(s)[0].count("Page 1 of ") == 1  # the earlier set, and only that one


def test_header_footer_without_text_is_not_executed(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    before = texts(s)
    result = marks.header_footer(s, AddHeaderFooter(HeaderFooter(texts={}), (0,)))
    assert result.executed is False and result.value == 0
    assert not s.undo_stack.can_undo and texts(s) == before
    empty = HeaderFooter(texts={Slot.HEADER_LEFT: ""})
    assert marks.header_footer(s, AddHeaderFooter(empty, (0,))).executed is False


def test_header_footer_without_pages_is_not_executed(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    result = marks.header_footer(s, AddHeaderFooter(header_spec(), ()))
    assert result.executed is False and not s.undo_stack.can_undo


def test_watermark_adds_and_undo_removes_it(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    before = texts(s)
    result = marks.watermark(s, AddWatermark(Watermark(text="DRAFT"), (0, 1)))
    assert result.label == "Add Watermark" and result.value is None and result.executed
    assert "DRAFT" in texts(s)[0]
    assert marks_of(s, MarkKind.WATERMARK) is not None
    assert s.undo()
    assert marks_of(s, MarkKind.WATERMARK) is None and texts(s) == before


def test_watermark_update_replaces_the_previous_one(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    marks.watermark(s, AddWatermark(Watermark(text="OLD"), (0,)))
    result = marks.watermark(s, AddWatermark(Watermark(text="NEW"), (0,), replace_existing=True))
    assert result.label == "Update Watermark"
    assert mark_counts(s, MarkKind.WATERMARK)[0] == 1
    assert "NEW" in texts(s)[0] and "OLD" not in texts(s)[0]


def test_watermark_without_pages_is_not_executed(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    result = marks.watermark(s, AddWatermark(Watermark(text="DRAFT"), ()))
    assert result.executed is False and not s.undo_stack.can_undo


def test_background_adds_and_undo_removes_it(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    color = Color(1.0, 0.95, 0.7)
    result = marks.background(s, AddBackground(color, 0.5, (0,)))
    assert result.label == "Add Background" and result.executed
    info = marks_of(s, MarkKind.BACKGROUND)
    assert info is not None and info.pages == [0]
    assert background_from_settings(info.settings) == (color, 0.5)
    assert s.undo()
    assert marks_of(s, MarkKind.BACKGROUND) is None


def test_background_update_replaces_and_labels(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    marks.background(s, AddBackground(Color(1, 1, 1), 1.0, (0,)))
    result = marks.background(
        s, AddBackground(Color(0.9, 0.9, 1), 0.3, (0,), replace_existing=True)
    )
    assert result.label == "Update Background"
    assert mark_counts(s, MarkKind.BACKGROUND)[0] == 1


def test_background_without_pages_is_not_executed(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    result = marks.background(s, AddBackground(Color(1, 1, 1), 1.0, ()))
    assert result.executed is False and not s.undo_stack.can_undo


def test_remove_takes_the_marks_of_one_kind_and_undo_restores_them(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    marks.header_footer(s, AddHeaderFooter(header_spec(), (0, 1), file_name="a.pdf"))
    marks.watermark(s, AddWatermark(Watermark(text="DRAFT"), (0,)))
    before = texts(s)
    result = marks.remove(s, RemoveMarks(MarkKind.HEADER_FOOTER))
    assert result.label == "Remove Header & Footer" and result.executed
    assert result.value == 4  # two texts on each of two pages: four marked sections
    assert marks_of(s, MarkKind.HEADER_FOOTER) is None
    assert marks_of(s, MarkKind.WATERMARK) is not None  # other kinds stay
    assert "Page 1 of " not in texts(s)[0]
    assert s.undo()
    assert marks_of(s, MarkKind.HEADER_FOOTER) is not None
    assert texts(s) == before


def test_remove_with_nothing_to_remove_is_not_executed(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    result = marks.remove(s, RemoveMarks(MarkKind.BATES))
    assert result.label == "Remove Bates Numbers"
    assert result.executed is False and result.value == 0
    assert not s.undo_stack.can_undo


# -- capabilities and registration -----------------------------------------------------------


def test_remove_needs_the_page_marks_capability(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    off = replace(get_engine().capabilities, page_marks=False)
    fake = cast(DocumentSession, SimpleNamespace(engine=SimpleNamespace(capabilities=off)))
    with pytest.raises(NotSupported, match="page_marks"):
        run(fake, "marks.remove", RemoveMarks(MarkKind.HEADER_FOOTER))
    assert not s.undo_stack.can_undo


def test_marks_actions_are_registered_as_long_running() -> None:
    for name in BUSY_CASES:
        assert REGISTRY[name].long, name
    assert REGISTRY["marks.remove"].requires == ("page_marks",)
    for name in ("marks.header_footer", "marks.watermark", "marks.background"):
        assert REGISTRY[name].requires == ("page_ops",), name


# -- round trips: edit, save, reopen, assert, then the independent readers -------------------


def test_round_trip_header_footer(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("text_multipage")
    marks.header_footer(s, AddHeaderFooter(header_spec(), (0, 1), file_name="report.pdf"))
    out = s.save(tmp_path / "header.pdf")
    reopened = DocumentSession.open(out)
    try:
        assert "report.pdf" in texts(reopened)[0]
        info = marks_of(reopened, MarkKind.HEADER_FOOTER)
        assert info is not None and header_footer_from_settings(info.settings) == header_spec()
    finally:
        close(reopened)
    assert_reads_everywhere(out, s.page_count)


def test_round_trip_bates(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("text_multipage")
    marks.header_footer(s, AddHeaderFooter(bates_spec(), (0,), bates=True))
    out = s.save(tmp_path / "bates.pdf")
    reopened = DocumentSession.open(out)
    try:
        assert "BX-0007/A" in texts(reopened)[0]
    finally:
        close(reopened)
    assert_reads_everywhere(out, s.page_count)


def test_round_trip_watermark(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("text_multipage")
    marks.watermark(s, AddWatermark(Watermark(text="CONFIDENTIAL"), (0,)))
    out = s.save(tmp_path / "watermark.pdf")
    reopened = DocumentSession.open(out)
    try:
        assert "CONFIDENTIAL" in texts(reopened)[0]
        assert marks_of(reopened, MarkKind.WATERMARK) is not None
    finally:
        close(reopened)
    assert_reads_everywhere(out, s.page_count)


def test_round_trip_image_watermark(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("text_multipage")
    marks.watermark(s, AddWatermark(Watermark(image=png_bytes(), image_path="logo.png"), (0,)))
    out = s.save(tmp_path / "image_watermark.pdf")
    reopened = DocumentSession.open(out)
    try:
        assert marks_of(reopened, MarkKind.WATERMARK) is not None
    finally:
        close(reopened)
    assert_reads_everywhere(out, s.page_count)


def test_image_watermark_is_drawn_on_the_page(
    open_copy: Opener, fixture_pdf, tmp_path: Path
) -> None:
    """The picture itself is drawn: page 1 lists one more image, and its render changes in the
    watermark's area. Without ``spec.image`` the action draws empty text and fails both checks."""
    s = open_copy("text_multipage")

    def images_on_page_one() -> int:
        with s.lock:
            return sum(1 for image in s.document.images() if 0 in image.pages)

    before = images_on_page_one()
    spec = Watermark(image=png_bytes(), image_path="logo.png", scale=0.5, opacity=1.0)
    marks.watermark(s, AddWatermark(spec, (0,)))
    assert images_on_page_one() == before + 1
    out = s.save(tmp_path / "drawn.pdf")
    original = fixture_pdf("text_multipage")
    reference = base64.b64encode(original.read_bytes()).decode("ascii")
    record("watermark_drawn_pdfium", out, reference=reference)


def test_round_trip_background(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("text_multipage")
    marks.background(s, AddBackground(Color(0.8, 0.9, 1.0), 0.6, (0,)))
    out = s.save(tmp_path / "background.pdf")
    reopened = DocumentSession.open(out)
    try:
        assert marks_of(reopened, MarkKind.BACKGROUND) is not None
    finally:
        close(reopened)
    assert_reads_everywhere(out, s.page_count)


def test_round_trip_remove(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("text_multipage")
    marks.header_footer(s, AddHeaderFooter(header_spec(), (0,), file_name="gone.pdf"))
    marks.remove(s, RemoveMarks(MarkKind.HEADER_FOOTER))
    out = s.save(tmp_path / "removed.pdf")
    reopened = DocumentSession.open(out)
    try:
        assert "gone.pdf" not in texts(reopened)[0]
        assert marks_of(reopened, MarkKind.HEADER_FOOTER) is None
    finally:
        close(reopened)
    assert_reads_everywhere(out, s.page_count)
