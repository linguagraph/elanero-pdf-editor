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
from pdfeditor.core.commands import AddAnnotationCommand
from pdfeditor.core.session import DocumentSession
from pdfeditor.model.annotations import AnnotationModel, AnnotationType, AnnotRef
from pdfeditor.model.geometry import Point, Quad, Rect

# The size of a sticky note's icon, in points (the desktop's NoteTool uses the same).
NOTE_SIZE = 20.0


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
    """A square (rectangle tool) drawn in the desktop's default style for ``kind``."""
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
    kind: AnnotationType, page: int, rect: Rect, text: str = "", author: str = ""
) -> AnnotationModel:
    """A text-markup comment (highlight) covering ``rect``, with the desktop's default colour."""
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
        quads=(Quad.from_rect(rect),),
    )


class CommentTool(StrEnum):
    """The comment tools the web offers. The value is the name the web sends."""

    NOTE = "note"
    RECTANGLE = "rectangle"
    HIGHLIGHT = "highlight"


@dataclass(frozen=True, slots=True)
class CreateAnnotation:
    """One comment from one gesture. ``rect`` is in page points, visible space, origin top-left.
    A note uses only the top-left corner of ``rect``."""

    tool: CommentTool
    page: int
    rect: Rect
    text: str = ""
    author: str = ""


_UNDO_LABELS = {
    CommentTool.NOTE: "Add Sticky Note",
    CommentTool.RECTANGLE: "Add Rectangle",
    CommentTool.HIGHLIGHT: "Add Highlight",
}


def _clipped(rect: Rect, page: Rect) -> Rect | None:
    """``rect`` limited to the page, or None when nothing of it is on the page or it has no area."""
    x0, y0 = max(rect.x0, page.x0), max(rect.y0, page.y0)
    x1, y1 = min(rect.x1, page.x1), min(rect.y1, page.y1)
    if x1 - x0 <= 0 or y1 - y0 <= 0:
        return None
    return Rect(x0, y0, x1, y1)


@action("annotations.create", CreateAnnotation, requires=WRITE)
def create(session: DocumentSession, args: CreateAnnotation) -> ActionResult[tuple[AnnotRef, ...]]:
    ensure_idle(session)
    label = _UNDO_LABELS[args.tool]
    with session.lock:
        if not 0 <= args.page < session.document.page_count:
            raise Refused(f"page {args.page + 1} does not exist")
        page_rect = session.document.page(args.page).rect
    if args.tool is CommentTool.NOTE:
        point = Point(args.rect.x0, args.rect.y0)
        icon = Rect(point.x, point.y, point.x + NOTE_SIZE, point.y + NOTE_SIZE)
        if _clipped(icon, page_rect) is None:  # the click is off the page
            return ActionResult(label, (), False)
        model = build_note(args.page, point, args.text, args.author)
    else:
        box = _clipped(args.rect, page_rect)
        if box is None:  # off the page, or a click without a drag
            return ActionResult(label, (), False)
        if args.tool is CommentTool.RECTANGLE:
            model = build_shape(AnnotationType.SQUARE, args.page, box, args.author)
        else:
            model = build_markup(AnnotationType.HIGHLIGHT, args.page, box, args.text, args.author)
    command = AddAnnotationCommand(model, label)
    if not execute_all(session, [command], label):
        return ActionResult(label, (), False)
    return ActionResult(label, (AnnotRef(args.page, command.model.name),), True)
