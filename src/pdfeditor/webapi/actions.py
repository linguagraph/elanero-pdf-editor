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

import dataclasses
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import PureWindowsPath

from pdfeditor import actions as layer
from pdfeditor.actions.edit_geometry import annotation_bounds, is_movable, is_resizable
from pdfeditor.core.commands.base import Change
from pdfeditor.core.session import EventKind, SessionEvent
from pdfeditor.model.annotations import FLAG_HIDDEN, AnnotationModel
from pdfeditor.model.color import Color
from pdfeditor.model.fonts import FontRef, FontRefKind
from pdfeditor.model.pages import FONTS, MarkKind
from pdfeditor.services import stamping
from pdfeditor.services.comments import comment_threads, page_threads
from pdfeditor.services.comments import flattenable as flattenable_comments
from pdfeditor.services.pages import format_page_ranges
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
from pdfeditor.webapi.fontrefs import check_font_refs
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
    # A FILE font ref may name only an uploaded face (W6.9 slice 2): the engine reads its path.
    check_font_refs(args, "args")
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


def _rgb(color: Color) -> dto.RgbDto:
    return dto.RgbDto(color.r, color.g, color.b)


def _base14(font: str, font_ref: FontRef | None) -> tuple[str, bool]:
    """The family a stored mark is shown with, and whether an uploaded font was dropped for it.

    The desktop sets ``font`` from the family it used (ui/dialogs/pages.py), so the code is kept
    as it is. The web's jobs cannot draw an uploaded font, so that one is shown as its family."""
    dropped = font_ref is not None and font_ref.kind is FontRefKind.FILE
    return (font if font in FONTS else "helv"), dropped


def _header_dto(spec: stamping.HeaderFooter) -> tuple[dto.HeaderFooterSpecDto, bool]:
    font, dropped = _base14(spec.font, spec.font_ref)
    texts = {slot: spec.texts.get(slot, "") for slot in stamping.Slot}
    return (
        dto.HeaderFooterSpecDto(
            header_left=texts[stamping.Slot.HEADER_LEFT],
            header_center=texts[stamping.Slot.HEADER_CENTER],
            header_right=texts[stamping.Slot.HEADER_RIGHT],
            footer_left=texts[stamping.Slot.FOOTER_LEFT],
            footer_center=texts[stamping.Slot.FOOTER_CENTER],
            footer_right=texts[stamping.Slot.FOOTER_RIGHT],
            font=font,
            font_size=spec.font_size,
            color=_rgb(spec.color),
            margin_x=spec.margin_x,
            margin_top=spec.margin_top,
            margin_bottom=spec.margin_bottom,
            bates_prefix=spec.bates_prefix,
            bates_start=spec.bates_start,
            bates_digits=spec.bates_digits,
            bates_suffix=spec.bates_suffix,
        ),
        dropped,
    )


def _watermark_dto(text: str) -> tuple[dto.WatermarkSpecDto, bool] | None:
    spec = stamping.watermark_from_settings(text)
    if spec is None:
        return None
    font, dropped = _base14(spec.font, spec.font_ref)
    return (
        dto.WatermarkSpecDto(
            text=spec.text,
            image=stamping.is_image_watermark(text),
            # The web has no paths: only the picture's file name is shown.
            image_name=PureWindowsPath(spec.image_path).name if spec.image_path else "",
            font=font,
            font_size=spec.font_size,
            color=_rgb(spec.color),
            opacity=spec.opacity,
            angle=spec.angle,
            scale=spec.scale,
            on_top=spec.on_top,
        ),
        dropped,
    )


def get_mark(params: dto.MarkGetParams) -> dto.MarkDetailResult:
    """One kind of page mark with the settings it was added with, so the web's Update opens with
    them (the desktop reads the same, ui/organize.py). Read-only, under the session lock."""
    session = REGISTRY.get(params.handle)
    with session.lock:
        info = stamping.find_marks(session.engine, session.document, [params.kind]).get(params.kind)
    if info is None:
        return dto.MarkDetailResult(
            found=False,
            pages=(),
            ranges="",
            foreign=False,
            header_footer=None,
            watermark=None,
            background=None,
            font_dropped=False,
        )
    header: dto.HeaderFooterSpecDto | None = None
    watermark: dto.WatermarkSpecDto | None = None
    background: dto.BackgroundSpecDto | None = None
    dropped = False
    # Only other tools' marks (Acrobat's) were found: their settings are not ours, so none is read.
    if info.foreign:
        pass
    elif params.kind in (MarkKind.HEADER_FOOTER, MarkKind.BATES):
        spec = stamping.header_footer_from_settings(info.settings)
        if spec is not None:
            header, dropped = _header_dto(spec)
    elif params.kind is MarkKind.WATERMARK:
        found_wm = _watermark_dto(info.settings)
        if found_wm is not None:
            watermark, dropped = found_wm
    elif params.kind is MarkKind.BACKGROUND:
        read = stamping.background_from_settings(info.settings)
        if read is not None:
            color, opacity = read
            background = dto.BackgroundSpecDto(color=_rgb(color), opacity=opacity)
    return dto.MarkDetailResult(
        found=True,
        pages=tuple(info.pages),
        ranges=format_page_ranges(info.pages),
        foreign=info.foreign,
        header_footer=header,
        watermark=watermark,
        background=background,
        font_dropped=dropped,
    )


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


def _page_comment_dto(a: AnnotationModel) -> dto.PageCommentDto:
    base = _comment_dto(a)
    box = annotation_bounds(a)
    return dto.PageCommentDto(
        **{f.name: getattr(base, f.name) for f in dataclasses.fields(base)},
        bounds=dto.RectDto(box.x0, box.y0, box.x1, box.y1),
        hidden=bool(a.flags & FLAG_HIDDEN),
        movable=is_movable(a),
        resizable=is_resizable(a),
    )


def list_comments_page(params: dto.PageParams) -> dto.CommentPageResult:
    """One page's comment threads, read-only: the web's comment hit testing and Select tool
    (W7.1a section 3.1). Empty without ``annotations_read``, as ``comments.list``."""
    session = REGISTRY.get(params.handle)
    with session.lock:
        count = session.document.page_count
        if not 0 <= params.page < count:
            raise RpcFailure(
                INVALID_ARGS,
                "params.page: the page is out of range",
                {"path": "params.page", "pages": count},
            )
        revision = session.document.page(params.page).revision
        if not session.engine.capabilities.annotations_read:
            return dto.CommentPageResult(revision=revision, threads=())
        threads = page_threads(session.document, params.page)
    return dto.CommentPageResult(
        revision=revision,
        threads=tuple(
            dto.PageThreadDto(
                comment=_page_comment_dto(t.comment),
                replies=tuple(_comment_dto(r) for r in t.replies),
            )
            for t in threads
        ),
    )


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
