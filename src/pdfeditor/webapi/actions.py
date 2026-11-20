"""The actions calls of W3.5 (W1.2 section 12, group ``actions``): run a named action, undo,
redo and list the actions that are available here.

The calls only look the action up by name, convert its arguments with the action's own
dataclass, and report what changed. The work itself is the actions layer's (W1.3), so the web and
the desktop run the same Commands with the same labels. Every reply that changes the document
carries ``changed`` (the pages whose revision moved, W1.2 section 7) and ``state`` (dirty flag,
undo and redo labels, structure version). The engine work runs under the session lock, and no
engine object leaves this module.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from datetime import datetime

from pdfeditor import actions as layer
from pdfeditor.core.commands.base import Change
from pdfeditor.core.session import EventKind, SessionEvent
from pdfeditor.model.annotations import AnnotationModel
from pdfeditor.model.color import Color
from pdfeditor.model.pages import MarkKind
from pdfeditor.services import stamping
from pdfeditor.services.comments import comment_threads
from pdfeditor.services.comments import flattenable as flattenable_comments
from pdfeditor.services.redaction import redaction_marks
from pdfeditor.services.xfdf import XfdfTooLarge, preview_xfdf
from pdfeditor.webapi import dto
from pdfeditor.webapi.dto import BufferTable, from_json
from pdfeditor.webapi.errors import (
    BUSY,
    FILE_TOO_LARGE,
    INVALID_ARGS,
    REFUSED,
    STALE_OBJECT,
    RpcFailure,
)
from pdfeditor.webapi.events import changed_of, state_of
from pdfeditor.webapi.registry import REGISTRY


class _Events:
    """What one call's session emitted while the call ran."""

    def __init__(self) -> None:
        self.changes: list[Change] = []
        self.blocked = False

    def __call__(self, event: SessionEvent) -> None:
        if event.kind is EventKind.CHANGED:
            self.changes.extend(event.changes)
        elif event.kind is EventKind.BLOCKED:
            self.blocked = True


def run_action(params: dto.RunParams, buffers: BufferTable) -> dto.RunResult:
    session = REGISTRY.get(params.handle)
    if params.name not in layer.REGISTRY:
        raise RpcFailure(INVALID_ARGS, "params.name: no such action", {"path": "params.name"})
    # The arguments name binary values by buffer, so they are converted with the call's table.
    args = from_json(layer.REGISTRY[params.name].args, params.args, buffers, "args")
    events = _Events()
    unsubscribe = session.subscribe(events)
    try:
        with session.lock:
            outcome = layer.run(session, params.name, args)
            changed = changed_of(session, events.changes)
            state = state_of(session)
    finally:
        unsubscribe()
    return dto.RunResult(
        label=outcome.label,
        executed=outcome.executed,
        value=outcome.value,
        changed=changed,
        state=state,
    )


def flattenable(params: dto.HandleParams) -> dto.FlattenableResult:
    """How many comments Flatten All would burn in, read-only: the web asks before it runs the
    job, so a document with no comments gets a message and no undo step."""
    session = REGISTRY.get(params.handle)
    with session.lock:
        count, pages = flattenable_comments(session.document)
    return dto.FlattenableResult(count=count, pages=pages)


def xfdf_preview(params: dto.XfdfPreviewParams) -> dto.XfdfPreviewResult:
    """What importing this XFDF text would add, read-only: the web asks before the import so the
    user sees the count. The same parser as ``annotations.import_xfdf``, so the counts match it.

    The size bound is the service's (``MAX_XFDF_BYTES``), so an over-size text is refused here
    with ``FILE_TOO_LARGE`` before any parsing. Any other text that is not XFDF is ``REFUSED``.
    """
    session = REGISTRY.get(params.handle)
    with session.lock:
        try:
            found = preview_xfdf(params.text, session.document)
        except XfdfTooLarge as exc:
            raise RpcFailure(FILE_TOO_LARGE, "the XFDF file is too large") from exc
        except (ET.ParseError, ValueError) as exc:
            raise RpcFailure(REFUSED, "This file is not valid XFDF.") from exc
    return dto.XfdfPreviewResult(comments=found.comments, replies=found.replies, pages=found.pages)


def list_marks(params: dto.HandleParams) -> dto.MarksResult:
    """The page marks in the document (header and footer, Bates, watermark, background), read-only:
    the web's marks dialogs read it to offer Replace and Remove. Empty without ``page_marks``."""
    session = REGISTRY.get(params.handle)
    with session.lock:
        found = stamping.find_marks(session.engine, session.document)
    items = tuple(
        dto.MarkSummaryDto(kind=kind, pages=len(found[kind].pages), foreign=found[kind].foreign)
        for kind in MarkKind
        if kind in found
    )
    return dto.MarksResult(items=items)


# The most marks one list reply holds (W7.4b section 4.1): a redaction mark is about 200 bytes of
# JSON, so this keeps the reply well under the limits; ``truncated`` says when marks were left out.
MAX_REDACTION_MARKS = 5000


def _color_dto(color: Color | None) -> dto.ColorDto | None:
    return None if color is None else dto.ColorDto(color.r, color.g, color.b, color.a)


def _redaction_dto(mark: AnnotationModel) -> dto.RedactionMarkDto:
    rect = mark.rect
    return dto.RedactionMarkDto(
        page=mark.page_index,
        name=mark.name,
        rect=dto.RectDto(rect.x0, rect.y0, rect.x1, rect.y1),
        fill=_color_dto(mark.fill),
        overlay_text=mark.overlay_text,
        text_color=_color_dto(mark.text_color),
        contents=mark.contents,
        author=mark.author,
        locked=mark.locked,
    )


def list_redactions(params: dto.HandleParams) -> dto.RedactionListResult:
    """The redaction marks in the document, read-only: the web's Redactions panel and bar read
    the document's marks, not the ones this tab drew, so an undo or a mark from the file shows.
    Empty without ``annotations_read``, as ``marks.list`` is without ``page_marks``."""
    session = REGISTRY.get(params.handle)
    with session.lock:
        if not session.engine.capabilities.annotations_read:
            return dto.RedactionListResult(marks=(), truncated=False)
        found = redaction_marks(session.document)
    truncated = len(found) > MAX_REDACTION_MARKS
    marks = tuple(_redaction_dto(m) for m in found[:MAX_REDACTION_MARKS])
    return dto.RedactionListResult(marks=marks, truncated=truncated)


# The most comment entries (a thread's root and its replies) one list reply holds (W7.1b
# section 3): a comment is about 300 bytes of JSON, so this keeps the reply near 1.5 MB. Whole
# threads only, so a thread past the cap is left out with every reply and ``truncated`` is set.
MAX_COMMENT_ENTRIES = 5000


def _iso(value: datetime | None) -> str | None:
    return None if value is None else value.isoformat()


def _comment_dto(a: AnnotationModel) -> dto.CommentDto:
    rect = a.rect
    return dto.CommentDto(
        page=a.page_index,
        name=a.name,
        type=a.type,
        author=a.author,
        contents=a.contents,
        subject=a.subject,
        created=_iso(a.created),
        modified=_iso(a.modified),
        state=a.state,
        locked=a.locked,
        rect=dto.RectDto(rect.x0, rect.y0, rect.x1, rect.y1),
    )


def list_comments(params: dto.HandleParams) -> dto.CommentListResult:
    """The comment threads of the document, read-only: the web's Comments panel. The order and the
    replies are the desktop panel's (``comment_threads``). Empty without ``annotations_read``."""
    session = REGISTRY.get(params.handle)
    with session.lock:
        if not session.engine.capabilities.annotations_read:
            return dto.CommentListResult(threads=(), truncated=False)
        threads = comment_threads(session.document)
    kept: list[dto.CommentThreadDto] = []
    used = 0
    for thread in threads:
        size = 1 + len(thread.replies)
        if used + size > MAX_COMMENT_ENTRIES:
            break
        used += size
        kept.append(
            dto.CommentThreadDto(
                comment=_comment_dto(thread.comment),
                replies=tuple(_comment_dto(r) for r in thread.replies),
                status=thread.status,
            )
        )
    return dto.CommentListResult(threads=tuple(kept), truncated=len(kept) < len(threads))


def undo(params: dto.UndoParams) -> dto.HistoryResult:
    return _history(params.handle, forward=False, expect=params.expect_history)


def redo(params: dto.HandleParams) -> dto.HistoryResult:
    return _history(params.handle, forward=True)


def available(params: dto.HandleParams) -> dto.AvailableResult:
    session = REGISTRY.get(params.handle)
    with session.lock:
        names = layer.available(session)
    return dto.AvailableResult(names=tuple(names))


def _history(handle: str, *, forward: bool, expect: int | None = None) -> dto.HistoryResult:
    session = REGISTRY.get(handle)
    events = _Events()
    unsubscribe = session.subscribe(events)
    try:
        with session.lock:
            stack = session.undo_stack
            # An Undo offer names the history it was made at (W4.4b): if the history moved, or
            # there is nothing left to undo, the offered step is no longer the newest one, so it
            # is refused before anything changes. BUSY is checked after this, by session.undo.
            if expect is not None and (stack.version != expect or not stack.can_undo):
                raise RpcFailure(
                    STALE_OBJECT,
                    "the document changed since this undo was offered",
                    {"history": stack.version},
                )
            label = stack.redo_label if forward else stack.undo_label
            done = session.redo() if forward else session.undo()
            if events.blocked:
                # A task is running: the session refused and emitted BLOCKED (W1.2 section 4).
                raise RpcFailure(BUSY, "a task is working on the document", {"task": session.busy})
            changed = changed_of(session, events.changes)
            state = state_of(session)
    finally:
        unsubscribe()
    # An empty stack is not an error: done is False and the label is empty.
    return dto.HistoryResult(done=done, label=label if done else "", changed=changed, state=state)
