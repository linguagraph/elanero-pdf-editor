"""The change events of a reply (W1.2 section 7), and the ``changed`` and ``state`` DTOs they carry.

The registry arms one :class:`CallRecorder` per open document while a call runs; the dispatch
reads what it recorded and what the document's state was before the call, and builds the reply's
``events`` list here. A call that changed content gives ``changed`` (the same object as the
result's ``changed`` field); ``state`` is sent when the document state differs from before the
call. The functions that read a session expect the caller to hold the session lock.
"""

from __future__ import annotations

from typing import Any

from pdfeditor.core.commands.base import Change, ChangeKind
from pdfeditor.core.session import DocumentSession, EventKind, SessionEvent
from pdfeditor.webapi import dto
from pdfeditor.webapi.dto import to_json


class CallRecorder:
    """A session listener that keeps what the session emitted while a call is armed.

    Outside a call (not armed) it records nothing, so a later call starts from an empty record.
    """

    def __init__(self, session: DocumentSession) -> None:
        self._session = session
        self._armed = False
        self.changes: list[Change] = []
        # The busy label of the first refused edit of the call, or None when none was refused.
        self.blocked_task: str | None = None

    def arm(self) -> None:
        self.changes = []
        self.blocked_task = None
        self._armed = True

    def disarm(self) -> None:
        self._armed = False

    def __call__(self, event: SessionEvent) -> None:
        if not self._armed:
            return
        if event.kind is EventKind.CHANGED:
            self.changes.extend(event.changes)
        elif event.kind is EventKind.BLOCKED and self.blocked_task is None:
            self.blocked_task = self._session.busy


def changed_of(session: DocumentSession, changes: list[Change]) -> dto.ChangedDto | None:
    """The ``changed`` event of a call: the change list and the new revision of each page.
    A page index the document no longer has is skipped."""
    if not changes:
        return None
    count = session.document.page_count
    touched: set[int] = set()
    for change in changes:
        if change.pages:
            touched.update(change.pages)
        elif change.kind is ChangeKind.STRUCTURE:
            # A snapshot restore reloads the whole document, and a structure change names no
            # pages, so every page may have a new revision.
            touched.update(range(count))
    revisions: dict[str, int] = {}
    for index in sorted(touched):
        if 0 <= index < count:
            revisions[str(index)] = session.document.page(index).revision
    return dto.ChangedDto(
        changes=tuple(
            dto.ChangeDto(kind=change.kind.value, pages=tuple(sorted(change.pages)))
            for change in changes
        ),
        revisions=revisions,
    )


def state_of(session: DocumentSession) -> dto.DocStateDto:
    """The document state (W1.2 section 7)."""
    stack = session.undo_stack
    return dto.DocStateDto(
        page_count=session.document.page_count,
        structure_version=session.structure_version,
        dirty=session.is_dirty,
        busy=session.busy,
        can_undo=stack.can_undo,
        can_redo=stack.can_redo,
        undo_label=stack.undo_label,
        redo_label=stack.redo_label,
        require_full_save=session.require_full_save,
        history=stack.version,
    )


def call_events(
    handle: str,
    session: DocumentSession,
    recorder: CallRecorder,
    before: dto.DocStateDto,
    result: object | None,
    out: list[bytes],
) -> list[dict[str, Any]]:
    """The events of one call on ``handle``, in the order they happened (W1.2 section 7).

    ``result`` is the handler's result, or None for a failed call. Order: ``changed``, ``blocked``,
    ``saved``, then ``state`` last, so a listener sees the final state. ``state`` is sent once,
    and only when the document state after the call differs from ``before``. Bytes in an event
    are appended to ``out``.
    """
    events: list[dict[str, Any]] = []
    changed = changed_of(session, recorder.changes)
    if changed is not None:
        payload = dto.ChangedEvent(handle, changed.changes, changed.revisions)
        events.append(event("changed", payload, out))
    if recorder.blocked_task is not None:
        events.append(event("blocked", dto.BlockedEvent(handle, recorder.blocked_task), out))
    if isinstance(result, dto.MarkSavedResult) and result.saved:
        events.append(event("saved", dto.SavedEvent(handle), out))
    after = state_of(session)
    if after != before:
        events.append(event("state", dto.StateEvent(handle, after), out))
    return events


def event(kind: str, payload: object, out: list[bytes]) -> dict[str, Any]:
    """One event on the wire: its ``kind`` (the key of ``dto.EVENT_TYPES``) and its fields."""
    if dto.EVENT_TYPES[kind] is not type(payload):
        raise TypeError(f"{kind} is carried by {dto.EVENT_TYPES[kind].__name__}")
    return {"kind": kind, **to_json(payload, out)}  # type: ignore[dict-item]
