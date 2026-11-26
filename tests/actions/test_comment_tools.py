"""The ``annotations.create`` action (W7.1a): the web's comment tools, run through the layer.

No Qt. Each comment created here is saved, reopened, and checked in pikepdf and pypdfium2 (the
round-trip rule), and every tool gets an undo step with the desktop's label.
"""

from __future__ import annotations

import dataclasses
import io
from collections.abc import Iterator
from pathlib import Path

import pytest
from PIL import Image

from pdfeditor import actions as layer
from pdfeditor.actions.base import Refused
from pdfeditor.actions.comment_tools import (
    MAX_MARK_AREAS,
    MAX_MARK_QUADS,
    NOTE_SIZE,
    CommentTool,
    CreateAnnotation,
    HighlightText,
    MarkText,
    MarkupKind,
    build_attachment,
    build_markup,
    build_note,
    build_shape,
    standard_stamp_box,
)
from pdfeditor.core.session import DocumentSession
from pdfeditor.model import platform as model_platform
from pdfeditor.model.annotations import IMAGE_STAMP, AnnotationModel, AnnotationType
from pdfeditor.model.geometry import MarkupArea, PageRects, Point, Quad, Rect
from pdfeditor.webapi.dto import BufferTable, from_json, to_json
from pdfeditor.webapi.limits import MAX_IMAGE_BYTES
from pdfeditor.webapi.platform import WEB_PLATFORM
from tests.actions.conftest import Opener
from tests.hostcheck import record

# The Busy test in test_registry.py runs each action with these args.
BUSY_CASES: dict[str, object] = {
    "annotations.create": CreateAnnotation(CommentTool.NOTE, 0, Rect(10, 10, 10, 10)),
    "annotations.highlight_text": HighlightText((PageRects(0, (Rect(10, 10, 20, 20),)),)),
    "annotations.mark_text": MarkText(MarkupKind.HIGHLIGHT, ()),
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


def test_create_returns_the_name_of_the_comment_it_added(open_copy: Opener) -> None:
    """The web selects the new comment by this name (W7.1a Question 3): the reply's value is one
    AnnotRef, which the RPC sends as {page, name}, and the name is the comment's own."""
    s = open_copy("annotations")
    result = create(s, CommentTool.NOTE, Rect(300, 300, 300, 300), "Hi")
    wire = to_json(result.value, [])  # type: ignore[attr-defined]
    assert wire == [{"page": 0, "name": result.value[0].name}]  # type: ignore[attr-defined]
    assert wire[0]["name"]
    assert made_on_page(s, result).contents == "Hi"


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


def test_the_web_line_and_arrow_args_convert_with_their_ends() -> None:
    """A line or arrow from the web sends its two ends as ``points``; ``rect`` is their box."""
    wire = {
        "tool": "arrow",
        "page": 0,
        "rect": {"x0": 72.0, "y0": 72.0, "x1": 144.0, "y1": 100.0},
        "text": "",
        "points": [{"x": 72.0, "y": 72.0}, {"x": 144.0, "y": 100.0}],
        "author": "",
    }
    args = from_json(CreateAnnotation, wire, BufferTable([]), "args")
    assert args.tool is CommentTool.ARROW
    assert args.points == (Point(72, 72), Point(144, 100))


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


def page_size(s: DocumentSession) -> Rect:
    with s.lock:
        return s.document.page(0).rect


def make(s: DocumentSession, args: CreateAnnotation) -> object:
    return layer.run(s, "annotations.create", args)


def made_on_page(s: DocumentSession, result: object) -> AnnotationModel:
    name = result.value[0].name  # type: ignore[attr-defined]
    return next(a for a in on_page(s) if a.name == name)


# One gesture per new tool, with the label and the kind the desktop gives the comment.
NEW_TOOLS: dict[str, tuple[CreateAnnotation, str, AnnotationType]] = {
    "textbox": (
        CreateAnnotation(CommentTool.TEXTBOX, 0, Rect(300, 300, 420, 340), "Typed"),
        "Add Text Box",
        AnnotationType.FREE_TEXT,
    ),
    "callout": (
        CreateAnnotation(
            CommentTool.CALLOUT, 0, Rect(200, 380, 360, 420), "Pointed", points=(Point(60, 400),)
        ),
        "Add Callout",
        AnnotationType.FREE_TEXT,
    ),
    "pen": (
        CreateAnnotation(
            CommentTool.PEN,
            0,
            Rect(0, 0, 0, 0),
            points=(Point(100, 100), Point(120, 140), Point(160, 130), Point(200, 180)),
        ),
        "Add Drawing",
        AnnotationType.INK,
    ),
    "line": (
        CreateAnnotation(
            CommentTool.LINE, 0, Rect(0, 0, 0, 0), points=(Point(100, 700), Point(250, 700))
        ),
        "Add Line",
        AnnotationType.LINE,
    ),
    "arrow": (
        CreateAnnotation(
            CommentTool.ARROW, 0, Rect(0, 0, 0, 0), points=(Point(100, 680), Point(250, 680))
        ),
        "Add Arrow",
        AnnotationType.LINE,
    ),
    "oval": (
        CreateAnnotation(CommentTool.OVAL, 0, Rect(100, 500, 180, 560)),
        "Add Oval",
        AnnotationType.CIRCLE,
    ),
    "polygon": (
        CreateAnnotation(
            CommentTool.POLYGON,
            0,
            Rect(0, 0, 0, 0),
            points=(Point(100, 700), Point(200, 700), Point(150, 780)),
        ),
        "Add Polygon",
        AnnotationType.POLYGON,
    ),
    "polyline": (
        CreateAnnotation(
            CommentTool.POLYLINE,
            0,
            Rect(0, 0, 0, 0),
            points=(Point(100, 700), Point(200, 720), Point(260, 760)),
        ),
        "Add Polyline",
        AnnotationType.POLYLINE,
    ),
}


@pytest.mark.parametrize("tool", list(NEW_TOOLS))
def test_each_new_tool_adds_one_comment_of_its_kind_with_its_label(
    open_copy: Opener, tool: str
) -> None:
    s = open_copy("annotations")
    args, label, kind = NEW_TOOLS[tool]
    before = len(on_page(s))
    result = make(s, args)
    assert result.executed and result.label == label  # type: ignore[attr-defined]
    assert s.undo_stack.undo_label == label
    assert made_on_page(s, result).type is kind
    assert len(on_page(s)) == before + 1


def test_a_text_box_click_gets_the_default_size(open_copy: Opener) -> None:
    s = open_copy("annotations")
    result = make(s, CreateAnnotation(CommentTool.TEXTBOX, 0, Rect(300, 300, 300, 300), "Click"))
    assert made_on_page(s, result).rect == Rect(300, 300, 480, 340)


def test_a_callout_click_gets_a_default_box_beside_its_tip(open_copy: Opener) -> None:
    s = open_copy("annotations")
    tip = Point(60, 400)
    args = CreateAnnotation(CommentTool.CALLOUT, 0, Rect(300, 400, 300, 400), "Hi", points=(tip,))
    made = made_on_page(s, make(s, args))
    assert made.rect.width == pytest.approx(180) and made.rect.height == pytest.approx(40)
    assert made.rect.x0 == pytest.approx(300)  # the box sits to the right of the tip
    assert made.vertices[0] == tip and len(made.vertices) >= 2


@pytest.mark.parametrize(
    "args",
    [
        CreateAnnotation(CommentTool.TEXTBOX, 0, Rect(300, 300, 420, 340), "   "),
        CreateAnnotation(CommentTool.TEXTBOX, 0, Rect(300, 300, 420, 340), ""),
        CreateAnnotation(
            CommentTool.CALLOUT, 0, Rect(200, 380, 360, 420), "", points=(Point(60, 400),)
        ),
        CreateAnnotation(CommentTool.TEXTBOX, 0, Rect(5000, 5000, 5100, 5100), "Far"),
        CreateAnnotation(
            CommentTool.LINE, 0, Rect(0, 0, 0, 0), points=(Point(100, 100), Point(101, 101))
        ),
        CreateAnnotation(CommentTool.PEN, 0, Rect(0, 0, 0, 0), points=(Point(100, 100),)),
        CreateAnnotation(CommentTool.OVAL, 0, Rect(100, 100, 100, 100)),
    ],
)
def test_gestures_that_add_nothing_report_not_executed(
    open_copy: Opener, args: CreateAnnotation
) -> None:
    s = open_copy("annotations")
    before = len(on_page(s))
    result = make(s, args)
    assert not result.executed  # type: ignore[attr-defined]
    assert len(on_page(s)) == before
    assert not s.undo_stack.can_undo


def test_points_outside_the_page_are_clamped_onto_it(open_copy: Opener) -> None:
    s = open_copy("annotations")
    page = page_size(s)
    stroke = (Point(-50, 100), Point(page.x1 + 80, 200), Point(300, page.y1 + 500), Point(300, 300))
    result = make(s, CreateAnnotation(CommentTool.PEN, 0, Rect(0, 0, 0, 0), points=stroke))
    made = made_on_page(s, result)
    points = [p for line in made.ink for p in line]
    assert len(points) >= 2
    assert all(page.x0 <= p.x <= page.x1 and page.y0 <= p.y <= page.y1 for p in points)


def test_polygon_drops_a_repeated_vertex_and_needs_three(open_copy: Opener) -> None:
    s = open_copy("annotations")
    repeated = (Point(100, 700), Point(100.4, 700.2), Point(200, 700), Point(150, 780))
    made = made_on_page(
        s, make(s, CreateAnnotation(CommentTool.POLYGON, 0, Rect(0, 0, 0, 0), points=repeated))
    )
    assert len(made.vertices) == 3
    two = (Point(100, 700), Point(100.4, 700.2), Point(100.6, 700.1))
    with pytest.raises(Refused):
        make(s, CreateAnnotation(CommentTool.POLYGON, 0, Rect(0, 0, 0, 0), points=two))


LONG_PEN = tuple(Point(float(i % 500), float(i % 700)) for i in range(10_001))


@pytest.mark.parametrize(
    "args",
    [
        CreateAnnotation(CommentTool.LINE, 0, Rect(0, 0, 0, 0), points=(Point(1, 1),)),
        CreateAnnotation(
            CommentTool.ARROW,
            0,
            Rect(0, 0, 0, 0),
            points=(Point(1, 1), Point(9, 9), Point(20, 20)),
        ),
        CreateAnnotation(CommentTool.CALLOUT, 0, Rect(1, 1, 50, 50), "x", points=()),
        CreateAnnotation(
            CommentTool.CALLOUT, 0, Rect(1, 1, 50, 50), "x", points=(Point(1, 1), Point(9, 9))
        ),
        CreateAnnotation(CommentTool.POLYLINE, 0, Rect(0, 0, 0, 0), points=(Point(1, 1),)),
        CreateAnnotation(CommentTool.PEN, 0, Rect(0, 0, 0, 0), points=LONG_PEN),
        CreateAnnotation(CommentTool.TEXTBOX, 0, Rect(1, 1, 50, 50), "x" * (64 * 1024 + 1)),
    ],
    ids=[
        "line-1-point",
        "arrow-3-points",
        "callout-0-points",
        "callout-2-points",
        "polyline-1-point",
        "pen-10001-points",
        "text-over-64-KiB",
    ],
)
def test_input_limits_are_refused(open_copy: Opener, args: CreateAnnotation) -> None:
    s = open_copy("annotations")
    before = len(on_page(s))
    with pytest.raises(Refused):
        make(s, args)
    assert len(on_page(s)) == before


@pytest.mark.parametrize("tool", list(NEW_TOOLS))
def test_round_trip_of_each_new_comment(open_copy: Opener, tmp_path: Path, tool: str) -> None:
    """Each new comment saves, reopens and renders in pikepdf and pypdfium2 (the round-trip
    rule), with the subtype and the keys that carry its shape. The page has no comments of its
    own, so the first annotation of each subtype the checks read is the new one."""
    s = open_copy("text_multipage")
    args, _, kind = NEW_TOOLS[tool]
    before = len(on_page(s))
    make(s, args)
    out = s.save(tmp_path / f"{tool}.pdf")

    reopened = reopen(out)
    try:
        with reopened.lock:
            kinds = [m.type for m in reopened.document.page(0).annotations()]
        assert kind in kinds
    finally:
        with reopened.lock:
            reopened.document.close()

    subtype = {
        AnnotationType.FREE_TEXT: "/FreeText",
        AnnotationType.INK: "/Ink",
        AnnotationType.LINE: "/Line",
        AnnotationType.CIRCLE: "/Circle",
        AnnotationType.POLYGON: "/Polygon",
        AnnotationType.POLYLINE: "/PolyLine",
    }[kind]
    record("comment_count_pikepdf", out, count=before + 1)
    record("annot_keys_pikepdf", out, subtype=subtype)
    if tool == "callout":
        record("callout_annot_pikepdf", out, page=0)
    if tool == "pen":
        record("annot_keys_pikepdf", out, subtype=subtype, present=["/InkList"])
    if tool in ("line", "arrow"):
        record("annot_keys_pikepdf", out, subtype=subtype, present=["/L"])
    if tool == "arrow":
        record("annot_keys_pikepdf", out, subtype=subtype, present=["/LE"])
    if tool in ("polygon", "polyline"):
        record("annot_keys_pikepdf", out, subtype=subtype, present=["/Vertices"])
    record("render_first_page_pdfium", out)


@pytest.mark.parametrize("text", ["", "   "])
def test_an_empty_sticky_note_is_created(open_copy: Opener, text: str) -> None:
    """A sticky note may be blank (the desktop's NoteTool allows it); only the box tools refuse
    a blank text."""
    s = open_copy("annotations")
    before = len(on_page(s))
    result = make(s, CreateAnnotation(CommentTool.NOTE, 0, Rect(300, 300, 300, 300), text))
    assert result.executed  # type: ignore[attr-defined]
    assert result.label == "Add Sticky Note"  # type: ignore[attr-defined]
    made = made_on_page(s, result)
    assert made.type is AnnotationType.TEXT and made.contents == text
    assert len(on_page(s)) == before + 1
    assert s.undo_stack.undo_label == "Add Sticky Note"


@pytest.mark.parametrize(
    "args",
    [
        CreateAnnotation(CommentTool.NOTE, 0, Rect(300, 300, 300, 300), "a\ud800b"),
        CreateAnnotation(CommentTool.TEXTBOX, 0, Rect(300, 300, 420, 340), "a\udc00"),
    ],
    ids=["note", "text-box"],
)
def test_text_with_a_lone_surrogate_is_refused_and_changes_nothing(
    open_copy: Opener, args: CreateAnnotation
) -> None:
    """JSON can carry a lone surrogate, which UTF-8 can't store: the action refuses it before
    the byte-count check, with no comment added and no undo step."""
    s = open_copy("annotations")
    before = len(on_page(s))
    with pytest.raises(Refused):
        make(s, args)
    assert len(on_page(s)) == before
    assert not s.undo_stack.can_undo


def test_a_drag_of_exactly_three_points_draws(open_copy: Opener) -> None:
    """The design: drags under 3 pt add nothing, so a drag of exactly 3.0 pt draws."""
    s = open_copy("annotations")
    line = make(
        s,
        CreateAnnotation(
            CommentTool.LINE, 0, Rect(0, 0, 0, 0), points=(Point(100, 100), Point(103, 100))
        ),
    )
    assert line.executed  # type: ignore[attr-defined]
    assert made_on_page(s, line).type is AnnotationType.LINE

    box = make(s, CreateAnnotation(CommentTool.TEXTBOX, 0, Rect(300, 300, 303, 303), "Tiny"))
    assert box.executed  # type: ignore[attr-defined]
    assert made_on_page(s, box).rect == Rect(300, 300, 303, 303)


def test_a_drag_under_three_points_is_a_click(open_copy: Opener) -> None:
    """Just under 3 pt is a click: a line adds nothing, a text box gets the default size."""
    s = open_copy("annotations")
    line = make(
        s,
        CreateAnnotation(
            CommentTool.LINE, 0, Rect(0, 0, 0, 0), points=(Point(100, 100), Point(102.9, 100))
        ),
    )
    assert not line.executed  # type: ignore[attr-defined]
    box = make(s, CreateAnnotation(CommentTool.TEXTBOX, 0, Rect(300, 300, 302.9, 302.9), "Tiny"))
    assert made_on_page(s, box).rect == Rect(300, 300, 480, 340)


# -- text markup (W7.1a slice 2): annotations.mark_text ------------------------------------------


def line(page: int, top: float, text: str = "") -> MarkupArea:
    """A one-line area on ``page`` whose line sits at ``top``."""
    return MarkupArea(page, (Quad.from_rect(Rect(100, top, 220, top + 12)),), text)


def mark(s: DocumentSession, kind: MarkupKind, *areas: MarkupArea) -> object:
    return layer.run(s, "annotations.mark_text", MarkText(kind, areas, "Ann"))


@pytest.mark.parametrize(
    ("kind", "subtype", "label"),
    [
        (MarkupKind.HIGHLIGHT, AnnotationType.HIGHLIGHT, "Highlight"),
        (MarkupKind.UNDERLINE, AnnotationType.UNDERLINE, "Underline"),
        (MarkupKind.STRIKEOUT, AnnotationType.STRIKEOUT, "Strikethrough"),
        (MarkupKind.SQUIGGLY, AnnotationType.SQUIGGLY, "Squiggly Underline"),
    ],
)
def test_mark_text_makes_the_desktop_markup_with_its_label(
    open_copy: Opener, kind: MarkupKind, subtype: AnnotationType, label: str
) -> None:
    s = open_copy("text_multipage")
    before = len(on_page(s))
    result = mark(s, kind, line(0, 100, "Key"))
    assert result.executed and result.label == label  # type: ignore[attr-defined]
    assert len(on_page(s)) == before + 1
    added = on_page(s)[-1]
    assert added.type is subtype and added.contents == "Key" and added.author == "Ann"
    assert len(added.quads) == 1


def test_mark_text_one_comment_per_page_and_one_undo_step(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    assert s.page_count >= 2
    before = [len(on_page(s, i)) for i in (0, 1)]
    result = mark(s, MarkupKind.UNDERLINE, line(0, 100, "Selected"), line(1, 300), line(1, 320))
    assert result.executed  # type: ignore[attr-defined]
    assert len(result.value) == 3  # type: ignore[attr-defined]
    assert len(on_page(s, 0)) == before[0] + 1 and len(on_page(s, 1)) == before[1] + 2
    assert all(a.quads for a in on_page(s, 1)[-2:])
    assert s.undo()
    assert [len(on_page(s, i)) for i in (0, 1)] == before


def test_mark_text_skips_an_area_with_no_quads(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    before = len(on_page(s, 0))
    result = mark(s, MarkupKind.STRIKEOUT, MarkupArea(0, ()))
    assert not result.executed  # type: ignore[attr-defined]
    assert len(on_page(s, 0)) == before


def test_mark_text_refuses_a_missing_page_and_too_many_lines(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    with pytest.raises(Refused):
        mark(s, MarkupKind.HIGHLIGHT, line(s.page_count, 100))
    many = tuple(Quad.from_rect(Rect(100, 100, 200, 110)) for _ in range(MAX_MARK_QUADS + 1))
    with pytest.raises(Refused):
        mark(s, MarkupKind.HIGHLIGHT, MarkupArea(0, many))
    areas = tuple(line(0, 100) for _ in range(MAX_MARK_AREAS + 1))
    with pytest.raises(Refused):
        layer.run(s, "annotations.mark_text", MarkText(MarkupKind.HIGHLIGHT, areas))


def test_mark_text_round_trip(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("text_multipage")
    mark(s, MarkupKind.HIGHLIGHT, line(0, 100, "Marked"))
    mark(s, MarkupKind.SQUIGGLY, line(0, 140), line(1, 200))
    expected = len(on_page(s, 0))

    out = s.save(tmp_path / "web-markup.pdf")
    reopened = reopen(out)
    try:
        with reopened.lock:
            kinds = {a.type for i in (0, 1) for a in reopened.document.page(i).annotations()}
            texts = {a.contents for a in reopened.document.page(0).annotations()}
        assert {AnnotationType.HIGHLIGHT, AnnotationType.SQUIGGLY} <= kinds
        assert "Marked" in texts
    finally:
        with reopened.lock:
            reopened.document.close()
    record("comment_count_pikepdf", out, count=expected)
    record("page_count_pdfium", out, pages=s.page_count)
    record("render_first_page_pdfium", out)


def test_the_mark_text_wire_args_convert() -> None:
    wire = {
        "kind": "underline",
        "areas": [
            {
                "page": 1,
                "quads": [
                    {
                        "ul": {"x": 10.0, "y": 20.0},
                        "ur": {"x": 90.0, "y": 20.0},
                        "ll": {"x": 10.0, "y": 32.0},
                        "lr": {"x": 90.0, "y": 32.0},
                    }
                ],
                "text": "Key",
            }
        ],
    }
    args = from_json(MarkText, wire, BufferTable([]), "args")
    assert args.kind is MarkupKind.UNDERLINE
    assert args.areas[0].quads[0] == Quad.from_rect(Rect(10, 20, 90, 32))


# -- standard stamps (W7.3 S6) --------------------------------------------------------------------


def stamp(s: DocumentSession, name: str, at: Point) -> object:
    """A click at ``at`` with the stamp tool; the click is a zero-size rect, as the web sends."""
    return make(s, CreateAnnotation(CommentTool.STAMP, 0, Rect(at.x, at.y, at.x, at.y), stamp=name))


def test_a_stamp_is_centred_on_the_click_with_its_name(open_copy: Opener) -> None:
    s = open_copy("annotations")
    made = made_on_page(s, stamp(s, "Approved", Point(300, 300)))
    assert made.type is AnnotationType.STAMP
    assert made.icon == "Approved"
    # MuPDF fits the stamp's own aspect inside the box it is given, so the box shrinks about
    # its centre: the centre stays on the click.
    assert made.rect.center.x == pytest.approx(300, abs=0.01)
    assert made.rect.center.y == pytest.approx(300, abs=0.01)
    assert standard_stamp_box(Point(300, 300)) == Rect(220, 275, 380, 325)


def test_a_stamp_off_the_page_adds_nothing(open_copy: Opener) -> None:
    s = open_copy("annotations")
    assert not stamp(s, "Draft", Point(5000, 5000)).executed  # type: ignore[attr-defined]
    assert not s.undo_stack.can_undo


@pytest.mark.parametrize("name", ["", "Custom", "image:logo.png"])
def test_an_unknown_stamp_name_is_refused(open_copy: Opener, name: str) -> None:
    s = open_copy("annotations")
    before = [a.name for a in on_page(s)]
    with pytest.raises(Refused):
        stamp(s, name, Point(300, 300))
    assert [a.name for a in on_page(s)] == before


def test_undo_removes_a_stamp(open_copy: Opener) -> None:
    s = open_copy("annotations")
    before = [a.name for a in on_page(s)]
    assert stamp(s, "Final", Point(300, 300)).executed  # type: ignore[attr-defined]
    assert s.undo()
    assert [a.name for a in on_page(s)] == before


def test_round_trip_of_a_stamp(open_copy: Opener, tmp_path: Path) -> None:
    """The stamp saves, reopens with its name, and renders ink inside its box (pikepdf and
    pypdfium2, the round-trip rule)."""
    s = open_copy("annotations")
    stamp(s, "Approved", Point(300, 300))
    out = s.save(tmp_path / "stamp.pdf")

    reopened = reopen(out)
    try:
        with reopened.lock:
            stamps = [
                m for m in reopened.document.page(0).annotations() if m.type is AnnotationType.STAMP
            ]
        assert [m.icon for m in stamps] == ["Approved"]
    finally:
        with reopened.lock:
            reopened.document.close()
    record("annot_keys_pikepdf", out, subtype="/Stamp", present=["/Name"])
    record("ink_region_pdfium", out, page=0, clip=[220.0, 275.0, 380.0, 325.0])
    record("render_first_page_pdfium", out)


# -- custom image stamps (W7.3b S2) ---------------------------------------------------------------


def png_bytes(size: tuple[int, int], color: tuple[int, int, int] = (20, 20, 20)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


def png_with_pixels(width: int, height: int) -> bytes:
    """A 1-bit PNG whose header declares more pixels than the web's cap; the file stays small."""
    buf = io.BytesIO()
    Image.new("1", (width, height), 0).save(buf, format="PNG")
    return buf.getvalue()


def image_stamp(s: DocumentSession, data: bytes, at: Point, label: str = "Logo") -> object:
    """A click at ``at`` with a custom image stamp (a zero-size rect, as the web sends)."""
    args = CreateAnnotation(
        CommentTool.STAMP, 0, Rect(at.x, at.y, at.x, at.y), text=label, image=data
    )
    return make(s, args)


@pytest.fixture
def web_platform() -> Iterator[None]:
    """The browser's image rules (formats and caps) for the test, then the desktop's again."""
    previous = model_platform.current()
    model_platform.configure(WEB_PLATFORM)
    try:
        yield
    finally:
        model_platform.configure(previous)


def test_a_custom_stamp_is_sized_by_stamp_rect_and_centred(open_copy: Opener) -> None:
    s = open_copy("annotations")
    # 400 x 200 px is 300 x 150 pt at 96 DPI; the longer side is cut to 200 pt (stamp_rect).
    made = made_on_page(s, image_stamp(s, png_bytes((400, 200)), Point(300, 300)))
    assert made.type is AnnotationType.STAMP
    assert made.icon == IMAGE_STAMP
    assert made.contents == "Logo"
    assert made.rect.x0 == pytest.approx(200) and made.rect.x1 == pytest.approx(400)
    assert made.rect.y0 == pytest.approx(250) and made.rect.y1 == pytest.approx(350)


def test_a_custom_stamp_off_the_page_adds_nothing(open_copy: Opener) -> None:
    s = open_copy("annotations")
    assert not image_stamp(s, png_bytes((40, 40)), Point(5000, 5000)).executed  # type: ignore[attr-defined]
    assert not s.undo_stack.can_undo


def test_a_custom_stamp_with_a_standard_name_is_refused(open_copy: Opener) -> None:
    s = open_copy("annotations")
    before = [a.name for a in on_page(s)]
    args = CreateAnnotation(
        CommentTool.STAMP, 0, Rect(300, 300, 300, 300), stamp="Approved", image=png_bytes((40, 40))
    )
    with pytest.raises(Refused):
        make(s, args)
    assert [a.name for a in on_page(s)] == before


def test_a_gif_is_refused_as_a_stamp_image(open_copy: Opener) -> None:
    s = open_copy("annotations")
    buf = io.BytesIO()
    Image.new("RGB", (40, 40), (0, 0, 200)).save(buf, format="GIF")
    with pytest.raises(Refused) as caught:
        image_stamp(s, buf.getvalue(), Point(300, 300))
    assert caught.value.reason == "image_format"


@pytest.mark.parametrize(
    ("data", "reason"),
    [
        pytest.param(b"", "image_unreadable", id="empty"),
        pytest.param(b"not an image at all", "image_unreadable", id="garbage"),
        pytest.param(b"\x00" * (MAX_IMAGE_BYTES + 1), "image_too_large", id="too_large"),
        pytest.param(png_with_pixels(5000, 5001), "image_too_many_pixels", id="too_many_pixels"),
    ],
)
def test_a_custom_stamp_image_over_the_web_limits_is_refused(
    open_copy: Opener, web_platform: None, data: bytes, reason: str
) -> None:
    s = open_copy("annotations")
    with pytest.raises(Refused) as caught:
        image_stamp(s, data, Point(300, 300))
    assert caught.value.reason == reason


def test_undo_removes_a_custom_stamp(open_copy: Opener) -> None:
    s = open_copy("annotations")
    before = [a.name for a in on_page(s)]
    assert image_stamp(s, png_bytes((40, 40)), Point(300, 300)).executed  # type: ignore[attr-defined]
    assert s.undo()
    assert [a.name for a in on_page(s)] == before


def test_the_web_wire_args_carry_the_stamp_image() -> None:
    """The picture arrives as a $bin buffer and becomes the action's bytes."""
    data = png_bytes((40, 30))
    wire = {
        "tool": "stamp",
        "page": 0,
        "rect": {"x0": 10.0, "y0": 20.0, "x1": 10.0, "y1": 20.0},
        "text": "Logo",
        "stamp": "",
        "image": {"$bin": 0},
    }
    args = from_json(CreateAnnotation, wire, BufferTable([data]), "args")
    assert args.image == data
    assert args.text == "Logo"


def test_round_trip_of_a_custom_stamp(open_copy: Opener, tmp_path: Path) -> None:
    """The stamp saves with its picture and label, reopens as an image stamp, and draws ink in
    its box (pikepdf and pypdfium2, the round-trip rule)."""
    s = open_copy("annotations")
    image_stamp(s, png_bytes((400, 200)), Point(300, 300))
    out = s.save(tmp_path / "custom_stamp.pdf")

    reopened = reopen(out)
    try:
        with reopened.lock:
            stamps = [
                m for m in reopened.document.page(0).annotations() if m.type is AnnotationType.STAMP
            ]
        assert [m.icon for m in stamps] == [IMAGE_STAMP]
    finally:
        with reopened.lock:
            reopened.document.close()
    record("stamp_image_pikepdf", out, page=0)
    record("annot_keys_pikepdf", out, subtype="/Stamp", present=["/Name"], contents="Logo")
    record("ink_region_pdfium", out, page=0, clip=[200.0, 250.0, 400.0, 350.0])
    record("render_first_page_pdfium", out)


# -- file attachments (#732 part 2) ----------------------------------------------------------------


def attach(s: DocumentSession, data: bytes, at: Point, name: str = "notes.txt") -> object:
    """A click at ``at`` with the Attach tool and a picked file (a zero-size rect, as the web)."""
    args = CreateAnnotation(
        CommentTool.ATTACH, 0, Rect(at.x, at.y, at.x, at.y), file_name=name, file=data
    )
    return make(s, args)


@pytest.fixture
def small_attachment_cap() -> Iterator[None]:
    """A 1 KiB cap, so the oversize test does not need a 100 MB file (the web's cap is larger)."""
    previous = model_platform.current()
    model_platform.configure(dataclasses.replace(previous, max_attachment_bytes=1024))
    try:
        yield
    finally:
        model_platform.configure(previous)


def test_an_attach_comment_carries_the_file_and_its_name(open_copy: Opener) -> None:
    s = open_copy("annotations")
    result = attach(s, b"hello file", Point(300, 300))
    assert result.executed and result.label == "Attach File"  # type: ignore[attr-defined]
    assert s.undo_stack.undo_label == "Attach File"
    model = made_on_page(s, result)
    assert model.type is AnnotationType.FILE_ATTACHMENT
    assert model.file_name == "notes.txt"
    assert model.file_data == b"hello file"
    assert model.contents == "notes.txt"


def test_an_attach_comment_is_boxed_at_the_note_icon_size() -> None:
    """The builder boxes it as the desktop does (the engine reads a file icon back at its own
    size, so the check is on the model the builder makes)."""
    model = build_attachment(0, Point(300, 300), "notes.txt", b"x")
    assert (model.rect.x0, model.rect.y0) == (300, 300)
    assert model.rect.x1 - model.rect.x0 == NOTE_SIZE
    assert model.rect.y1 - model.rect.y0 == NOTE_SIZE


def test_an_empty_file_is_refused_and_adds_nothing(open_copy: Opener) -> None:
    s = open_copy("annotations")
    before = [a.name for a in on_page(s)]
    with pytest.raises(Refused) as caught:
        attach(s, b"", Point(300, 300))
    assert caught.value.reason == "attachment_empty"
    assert [a.name for a in on_page(s)] == before


def test_an_oversize_file_is_refused_and_adds_nothing(
    open_copy: Opener, small_attachment_cap: None
) -> None:
    s = open_copy("annotations")
    before = [a.name for a in on_page(s)]
    with pytest.raises(Refused) as caught:
        attach(s, b"x" * 2048, Point(300, 300))
    assert caught.value.reason == "attachment_too_large"
    assert [a.name for a in on_page(s)] == before


def test_a_file_at_the_cap_is_allowed(open_copy: Opener, small_attachment_cap: None) -> None:
    s = open_copy("annotations")
    assert attach(s, b"x" * 1024, Point(300, 300)).executed  # type: ignore[attr-defined]


def test_a_file_without_a_usable_name_is_refused(open_copy: Opener) -> None:
    s = open_copy("annotations")
    with pytest.raises(Refused) as caught:
        attach(s, b"x", Point(300, 300), name="..")
    assert caught.value.reason == "attachment_name"


def test_an_attach_click_off_the_page_adds_nothing(open_copy: Opener) -> None:
    s = open_copy("annotations")
    before = [a.name for a in on_page(s)]
    result = attach(s, b"x", Point(10_000, 10_000))
    assert not result.executed  # type: ignore[attr-defined]
    assert [a.name for a in on_page(s)] == before


def test_undo_removes_the_attachment(open_copy: Opener) -> None:
    s = open_copy("annotations")
    before = [a.name for a in on_page(s)]
    assert attach(s, b"x", Point(300, 300)).executed  # type: ignore[attr-defined]
    assert s.undo()
    assert [a.name for a in on_page(s)] == before


def test_the_web_wire_args_carry_the_attachment() -> None:
    """The file arrives as a $bin buffer and becomes the action's bytes, with its name."""
    wire = {
        "tool": "attach",
        "page": 0,
        "rect": {"x0": 10.0, "y0": 20.0, "x1": 10.0, "y1": 20.0},
        "text": "",
        "file_name": "report.pdf",
        "file": {"$bin": 0},
    }
    args = from_json(CreateAnnotation, wire, BufferTable([b"%PDF-1.4"]), "args")
    assert args.file == b"%PDF-1.4"
    assert args.file_name == "report.pdf"
    assert args.tool is CommentTool.ATTACH


def test_round_trip_of_an_attachment(open_copy: Opener, tmp_path: Path) -> None:
    """The attachment saves with its file and reopens with the same name and bytes; it is in
    pikepdf's view as a FileAttachment with a file spec, and renders in pypdfium2."""
    s = open_copy("annotations")
    attach(s, b"hello file", Point(300, 300))
    out = s.save(tmp_path / "attachment.pdf")

    reopened = reopen(out)
    try:
        with reopened.lock:
            files = [
                m
                for m in reopened.document.page(0).annotations()
                if m.type is AnnotationType.FILE_ATTACHMENT
            ]
        assert [(m.file_name, m.file_data) for m in files] == [("notes.txt", b"hello file")]
    finally:
        with reopened.lock:
            reopened.document.close()
    record(
        "annot_keys_pikepdf", out, subtype="/FileAttachment", present=["/FS"], contents="notes.txt"
    )
    record("render_first_page_pdfium", out)
