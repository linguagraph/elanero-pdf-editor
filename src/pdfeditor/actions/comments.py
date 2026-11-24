"""Comment actions (``annotations.*``): W2.1 slice (b).

``annotations.flatten`` lives in ``document.py`` (slice (d)). The module isn't named
``annotations.py``: that name clashes with ``from __future__ import annotations`` in every module
that imports it.

The helpers the desktop used to keep in ``ui/`` live here too, so the web gets the same comment
styles, restyling and move/resize maths: the comment tools' default styles, ``restyled`` and
``shown_color`` (the inspector's rules), and ``reshaped`` (a callout keeps its leader target).
See docs/web/design/W1.3.md.
"""

from __future__ import annotations

import copy
import xml.etree.ElementTree as ET
from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum

from pdfeditor.actions import action
from pdfeditor.actions.base import (
    ActionResult,
    Refused,
    StaleObject,
    current_name,
    ensure_idle,
    execute_all,
)
from pdfeditor.core.commands import (
    AddAnnotationCommand,
    Command,
    DeleteAnnotationsCommand,
    ReorderAnnotationCommand,
    UpdateAnnotationCommand,
)
from pdfeditor.core.session import DocumentSession
from pdfeditor.model.annotations import (
    AnnotationModel,
    AnnotationType,
    AnnotRef,
    ReviewState,
    callout_line,
    transformed,
)
from pdfeditor.model.color import Color
from pdfeditor.model.geometry import Matrix
from pdfeditor.services.xfdf import XfdfTooLarge, import_command

WRITE = ("annotations_write",)

# The desktop panel shows the same text for a file it refuses before reading it.
XFDF_TOO_LARGE_MESSAGE = "This XFDF file is too large to import."

# -- helpers moved from the desktop (Qt-free) ----------------------------------------------


@dataclass(frozen=True)
class CommentStyle:
    """The look a new comment starts with (was ``ui/tools/annotate.Style``)."""

    color: Color | None
    fill: Color | None = None
    width: float = 1.0
    opacity: float = 1.0


DEFAULT_STYLES: dict[AnnotationType, CommentStyle] = {
    AnnotationType.HIGHLIGHT: CommentStyle(Color(1, 0.92, 0)),
    AnnotationType.UNDERLINE: CommentStyle(Color(0, 0.6, 0.2)),
    AnnotationType.STRIKEOUT: CommentStyle(Color(0.85, 0.1, 0.1)),
    AnnotationType.SQUIGGLY: CommentStyle(Color(1, 0.45, 0)),
    AnnotationType.SQUARE: CommentStyle(Color(0.85, 0.1, 0.1), width=1.5),
    AnnotationType.CIRCLE: CommentStyle(Color(0.85, 0.1, 0.1), width=1.5),
    AnnotationType.LINE: CommentStyle(Color(0.85, 0.1, 0.1), width=1.5),
    AnnotationType.POLYGON: CommentStyle(Color(0.85, 0.1, 0.1), width=1.5),
    AnnotationType.POLYLINE: CommentStyle(Color(0.85, 0.1, 0.1), width=1.5),
    AnnotationType.INK: CommentStyle(Color(0.1, 0.3, 0.9), width=2.0),
    AnnotationType.TEXT: CommentStyle(Color(1, 0.85, 0.2)),
    AnnotationType.FREE_TEXT: CommentStyle(None),
    AnnotationType.STAMP: CommentStyle(None),
    AnnotationType.FILE_ATTACHMENT: CommentStyle(Color(0.2, 0.4, 0.8)),
}


def restyled(before: AnnotationModel, field: str, value: object) -> AnnotationModel | None:
    """``before`` with ``field`` set to ``value``, or None when that changes nothing or the
    comment is locked (locked comments only allow unlocking).

    A text box's "color" is its text color: its border keeps its own."""
    if field != "locked" and before.locked:
        return None
    current = before.text_color if _is_text_color(before, field) else getattr(before, field)
    if current == value:
        return None
    after = copy.deepcopy(before)
    if _is_text_color(before, field):
        after.text_color = value  # type: ignore[assignment]
    else:
        setattr(after, field, value)
    return after


def _is_text_color(model: AnnotationModel, field: str) -> bool:
    return field == "color" and model.type is AnnotationType.FREE_TEXT


def shown_color(model: AnnotationModel) -> Color | None:
    """The color a comment's "Color" control shows (a text box: its text)."""
    return model.color or (model.text_color if model.type is AnnotationType.FREE_TEXT else None)


def reshaped(model: AnnotationModel, m: Matrix, resize: bool) -> AnnotationModel:
    """``model`` moved or resized by ``m``. Resizing a callout resizes its box only: the
    leader line keeps pointing at the same spot."""
    out = transformed(model, m)
    if resize and model.is_callout:
        out.vertices = callout_line(model.vertices[0], out.rect)
    return out


# -- argument types ------------------------------------------------------------------------


class StyleField(StrEnum):
    """The comment properties a restyle can change; the value is the model's field name."""

    COLOR = "color"
    FILL = "fill"
    OPACITY = "opacity"
    BORDER_WIDTH = "border_width"
    FONT_SIZE = "font_size"
    AUTHOR = "author"
    SUBJECT = "subject"
    CONTENTS = "contents"
    LOCKED = "locked"


_COLOR_FIELDS = {StyleField.COLOR, StyleField.FILL}
_NUMBER_FIELDS = {StyleField.OPACITY, StyleField.BORDER_WIDTH, StyleField.FONT_SIZE}
_TEXT_FIELDS = {StyleField.AUTHOR, StyleField.SUBJECT, StyleField.CONTENTS}


@dataclass(frozen=True, slots=True)
class AddAnnotations:
    models: tuple[AnnotationModel, ...]
    label: str  # the caller's undo label: "Add Drawing", "Add Sticky Note", ...


@dataclass(frozen=True, slots=True)
class PasteAnnotations:
    models: tuple[AnnotationModel, ...]
    page: int


@dataclass(frozen=True, slots=True)
class TransformAnnotations:
    refs: tuple[AnnotRef, ...]
    matrix: Matrix
    resize: bool
    # Consecutive moves with the same key are one undo step (a held arrow key, W7.1a section 3.5).
    merge_key: str = ""


@dataclass(frozen=True, slots=True)
class RestyleAnnotations:
    """One value, in the slot for the field's kind: ``color`` for color and fill, ``number`` for
    opacity, border width and font size, ``text`` for author, subject and contents, ``flag`` for
    locked. ``restyle_args`` fills the right slot from a Python value."""

    refs: tuple[AnnotRef, ...]
    field: StyleField
    label: str
    color: Color | None = None
    number: float = 0.0
    text: str = ""
    flag: bool = False
    merge_key: str = ""  # consecutive restyles with the same key are one undo step


@dataclass(frozen=True, slots=True)
class SetAnnotationText:
    ref: AnnotRef
    text: str
    label: str = "Edit Comment Text"


@dataclass(frozen=True, slots=True)
class ReplyToAnnotation:
    parent: AnnotRef
    text: str
    author: str
    state: ReviewState = ReviewState.NONE


@dataclass(frozen=True, slots=True)
class ReorderAnnotation:
    ref: AnnotRef
    to_front: bool


@dataclass(frozen=True, slots=True)
class DeleteAnnotations:
    refs: tuple[AnnotRef, ...]


@dataclass(frozen=True, slots=True)
class ImportXfdf:
    text: str


def restyle_args(
    refs: tuple[AnnotRef, ...],
    field: str,
    value: object,
    label: str,
    merge_key: str = "",
) -> RestyleAnnotations:
    """The args of a restyle, with ``value`` in the slot for ``field``'s kind.

    Raises ``TypeError`` for a value of the wrong kind, so a desktop control can't send a
    number for a color."""
    kind = StyleField(field)  # ValueError for an unknown field name
    if kind in _COLOR_FIELDS:
        if value is None or isinstance(value, Color):
            return RestyleAnnotations(refs, kind, label, color=value, merge_key=merge_key)
        raise TypeError(f"{kind.value} takes a Color or None, not {type(value).__name__}")
    if kind in _NUMBER_FIELDS:
        if isinstance(value, int | float) and not isinstance(value, bool):
            return RestyleAnnotations(refs, kind, label, number=float(value), merge_key=merge_key)
        raise TypeError(f"{kind.value} takes a number, not {type(value).__name__}")
    if kind in _TEXT_FIELDS:
        if isinstance(value, str):
            return RestyleAnnotations(refs, kind, label, text=value, merge_key=merge_key)
        raise TypeError(f"{kind.value} takes a str, not {type(value).__name__}")
    if isinstance(value, bool):
        return RestyleAnnotations(refs, kind, label, flag=value, merge_key=merge_key)
    raise TypeError(f"{kind.value} takes a bool, not {type(value).__name__}")


# -- helpers --------------------------------------------------------------------------------


def _current(session: DocumentSession, ref: AnnotRef) -> AnnotationModel:
    """The comment as the document holds it now. Actions never trust the models a caller
    passes in for the "before" state."""
    with session.lock:
        name = current_name(session.document, ref.page, ref.name)
        for model in session.document.page(ref.page).annotations():
            if model.name == name:
                return model
    raise StaleObject(f"comment {ref.name} on page {ref.page + 1} no longer exists")


def _refs_of(commands: Sequence[AddAnnotationCommand]) -> tuple[AnnotRef, ...]:
    return tuple(AnnotRef(c.model.page_index, c.model.name) for c in commands)


def _restyle_value(args: RestyleAnnotations) -> object:
    if args.field in _COLOR_FIELDS:
        return args.color
    if args.field in _NUMBER_FIELDS:
        return args.number
    if args.field in _TEXT_FIELDS:
        return args.text
    return args.flag


# -- actions --------------------------------------------------------------------------------


@action("annotations.add", AddAnnotations, requires=WRITE)
def add(session: DocumentSession, args: AddAnnotations) -> ActionResult[tuple[AnnotRef, ...]]:
    ensure_idle(session)
    commands = [AddAnnotationCommand(m, args.label) for m in args.models]
    if not execute_all(session, commands, args.label):
        return ActionResult(args.label, (), False)
    return ActionResult(args.label, _refs_of(commands), True)


@action("annotations.paste", PasteAnnotations, requires=WRITE)
def paste(session: DocumentSession, args: PasteAnnotations) -> ActionResult[tuple[AnnotRef, ...]]:
    ensure_idle(session)
    if not args.models:
        return ActionResult("Paste Comments", (), False)
    with session.lock:
        rect = session.document.page(args.page).rect
    commands: list[AddAnnotationCommand] = []
    for original in args.models:
        model = transformed(original, Matrix.translate(12, 12))
        model.page_index = args.page
        model.name = ""
        model.id = None
        model.in_reply_to = None
        # keep pasted comments on the page even when it is smaller than the source
        b = model.rect
        if not b.intersects(rect):
            model = transformed(model, Matrix.translate(rect.x0 - b.x0 + 20, rect.y0 - b.y0 + 20))
        commands.append(AddAnnotationCommand(model, "Paste Comment"))
    execute_all(session, commands, "Paste Comments")
    label = "Paste Comment" if len(commands) == 1 else "Paste Comments"
    return ActionResult(label, _refs_of(commands), True)


@action("annotations.transform", TransformAnnotations, requires=WRITE)
def transform(session: DocumentSession, args: TransformAnnotations) -> ActionResult[None]:
    ensure_idle(session)
    label = "Resize Comment" if args.resize else "Move Comment"
    commands: list[Command] = [
        UpdateAnnotationCommand(cur, reshaped(cur, args.matrix, args.resize), label, args.merge_key)
        for cur in (_current(session, ref) for ref in args.refs)
    ]
    return ActionResult(label, None, execute_all(session, commands, label))


@action("annotations.restyle", RestyleAnnotations, requires=WRITE)
def restyle(
    session: DocumentSession, args: RestyleAnnotations
) -> ActionResult[tuple[AnnotRef, ...]]:
    ensure_idle(session)
    value = _restyle_value(args)
    commands: list[Command] = []
    changed: list[AnnotRef] = []
    for ref in args.refs:
        cur = _current(session, ref)
        after = restyled(cur, args.field.value, value)
        if after is None:  # locked, or already that value
            continue
        commands.append(UpdateAnnotationCommand(cur, after, args.label, args.merge_key))
        changed.append(AnnotRef(ref.page, cur.name))
    if not execute_all(session, commands, args.label):
        return ActionResult(args.label, (), False)
    return ActionResult(args.label, tuple(changed), True)


@action("annotations.set_text", SetAnnotationText, requires=WRITE)
def set_text(session: DocumentSession, args: SetAnnotationText) -> ActionResult[None]:
    ensure_idle(session)
    cur = _current(session, args.ref)
    if cur.locked:
        raise Refused("This comment is locked.")
    if args.text == cur.contents:
        return ActionResult(args.label, None, False)
    after = copy.deepcopy(cur)
    after.contents = args.text
    session.execute(UpdateAnnotationCommand(cur, after, args.label))
    return ActionResult(args.label, None, True)


@action("annotations.reply", ReplyToAnnotation, requires=WRITE)
def reply(session: DocumentSession, args: ReplyToAnnotation) -> ActionResult[AnnotRef]:
    ensure_idle(session)
    parent = _current(session, args.parent)
    model = AnnotationModel(
        AnnotationType.TEXT,
        parent.page_index,
        parent.rect,
        contents=args.text,
        author=args.author,
        state=args.state,
    )
    # the command resolves the parent by this name, so the reply stays linked after an undo
    model.extra = {"irt_name": parent.name}
    label = f"Set Status {args.state.value}" if args.state is not ReviewState.NONE else "Reply"
    command = AddAnnotationCommand(model, label)
    session.execute(command)
    return ActionResult(label, AnnotRef(parent.page_index, command.model.name), True)


@action("annotations.reorder", ReorderAnnotation, requires=WRITE)
def reorder(session: DocumentSession, args: ReorderAnnotation) -> ActionResult[None]:
    ensure_idle(session)
    cur = _current(session, args.ref)
    command = ReorderAnnotationCommand(args.ref.page, cur.name, args.to_front)
    session.execute(command)
    return ActionResult(command.label, None, True)


@action("annotations.delete", DeleteAnnotations, requires=WRITE)
def delete(session: DocumentSession, args: DeleteAnnotations) -> ActionResult[None]:
    ensure_idle(session)
    by_page: dict[int, list[str]] = {}
    for ref in args.refs:
        cur = _current(session, ref)
        # A locked comment stays. The desktop's UI skips it too, so both apps share the rule.
        if cur.locked:
            continue
        by_page.setdefault(ref.page, []).append(cur.name)
    # the label is passed to every command, so two comments on one page read "Delete Comments"
    label = "Delete Comments" if sum(map(len, by_page.values())) > 1 else "Delete Comment"
    commands: list[Command] = [
        DeleteAnnotationsCommand(page, names, label) for page, names in by_page.items()
    ]
    return ActionResult(label, None, execute_all(session, commands, label))


@action("annotations.import_xfdf", ImportXfdf, requires=WRITE)
def import_xfdf(session: DocumentSession, args: ImportXfdf) -> ActionResult[int]:
    ensure_idle(session)
    with session.lock:
        try:
            command = import_command(args.text, session.document)
        except XfdfTooLarge as exc:  # before the parse: nothing has changed yet
            raise Refused(XFDF_TOO_LARGE_MESSAGE) from exc
        except (ET.ParseError, ValueError) as exc:  # nothing has changed yet
            raise Refused("This file is not valid XFDF.") from exc  # the cause keeps the detail
    if not command.commands:
        return ActionResult(command.label, 0, False)
    session.execute(command)
    return ActionResult(command.label, len(command.commands), True)
