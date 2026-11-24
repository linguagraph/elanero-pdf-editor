"""Comment tools for the web (W7.1a): the shared builders and the ``annotations.create`` action.

The desktop tools build their comments in ``ui/tools/annotate.py``. These builders make the same
models from the same styles (``DEFAULT_STYLES``), so a comment made in the browser is the one the
desktop would make. The web sends only the gesture, in page points, and this module decides what
the comment is. Each tool here is a subset of the desktop's: the rest are listed in PLAN.md.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from pdfeditor.actions import action
from pdfeditor.actions.base import ActionResult, Refused, ensure_idle, execute_all
from pdfeditor.actions.comments import DEFAULT_STYLES, WRITE
from pdfeditor.actions.edit_geometry import MIN_DRAG
from pdfeditor.core.commands import AddAnnotationCommand
from pdfeditor.core.session import DocumentSession
from pdfeditor.model.annotations import (
    STANDARD_STAMPS,
    AnnotationModel,
    AnnotationType,
    AnnotRef,
    callout_line,
)
from pdfeditor.model.color import Color
from pdfeditor.model.geometry import MarkupArea, PageRects, Point, Quad, Rect, simplify

# The size of a sticky note's icon, in points (the desktop's NoteTool uses the same).
NOTE_SIZE = 20.0
# A text box or callout drawn as a click gets a box this size (the desktop's default).
DEFAULT_BOX_SIZE = (180.0, 40.0)
# The most points one comment takes (a pen stroke at 60 Hz is about 1 000 points).
MAX_POINTS = 10_000
# The most UTF-8 bytes of text one comment takes.
MAX_TEXT_BYTES = 64 * 1024
# Stroke simplification tolerance for a pen stroke, in points (the desktop's InkTool).
INK_TOLERANCE = 0.6
# Polygon or polyline vertices closer than this (Manhattan, points) are one: a double-click
# leaves a duplicate behind (the desktop's PolyTool.finish drops it).
REPEAT_TOLERANCE = 1.0
# A standard stamp's box, in points, centred on the click (the desktop's StampTool).
STAMP_SIZE = (160.0, 50.0)


def build_note(page: int, point: Point, text: str, author: str = "") -> AnnotationModel:
    """A sticky note whose icon's top-left corner is ``point``."""
    style = DEFAULT_STYLES[AnnotationType.TEXT]
    rect = Rect(point.x, point.y, point.x + NOTE_SIZE, point.y + NOTE_SIZE)
    return AnnotationModel(
        AnnotationType.TEXT,
        page,
        rect,
        color=style.color,
        fill=style.fill,
        border_width=style.width,
        opacity=style.opacity,
        author=author,
        contents=text,
        icon="Comment",
    )


def build_shape(kind: AnnotationType, page: int, rect: Rect, author: str = "") -> AnnotationModel:
    """A square (rectangle tool) or circle (oval tool) drawn in the desktop's default style."""
    style = DEFAULT_STYLES[kind]
    return AnnotationModel(
        kind,
        page,
        rect,
        color=style.color,
        fill=style.fill,
        border_width=style.width,
        opacity=style.opacity,
        author=author,
    )


def build_markup(
    kind: AnnotationType,
    page: int,
    rect: Rect,
    text: str = "",
    author: str = "",
    quads: tuple[Quad, ...] | None = None,
) -> AnnotationModel:
    """A text-markup comment (highlight) covering ``rect``, with the desktop's default colour.
    ``quads`` gives one quad per line; the default is one quad for ``rect``."""
    style = DEFAULT_STYLES[kind]
    return AnnotationModel(
        kind,
        page,
        rect,
        color=style.color,
        border_width=style.width,
        opacity=style.opacity,
        author=author,
        contents=text,
        quads=quads or (Quad.from_rect(rect),),
    )


def standard_stamp_box(center: Point) -> Rect:
    """The box a standard stamp takes when it is placed at ``center``."""
    w, h = STAMP_SIZE
    return Rect(center.x - w / 2, center.y - h / 2, center.x + w / 2, center.y + h / 2)


def build_stamp(page: int, rect: Rect, name: str, author: str = "") -> AnnotationModel:
    """A standard stamp named ``name`` (one of ``STANDARD_STAMPS``) in ``rect``. The caller
    checks the name; the desktop's StampTool and the web's STAMP tool both build through here."""
    style = DEFAULT_STYLES[AnnotationType.STAMP]
    return AnnotationModel(
        AnnotationType.STAMP,
        page,
        rect,
        color=style.color,
        fill=style.fill,
        border_width=style.width,
        opacity=style.opacity,
        author=author,
        icon=name,
    )


def build_text_box(page: int, box: Rect, text: str, author: str = "") -> AnnotationModel:
    """A text box: black 12 pt text and no border colour, as the desktop's Text Box tool."""
    style = DEFAULT_STYLES[AnnotationType.FREE_TEXT]
    return AnnotationModel(
        AnnotationType.FREE_TEXT,
        page,
        box,
        fill=style.fill,
        border_width=style.width,
        opacity=style.opacity,
        author=author,
        contents=text,
        text_color=Color(0, 0, 0),
        font_size=12.0,
    )


def build_callout(page: int, tip: Point, box: Rect, text: str, author: str = "") -> AnnotationModel:
    """A text box with a leader line from ``tip`` to ``box``, with an open arrow at the tip."""
    style = DEFAULT_STYLES[AnnotationType.FREE_TEXT]
    return AnnotationModel(
        AnnotationType.FREE_TEXT,
        page,
        box,
        color=Color(0, 0, 0),  # the box's border and the leader line
        fill=style.fill,
        border_width=style.width,
        opacity=style.opacity,
        author=author,
        contents=text,
        text_color=Color(0, 0, 0),
        font_size=12.0,
        vertices=callout_line(tip, box),
        line_endings=("OpenArrow", "None"),
    )


def build_ink(page: int, stroke: list[Point], author: str = "") -> AnnotationModel:
    """A freehand stroke, already simplified: one stroke per comment."""
    style = DEFAULT_STYLES[AnnotationType.INK]
    return AnnotationModel(
        AnnotationType.INK,
        page,
        Rect.from_points(stroke),
        color=style.color,
        fill=style.fill,
        border_width=style.width,
        opacity=style.opacity,
        author=author,
        ink=(tuple(stroke),),
    )


def build_line(page: int, a: Point, b: Point, arrow: bool, author: str = "") -> AnnotationModel:
    """A line from ``a`` to ``b``; ``arrow`` puts an open arrow at ``b``."""
    style = DEFAULT_STYLES[AnnotationType.LINE]
    return AnnotationModel(
        AnnotationType.LINE,
        page,
        Rect.from_points([a, b]),
        color=style.color,
        fill=style.fill,
        border_width=style.width,
        opacity=style.opacity,
        author=author,
        vertices=(a, b),
        line_endings=("None", "OpenArrow" if arrow else "None"),
    )


def build_poly(
    kind: AnnotationType, page: int, vertices: list[Point], author: str = ""
) -> AnnotationModel:
    """A polygon or polyline through ``vertices``."""
    style = DEFAULT_STYLES[kind]
    return AnnotationModel(
        kind,
        page,
        Rect.from_points(vertices),
        color=style.color,
        fill=style.fill,
        border_width=style.width,
        opacity=style.opacity,
        author=author,
        vertices=tuple(vertices),
    )


def default_box(tip: Point, at: Point) -> Rect:
    """A default-size text box placed at ``at``, on the side of ``at`` away from the ``tip``."""
    w, h = DEFAULT_BOX_SIZE
    x0 = at.x if at.x >= tip.x else at.x - w
    return Rect(x0, at.y - h / 2, x0 + w, at.y + h / 2)


class CommentTool(StrEnum):
    """The comment tools the web offers. The value is the name the web sends, and the desktop's
    tool name (``ui/tools/annotate.py``, ``tool_for``)."""

    NOTE = "note"
    RECTANGLE = "rectangle"
    HIGHLIGHT = "highlight"
    TEXTBOX = "textbox"
    CALLOUT = "callout"
    PEN = "pen"
    LINE = "line"
    ARROW = "arrow"
    OVAL = "oval"
    POLYGON = "polygon"
    POLYLINE = "polyline"
    STAMP = "stamp"


@dataclass(frozen=True, slots=True)
class CreateAnnotation:
    """One comment from one gesture. Coordinates are in page points, visible space, origin
    top-left.

    A note uses the top-left corner of ``rect``. Box tools use ``rect``; a box too small to be a
    drag gets the tool's default size where the tool has one (text box, callout). A callout's
    ``rect`` is its box and its single tip is ``points[0]``. Pen, line, arrow, polygon and
    polyline use ``points`` and ignore ``rect``. A stamp is placed at the top-left corner of
    ``rect`` (a click is a zero-size rect) and takes its name from ``stamp``."""

    tool: CommentTool
    page: int
    rect: Rect
    text: str = ""
    author: str = ""
    points: tuple[Point, ...] = ()
    stamp: str = ""


_UNDO_LABELS = {
    CommentTool.NOTE: "Add Sticky Note",
    CommentTool.RECTANGLE: "Add Rectangle",
    CommentTool.HIGHLIGHT: "Add Highlight",
    CommentTool.TEXTBOX: "Add Text Box",
    CommentTool.CALLOUT: "Add Callout",
    CommentTool.PEN: "Add Drawing",
    CommentTool.LINE: "Add Line",
    CommentTool.ARROW: "Add Arrow",
    CommentTool.OVAL: "Add Oval",
    CommentTool.POLYGON: "Add Polygon",
    CommentTool.POLYLINE: "Add Polyline",
    CommentTool.STAMP: "Add Stamp",
}

# Tools whose comment is a box of text: a blank one adds nothing. A sticky note may be blank (the
# desktop's NoteTool allows it), so it is not here.
_TEXT_TOOLS = {CommentTool.TEXTBOX, CommentTool.CALLOUT}


def _clipped(rect: Rect, page: Rect) -> Rect | None:
    """``rect`` limited to the page, or None when nothing of it is on the page or it has no area."""
    x0, y0 = max(rect.x0, page.x0), max(rect.y0, page.y0)
    x1, y1 = min(rect.x1, page.x1), min(rect.y1, page.y1)
    if x1 - x0 <= 0 or y1 - y0 <= 0:
        return None
    return Rect(x0, y0, x1, y1)


def _is_click(a: Point, b: Point) -> bool:
    """Whether a press at ``a`` released at ``b`` is a click. The design says a drag under
    ``MIN_DRAG`` on both axes adds nothing, so exactly ``MIN_DRAG`` draws (the desktop's
    ``annotate._is_click`` is strict too; the shared ``edit_geometry.is_click`` is not)."""
    return abs(b.x - a.x) < MIN_DRAG and abs(b.y - a.y) < MIN_DRAG


def _is_drag(rect: Rect) -> bool:
    """Whether ``rect`` was drawn as a drag rather than a click."""
    return not _is_click(Point(rect.x0, rect.y0), Point(rect.x1, rect.y1))


def _clamped(points: tuple[Point, ...], page: Rect) -> list[Point]:
    """``points`` moved onto the page (a drag may leave it). Refuses too many."""
    if len(points) > MAX_POINTS:
        raise Refused(f"a comment takes at most {MAX_POINTS:,} points")
    return [Point(min(max(p.x, page.x0), page.x1), min(max(p.y, page.y0), page.y1)) for p in points]


def _without_repeats(points: list[Point]) -> list[Point]:
    out: list[Point] = []
    for p in points:
        if not out or abs(p.x - out[-1].x) + abs(p.y - out[-1].y) > REPEAT_TOLERANCE:
            out.append(p)
    return out


def _build_point_tool(args: CreateAnnotation, page: Rect) -> AnnotationModel | None:
    """The comment for a pen, line, arrow, polygon or polyline; None when it adds nothing."""
    pts = _clamped(args.points, page)
    if args.tool is CommentTool.PEN:
        stroke = simplify(pts, INK_TOLERANCE)
        return build_ink(args.page, stroke, args.author) if len(stroke) >= 2 else None
    if args.tool in (CommentTool.LINE, CommentTool.ARROW):
        if len(pts) != 2:
            raise Refused("a line takes exactly 2 points")
        a, b = pts
        if _is_click(a, b):
            return None
        return build_line(args.page, a, b, args.tool is CommentTool.ARROW, args.author)
    kind = AnnotationType.POLYGON if args.tool is CommentTool.POLYGON else AnnotationType.POLYLINE
    vertices = _without_repeats(pts)
    minimum = 3 if kind is AnnotationType.POLYGON else 2
    if len(vertices) < minimum:
        raise Refused(f"a {args.tool.value} takes at least {minimum} distinct points")
    return build_poly(kind, args.page, vertices, args.author)


def _check_text(text: str) -> None:
    """Refuse text the document cannot store: a lone surrogate (JSON can carry one, UTF-8 cannot)
    or more than ``MAX_TEXT_BYTES``."""
    try:
        size = len(text.encode("utf-8"))
    except UnicodeEncodeError:
        raise Refused("a comment's text must be valid Unicode") from None
    if size > MAX_TEXT_BYTES:
        raise Refused(f"a comment's text takes at most {MAX_TEXT_BYTES // 1024} KiB")


def _build(args: CreateAnnotation, page: Rect) -> AnnotationModel | None:
    """The comment ``args`` describes, or None when the gesture adds nothing (off the page, too
    small, or a text tool with no text). Raises Refused for input the web can't legitimately send.
    """
    tool = args.tool
    _check_text(args.text)
    if tool in _TEXT_TOOLS and not args.text.strip():
        return None
    if tool is CommentTool.STAMP:
        if args.stamp not in STANDARD_STAMPS:
            raise Refused("a stamp must be one of the standard stamps")
        point = Point(args.rect.x0, args.rect.y0)
        if not (page.x0 <= point.x <= page.x1 and page.y0 <= point.y <= page.y1):
            return None  # the click is off the page
        return build_stamp(args.page, standard_stamp_box(point), args.stamp, args.author)
    if tool is CommentTool.NOTE:
        point = Point(args.rect.x0, args.rect.y0)
        icon = Rect(point.x, point.y, point.x + NOTE_SIZE, point.y + NOTE_SIZE)
        if _clipped(icon, page) is None:  # the click is off the page
            return None
        return build_note(args.page, point, args.text, args.author)
    if tool in (
        CommentTool.PEN,
        CommentTool.LINE,
        CommentTool.ARROW,
        CommentTool.POLYGON,
        CommentTool.POLYLINE,
    ):
        return _build_point_tool(args, page)
    if tool is CommentTool.CALLOUT:
        pts = _clamped(args.points, page)
        if len(pts) != 1:
            raise Refused("a callout takes exactly 1 point, its tip")
        tip = pts[0]
        drawn = args.rect.normalized()
        box = drawn if _is_drag(drawn) else default_box(tip, Point(drawn.x0, drawn.y0))
        clipped = _clipped(box, page)
        if clipped is None:
            return None
        return build_callout(args.page, tip, clipped, args.text, args.author)
    if tool is CommentTool.TEXTBOX:
        drawn = args.rect.normalized()
        w, h = DEFAULT_BOX_SIZE
        box = drawn if _is_drag(drawn) else Rect(drawn.x0, drawn.y0, drawn.x0 + w, drawn.y0 + h)
        clipped = _clipped(box, page)
        if clipped is None:
            return None
        return build_text_box(args.page, clipped, args.text, args.author)
    area = _clipped(args.rect, page)
    if area is None:  # off the page, or a click without a drag
        return None
    if tool is CommentTool.RECTANGLE:
        return build_shape(AnnotationType.SQUARE, args.page, area, args.author)
    if tool is CommentTool.OVAL:
        return build_shape(AnnotationType.CIRCLE, args.page, area, args.author)
    return build_markup(AnnotationType.HIGHLIGHT, args.page, area, args.text, args.author)


@action("annotations.create", CreateAnnotation, requires=WRITE)
def create(session: DocumentSession, args: CreateAnnotation) -> ActionResult[tuple[AnnotRef, ...]]:
    ensure_idle(session)
    label = _UNDO_LABELS[args.tool]
    with session.lock:
        if not 0 <= args.page < session.document.page_count:
            raise Refused(f"page {args.page + 1} does not exist")
        page_rect = session.document.page(args.page).rect
    model = _build(args, page_rect)
    if model is None:
        return ActionResult(label, (), False)
    command = AddAnnotationCommand(model, label)
    if not execute_all(session, [command], label):
        return ActionResult(label, (), False)
    return ActionResult(label, (AnnotRef(args.page, command.model.name),), True)


# The most rectangles one highlight call takes (a selection's lines, over all its pages).
MAX_HIGHLIGHT_RECTS = 2000
_HIGHLIGHT_LABEL = "Add Note to Text"


@dataclass(frozen=True, slots=True)
class HighlightText:
    """A highlight over a text selection (W6.6 Add as note). The note goes on the first highlight
    only, as on the desktop, so a multi-page selection carries one note, not one per page."""

    pages: tuple[PageRects, ...]
    note: str = ""
    author: str = ""


@action("annotations.highlight_text", HighlightText, requires=WRITE)
def highlight_text(
    session: DocumentSession, args: HighlightText
) -> ActionResult[tuple[AnnotRef, ...]]:
    """One highlight per page, a quad per line, all in one undo step. Lines off the page are
    clipped away; a page left with none gets no highlight."""
    ensure_idle(session)
    if sum(len(entry.rects) for entry in args.pages) > MAX_HIGHLIGHT_RECTS:
        raise Refused(f"a highlight takes at most {MAX_HIGHLIGHT_RECTS:,} rectangles")
    commands: list[AddAnnotationCommand] = []
    pages: list[int] = []  # the page of each command, in order
    with session.lock:
        for entry in args.pages:
            if not 0 <= entry.page < session.document.page_count:
                raise Refused(f"page {entry.page + 1} does not exist")
            page_rect = session.document.page(entry.page).rect
            lines = [box for rect in entry.rects if (box := _clipped(rect, page_rect)) is not None]
            if not lines:
                continue
            bounds = Rect(
                min(r.x0 for r in lines),
                min(r.y0 for r in lines),
                max(r.x1 for r in lines),
                max(r.y1 for r in lines),
            )
            note = args.note if not commands else ""
            model = build_markup(
                AnnotationType.HIGHLIGHT,
                entry.page,
                bounds,
                note,
                args.author,
                quads=tuple(Quad.from_rect(line) for line in lines),
            )
            commands.append(AddAnnotationCommand(model, _HIGHLIGHT_LABEL))
            pages.append(entry.page)
    if not commands or not execute_all(session, commands, _HIGHLIGHT_LABEL):
        return ActionResult(_HIGHLIGHT_LABEL, (), False)
    refs = tuple(AnnotRef(page, cmd.model.name) for page, cmd in zip(pages, commands, strict=True))
    return ActionResult(_HIGHLIGHT_LABEL, refs, True)


class MarkupKind(StrEnum):
    """The text markups a text selection can take (the desktop's ``MarkupTool``)."""

    HIGHLIGHT = "highlight"
    UNDERLINE = "underline"
    STRIKEOUT = "strikeout"
    SQUIGGLY = "squiggly"


# Each markup's comment type and the desktop's undo label.
_MARKUPS: dict[MarkupKind, tuple[AnnotationType, str]] = {
    MarkupKind.HIGHLIGHT: (AnnotationType.HIGHLIGHT, "Highlight"),
    MarkupKind.UNDERLINE: (AnnotationType.UNDERLINE, "Underline"),
    MarkupKind.STRIKEOUT: (AnnotationType.STRIKEOUT, "Strikethrough"),
    MarkupKind.SQUIGGLY: (AnnotationType.SQUIGGLY, "Squiggly Underline"),
}
# The most pages a text selection marks (the web reads this many text layers at most) and the
# most lines (quads) in all of them.
MAX_MARK_AREAS = 300
MAX_MARK_QUADS = 5000


@dataclass(frozen=True, slots=True)
class MarkText:
    """A text markup over a selection. Each area with quads is one comment; all of them are one
    undo step, so a selection across pages undoes at once."""

    kind: MarkupKind
    areas: tuple[MarkupArea, ...]
    author: str = ""


@action("annotations.mark_text", MarkText, requires=WRITE)
def mark_text(session: DocumentSession, args: MarkText) -> ActionResult[tuple[AnnotRef, ...]]:
    ensure_idle(session)
    kind, label = _MARKUPS[args.kind]
    if len(args.areas) > MAX_MARK_AREAS:
        raise Refused(f"a markup covers at most {MAX_MARK_AREAS} pages")
    if sum(len(area.quads) for area in args.areas) > MAX_MARK_QUADS:
        raise Refused(f"a markup takes at most {MAX_MARK_QUADS:,} lines")
    with session.lock:
        count = session.document.page_count
    if any(not 0 <= area.page < count for area in args.areas):
        raise Refused("a markup's page does not exist")
    commands: list[AddAnnotationCommand] = []
    for area in args.areas:
        if not area.quads:  # nothing of the selection is on this page
            continue
        _check_text(area.text)
        points = [p for q in area.quads for p in (q.ul, q.ur, q.ll, q.lr)]
        model = build_markup(
            kind, area.page, Rect.from_points(points), area.text, args.author, area.quads
        )
        commands.append(AddAnnotationCommand(model, label))
    if not execute_all(session, commands, label):
        return ActionResult(label, (), False)
    refs = tuple(AnnotRef(c.model.page_index, c.model.name) for c in commands)
    return ActionResult(label, refs, True)
