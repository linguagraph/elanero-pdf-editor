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

from pdfeditor import actions as layer
from pdfeditor.core.commands.base import Change, ChangeKind
from pdfeditor.core.session import DocumentSession, EventKind, SessionEvent
from pdfeditor.webapi import dto
from pdfeditor.webapi.dto import BufferTable, from_json
from pdfeditor.webapi.errors import BUSY, INVALID_ARGS, RpcFailure
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
            changed = _changed(session, events.changes)
            state = _state(session)
    finally:
        unsubscribe()
    return dto.RunResult(
        label=outcome.label,
        executed=outcome.executed,
        value=outcome.value,
        changed=changed,
        state=state,
    )


def undo(params: dto.HandleParams) -> dto.HistoryResult:
    return _history(params.handle, forward=False)


def redo(params: dto.HandleParams) -> dto.HistoryResult:
    return _history(params.handle, forward=True)


def available(params: dto.HandleParams) -> dto.AvailableResult:
    session = REGISTRY.get(params.handle)
    with session.lock:
        names = layer.available(session)
    return dto.AvailableResult(names=tuple(names))


def _history(handle: str, *, forward: bool) -> dto.HistoryResult:
    session = REGISTRY.get(handle)
    events = _Events()
    unsubscribe = session.subscribe(events)
    try:
        with session.lock:
            stack = session.undo_stack
            label = stack.redo_label if forward else stack.undo_label
            done = session.redo() if forward else session.undo()
            if events.blocked:
                # A task is running: the session refused and emitted BLOCKED (W1.2 section 4).
                raise RpcFailure(BUSY, "a task is working on the document", {"task": session.busy})
            changed = _changed(session, events.changes)
            state = _state(session)
    finally:
        unsubscribe()
    # An empty stack is not an error: done is False and the label is empty.
    return dto.HistoryResult(done=done, label=label if done else "", changed=changed, state=state)


def _changed(session: DocumentSession, changes: list[Change]) -> dto.ChangedDto | None:
    """The ``changed`` event of a call: the change list and the new revision of each page.
    The caller holds the session lock. A page index the document no longer has is skipped."""
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


def _state(session: DocumentSession) -> dto.DocStateDto:
    """The document state (W1.2 section 7). The caller holds the session lock."""
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
