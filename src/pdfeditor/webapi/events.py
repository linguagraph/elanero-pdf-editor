"""The change events of a reply (W1.2 section 7), and the ``changed`` and ``state`` DTOs they carry.

A call that changes content returns ``changed`` and ``state`` in its result (the W3.5 action
results), and the dispatch puts the same two objects in the reply's ``events`` list. Both come from
here, so the event data and the result fields cannot drift apart. The functions that build the DTOs
expect the caller to hold the session lock.
"""

from __future__ import annotations

from typing import Any

from pdfeditor.core.commands.base import Change, ChangeKind
from pdfeditor.core.session import DocumentSession
from pdfeditor.webapi import dto
from pdfeditor.webapi.dto import to_json

# Results that carry the ``changed`` and ``state`` of a content change (W3.5 actions, W3.2 jobs).
_CONTENT_RESULTS = (dto.RunResult, dto.HistoryResult, dto.JobApplyResult)


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
    )


def events_for(
    method: str, params: object, result: object, out: list[bytes]
) -> list[dict[str, Any]]:
    """The events of one successful reply (W1.2 section 7), in the order they happened.

    A call that changed content gives a ``changed`` event (its change list and the new revision
    of each page as strings, and ``structure_version`` in ``state``) and then a ``state`` event.
    ``session.close`` gives ``closed``. A job call that changed the busy flag (jobs.prepare of a
    mutating job, jobs.abort that ended one) gives ``state`` alone. A read-only call gives none.
    Failures carry no events: the error envelope is unchanged, and a refused edit is reported by
    its BUSY error.
    Bytes in an event are appended to ``out``, the reply's buffers.
    """
    handle = getattr(params, "handle", None)
    if not isinstance(handle, str):
        return []
    if method == "session.close":
        return [{"kind": "closed", "handle": handle}]
    if isinstance(result, dto.JobPrepareResult | dto.JobAbortResult):
        # A job call gives a state event only when it changed the busy flag (its state is set).
        if result.state is None:
            return []
        return [{"kind": "state", "handle": handle, "state": to_json(result.state, out)}]
    if isinstance(result, dto.MarkSavedResult):
        # Only a call that cleared the flag says so; a clean document gives no event.
        if not result.saved:
            return []
        return [
            {"kind": "saved", "handle": handle},
            {"kind": "state", "handle": handle, "state": to_json(result.state, out)},
        ]
    if not isinstance(result, _CONTENT_RESULTS) or result.changed is None:
        return []
    changed = result.changed
    return [
        {
            "kind": "changed",
            "handle": handle,
            "changes": to_json(changed.changes, out),
            "revisions": to_json(changed.revisions, out),
        },
        {"kind": "state", "handle": handle, "state": to_json(result.state, out)},
    ]
