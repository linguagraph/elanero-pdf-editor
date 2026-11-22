"""The ``annotations.create`` action (W7.1a): the web's comment tools, run through the layer.

No Qt. Each comment created here is saved, reopened, and checked in pikepdf and pypdfium2 (the
round-trip rule), and every tool gets an undo step with the desktop's label.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from pdfeditor import actions as layer
from pdfeditor.actions.base import Refused
from pdfeditor.actions.comment_tools import (
    NOTE_SIZE,
    CommentTool,
    CreateAnnotation,
    HighlightText,
    build_markup,
    build_note,
    build_shape,
)
from pdfeditor.core.session import DocumentSession
from pdfeditor.model.annotations import AnnotationModel, AnnotationType
from pdfeditor.model.geometry import PageRects, Point, Rect
from pdfeditor.webapi.dto import BufferTable, from_json
from tests.actions.conftest import Opener
from tests.hostcheck import record

# The Busy test in test_registry.py runs each action with these args.
BUSY_CASES: dict[str, object] = {
    "annotations.create": CreateAnnotation(CommentTool.NOTE, 0, Rect(10, 10, 10, 10)),
    "annotations.highlight_text": HighlightText((PageRects(0, (Rect(10, 10, 20, 20),)),)),
}


def reopen(path: Path) -> DocumentSession:
    return DocumentSession.open(path)


def create(session: DocumentSession, tool: CommentTool, rect: Rect, text: str = "") -> object:
    return layer.run(session, "annotations.create", CreateAnnotation(tool, 0, rect, text))


def on_page(session: DocumentSession, page: int = 0) -> list[AnnotationModel]:
    with session.lock:
        return list(session.document.page(page).annotations())


def test_builders_use_the_desktop_styles() -> None:
    note = build_note(0, Point(30, 40), "Check this", "Ann")
    assert note.type is AnnotationType.TEXT and note.icon == "Comment"
    assert note.rect == Rect(30, 40, 30 + NOTE_SIZE, 40 + NOTE_SIZE)
    assert note.contents == "Check this" and note.author == "Ann"

    box = Rect(100, 100, 200, 150)
    square = build_shape(AnnotationType.SQUARE, 0, box)
    assert square.type is AnnotationType.SQUARE and square.border_width == 1.5
    assert square.rect == box

    markup = build_markup(AnnotationType.HIGHLIGHT, 0, box, "Key")
    assert markup.type is AnnotationType.HIGHLIGHT and len(markup.quads) == 1
    assert markup.quads[0].ul == Point(100, 100) and markup.contents == "Key"


def test_each_tool_adds_one_comment_with_its_label(open_copy: Opener) -> None:
    s = open_copy("annotations")
    before = len(on_page(s))
    labels = {
        CommentTool.NOTE: ("Add Sticky Note", Rect(300, 300, 300, 300), AnnotationType.TEXT),
        CommentTool.RECTANGLE: ("Add Rectangle", Rect(100, 500, 180, 560), AnnotationType.SQUARE),
        CommentTool.HIGHLIGHT: (
            "Add Highlight",
            Rect(100, 600, 260, 620),
            AnnotationType.HIGHLIGHT,
        ),
    }
    for tool, (label, rect, kind) in labels.items():
        result = create(s, tool, rect, "Text")
        assert result.executed and result.label == label  # type: ignore[attr-defined]
        assert s.undo_stack.undo_label == label
        name = result.value[0].name  # type: ignore[attr-defined]
        assert any(a.name == name and a.type is kind for a in on_page(s))
    assert len(on_page(s)) == before + 3


def test_a_click_off_the_page_adds_nothing(open_copy: Opener) -> None:
    s = open_copy("annotations")
    far = Rect(5000, 5000, 5100, 5100)
    for tool in (CommentTool.RECTANGLE, CommentTool.HIGHLIGHT):
        result = create(s, tool, far)
        assert not result.executed  # type: ignore[attr-defined]
    assert not s.undo_stack.can_undo


def test_a_click_without_a_drag_adds_no_box(open_copy: Opener) -> None:
    s = open_copy("annotations")
    result = create(s, CommentTool.RECTANGLE, Rect(100, 100, 100, 100))
    assert not result.executed  # type: ignore[attr-defined]


def test_a_box_partly_off_the_page_is_clipped(open_copy: Opener) -> None:
    s = open_copy("annotations")
    with s.lock:
        page = s.document.page(0).rect
    result = create(s, CommentTool.RECTANGLE, Rect(page.x1 - 10, 100, page.x1 + 50, 140))
    name = result.value[0].name  # type: ignore[attr-defined]
    made = next(a for a in on_page(s) if a.name == name)
    assert made.rect.x1 <= page.x1 + 1e-6


def test_a_missing_page_is_refused(open_copy: Opener) -> None:
    s = open_copy("annotations")
    with pytest.raises(Refused):
        layer.run(s, "annotations.create", CreateAnnotation(CommentTool.NOTE, 99, Rect(1, 1, 1, 1)))


def test_undo_removes_the_new_comment(open_copy: Opener) -> None:
    s = open_copy("annotations")
    before = [a.name for a in on_page(s)]
    create(s, CommentTool.NOTE, Rect(300, 300, 300, 300), "Hello")
    assert len(on_page(s)) == len(before) + 1
    assert s.undo()
    assert [a.name for a in on_page(s)] == before


def test_round_trip_of_web_comments(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("annotations")
    create(s, CommentTool.NOTE, Rect(300, 300, 300, 300), "Sticky")
    create(s, CommentTool.RECTANGLE, Rect(100, 500, 180, 560))
    create(s, CommentTool.HIGHLIGHT, Rect(100, 600, 260, 620), "Marked")
    expected = len(on_page(s))

    out = s.save(tmp_path / "web-comments.pdf")
    reopened = reopen(out)
    try:
        with reopened.lock:
            models = list(reopened.document.page(0).annotations())
        kinds = {m.type for m in models}
        assert {AnnotationType.TEXT, AnnotationType.SQUARE, AnnotationType.HIGHLIGHT} <= kinds
        assert len(models) == expected
        texts = {m.contents for m in models}
        assert {"Sticky", "Marked"} <= texts
    finally:
        with reopened.lock:
            reopened.document.close()
    record("comment_count_pikepdf", out, count=expected)
    record("page_count_pikepdf", out, pages=s.page_count)
    record("page_count_pdfium", out, pages=s.page_count)
    record("render_first_page_pdfium", out)


def test_the_web_wire_args_convert_to_the_action_args() -> None:
    """The JSON the web sends (W1.2 section 6) becomes the action's own args."""
    wire = {
        "tool": "highlight",
        "page": 0,
        "rect": {"x0": 10.0, "y0": 20.0, "x1": 90.0, "y1": 40.0},
        "text": "Key",
    }
    args = from_json(CreateAnnotation, wire, BufferTable([]), "args")
    assert args == CreateAnnotation(CommentTool.HIGHLIGHT, 0, Rect(10, 20, 90, 40), "Key", "")


def highlight(s: DocumentSession, pages: tuple[PageRects, ...], note: str = "") -> object:
    return layer.run(s, "annotations.highlight_text", HighlightText(pages, note, "Ann"))


def test_highlight_text_makes_one_highlight_per_page_with_the_note_on_the_first(
    open_copy: Opener,
) -> None:
    s = open_copy("text_multipage")
    assert s.page_count >= 2
    with s.lock:
        first = s.document.page(0).rect
    line_a, line_b = Rect(100, 600, 260, 620), Rect(100, 630, 300, 650)
    off_page = Rect(first.x1 + 10, 700, first.x1 + 40, 720)
    pages = (
        PageRects(0, (line_a, line_b, off_page)),
        PageRects(1, (Rect(100, 100, 200, 120),)),
    )
    before = (len(on_page(s, 0)), len(on_page(s, 1)))
    result = highlight(s, pages, "Translated")
    assert result.executed and result.label == "Add Note to Text"  # type: ignore[attr-defined]
    assert s.undo_stack.undo_label == "Add Note to Text"
    assert (len(on_page(s, 0)), len(on_page(s, 1))) == (before[0] + 1, before[1] + 1)

    made = {ref.page: ref.name for ref in result.value}  # type: ignore[attr-defined]
    first_mark = next(a for a in on_page(s, 0) if a.name == made[0])
    assert first_mark.type is AnnotationType.HIGHLIGHT
    assert len(first_mark.quads) == 2  # the off-page line is clipped away
    assert first_mark.contents == "Translated" and first_mark.author == "Ann"
    second_mark = next(a for a in on_page(s, 1) if a.name == made[1])
    assert len(second_mark.quads) == 1 and second_mark.contents == ""

    assert s.undo()
    assert (len(on_page(s, 0)), len(on_page(s, 1))) == before


def test_highlight_text_with_no_line_on_a_page_adds_nothing(open_copy: Opener) -> None:
    s = open_copy("annotations")
    far = Rect(5000, 5000, 5100, 5100)
    result = highlight(s, (PageRects(0, (far,)),), "Nope")
    assert not result.executed  # type: ignore[attr-defined]
    assert not s.undo_stack.can_undo


def test_highlight_text_refuses_too_many_rectangles_and_missing_pages(open_copy: Opener) -> None:
    s = open_copy("annotations")
    too_many = tuple(Rect(10, 10, 20, 20) for _ in range(2001))
    with pytest.raises(Refused):
        highlight(s, (PageRects(0, too_many),))
    with pytest.raises(Refused):
        highlight(s, (PageRects(99, (Rect(1, 1, 5, 5),)),))


def test_round_trip_of_highlight_text(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("text_multipage")
    pages = (
        PageRects(0, (Rect(100, 600, 260, 620), Rect(100, 630, 300, 650))),
        PageRects(1, (Rect(100, 100, 200, 120),)),
    )
    highlight(s, pages, "Translated")
    out = s.save(tmp_path / "highlight-text.pdf")
    reopened = reopen(out)
    try:
        with reopened.lock:
            kinds = [m.type for m in reopened.document.page(0).annotations()]
        assert AnnotationType.HIGHLIGHT in kinds
    finally:
        with reopened.lock:
            reopened.document.close()
    record("comment_count_pikepdf", out, count=len(on_page(s, 0)), page=0)
    record("comment_count_pikepdf", out, count=len(on_page(s, 1)), page=1)
    record("render_first_page_pdfium", out)
