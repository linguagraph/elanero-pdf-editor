"""DocumentSession: one open document plus its lock, undo history and save policy."""

from __future__ import annotations

import itertools
import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Literal

from pdfeditor.core.commands.base import DESKTOP_SNAPSHOT_BUDGET, Change, Command, UndoStack
from pdfeditor.core.commands.snapshot import SnapshotStore
from pdfeditor.core.engine_lock import ENGINE_LOCK
from pdfeditor.engine.base import Document, Engine, PasswordCallback, SaveError, SaveOptions
from pdfeditor.engine.registry import DEFAULT_ENGINE, get_engine
from pdfeditor.model.metadata import EncryptionMethod

log = logging.getLogger(__name__)
_ids = itertools.count(1)


def _file_stamp(path: Path | None) -> tuple[int, int] | None:
    """Size and modification time, to notice another program changing a file."""
    if path is None:
        return None
    try:
        stat = path.stat()
    except OSError:
        return None
    return stat.st_size, stat.st_mtime_ns


class EventKind(Enum):
    CHANGED = "changed"  # document content changed (see ``changes``)
    SAVED = "saved"
    DIRTY = "dirty"  # dirty flag or undo/redo availability changed
    CLOSED = "closed"
    BLOCKED = "blocked"  # an edit, undo or redo was refused while a task works on the document


@dataclass(frozen=True, slots=True)
class SaveBytes:
    """A saved document as bytes, and whether it was written as an incremental update."""

    data: bytes
    incremental: bool


@dataclass(frozen=True, slots=True)
class SessionEvent:
    kind: EventKind
    changes: tuple[Change, ...] = field(default_factory=tuple)


Listener = Callable[[SessionEvent], None]


class DocumentSession:
    """Owns a :class:`Document` and the lock that serializes all engine access to it.

    MuPDF isn't thread-safe: code touching ``document`` (render workers, background jobs, and the
    GUI thread) must hold ``lock``, which is the process-wide ``ENGINE_LOCK``. Every mutation
    goes through :meth:`execute` so it's undoable and listeners (views, panels) learn what
    changed.
    """

    def __init__(
        self,
        document: Document,
        engine: Engine,
        *,
        snapshot_budget: int = DESKTOP_SNAPSHOT_BUDGET,
    ) -> None:
        self.id = next(_ids)
        self.uid = uuid.uuid4().hex  # stable name for recovery files
        self.document = document
        self.engine = engine
        # One lock for the whole process, not per document: see core/engine_lock.py.
        self.lock = ENGINE_LOCK
        self.closed = False
        # Undo snapshots over this many bytes drop the oldest commands (see UndoStack).
        self.undo_stack = UndoStack(max_disk_bytes=snapshot_budget)
        self.undo_stack.on_change(lambda: self._emit(SessionEvent(EventKind.DIRTY)))
        self.save_path_hint: Path | None = None  # e.g. original path of a recovered document
        self.name_hint = ""  # shown for unsaved new documents, e.g. "Combined.pdf"
        # Set after redaction/sanitizing: an incremental save would keep the removed content
        # in earlier revisions of the file, so the next save must be a full rewrite.
        self.require_full_save = False
        self._snapshots: SnapshotStore | None = None
        self._listeners: list[Listener] = []
        self._tasks: list[str] = []  # background tasks reading the document (see begin_task)
        self._file_stamp = _file_stamp(document.path)

    @classmethod
    def open(
        cls,
        source: Path | bytes,
        password: str | PasswordCallback | None = None,
        engine_name: str = DEFAULT_ENGINE,
        *,
        snapshot_budget: int = DESKTOP_SNAPSHOT_BUDGET,
    ) -> DocumentSession:
        engine = get_engine(engine_name)
        doc = engine.open(source, password)
        log.info("opened %s (%d pages)", doc.path or "<memory>", doc.page_count)
        return cls(doc, engine, snapshot_budget=snapshot_budget)

    # -- properties -----------------------------------------------------------------------
    @property
    def path(self) -> Path | None:
        return self.document.path

    @property
    def display_name(self) -> str:
        path = self.path or self.save_path_hint
        if path is not None:
            return path.name
        return self.name_hint or f"Untitled-{self.id}"

    @property
    def page_count(self) -> int:
        return self.document.page_count

    @property
    def is_dirty(self) -> bool:
        return not self.undo_stack.is_clean

    @property
    def snapshots(self) -> SnapshotStore:
        """Temp storage for this session's undo snapshots (created on first use)."""
        if self._snapshots is None:
            self._snapshots = SnapshotStore()
        return self._snapshots

    def file_changed_on_disk(self) -> bool:
        """Has the file changed since it was opened or saved here? Then what's on screen isn't
        what a signature over the file would cover."""
        return self.path is not None and _file_stamp(self.path) != self._file_stamp

    # -- events ---------------------------------------------------------------------------
    def subscribe(self, listener: Listener) -> Callable[[], None]:
        """Register a listener; returns a function that unsubscribes it."""
        self._listeners.append(listener)

        def unsubscribe() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return unsubscribe

    def _emit(self, event: SessionEvent) -> None:
        for listener in list(self._listeners):
            listener(event)

    # -- background tasks -----------------------------------------------------------------
    @property
    def busy(self) -> str:
        """Label of the background task working on this document, or "" when there is none.

        A task (OCR, export, optimize...) reads the document between steps while the user
        keeps working elsewhere, and some apply their result to it when done. Edits made in
        between would change the pages under the task's feet, so the document is read-only
        until every task has ended: :meth:`execute`, :meth:`undo` and :meth:`redo` refuse with
        a ``BLOCKED`` event and :meth:`save` raises.
        """
        return self._tasks[-1] if self._tasks else ""

    def begin_task(self, label: str) -> None:
        self._tasks.append(label)
        self._emit(SessionEvent(EventKind.DIRTY))  # listeners refresh undo/redo availability

    def end_task(self, label: str) -> None:
        if label in self._tasks:
            self._tasks.remove(label)
        self._emit(SessionEvent(EventKind.DIRTY))

    def _refuse_while_busy(self) -> bool:
        if not self._tasks:
            return False
        log.info("refused an edit of %s while %r runs", self.display_name, self.busy)
        self._emit(SessionEvent(EventKind.BLOCKED))
        return True

    def refuse_while_busy(self) -> bool:
        """True (and a BLOCKED event) when a background task makes the document read-only."""
        return self._refuse_while_busy()

    # -- editing --------------------------------------------------------------------------
    def execute(self, command: Command) -> bool:
        """Do ``command`` and push it on the undo stack. Returns False when it was refused
        because a background task is running (a BLOCKED event is emitted), True otherwise.

        True includes a command that merged into the previous undo step, so the caller can't
        tell a merge from a new step by the return value, and doesn't need to.
        """
        if self._refuse_while_busy():
            return False
        with self.lock:
            self.undo_stack.push(command, self.document)
        self._emit(SessionEvent(EventKind.CHANGED, tuple(command.changes())))
        return True

    def undo(self) -> bool:
        if self._refuse_while_busy():
            return False
        with self.lock:
            command = self.undo_stack.undo(self.document)
        if command is None:
            return False
        self._emit(SessionEvent(EventKind.CHANGED, tuple(command.changes())))
        return True

    def redo(self) -> bool:
        if self._refuse_while_busy():
            return False
        with self.lock:
            command = self.undo_stack.redo(self.document)
        if command is None:
            return False
        self._emit(SessionEvent(EventKind.CHANGED, tuple(command.changes())))
        return True

    # -- saving ---------------------------------------------------------------------------
    def save_target(self) -> Path | None:
        return self.path or self.save_path_hint

    def save(self, path: Path | None = None) -> Path:
        """Save to ``path`` (save-as) or to the current file.

        Signed documents saved in place use an incremental update, so existing signatures stay
        valid. Everything else gets a full, garbage-collected rewrite.
        """
        target = path or self.save_target()
        if target is None:
            raise SaveError("document has no file name; use Save As")
        if self._tasks:
            raise SaveError(f"wait until “{self.busy}” has finished, or cancel it, then save")
        target = target.resolve()
        with self.lock:
            doc = self.document
            in_place = doc.path is not None and target == doc.path
            incremental = self._wants_incremental(in_place) and doc.can_save_incrementally()
            options = SaveOptions(incremental=incremental, garbage=self._garbage_level())
            saved = doc.save(target, options)
        self.require_full_save = False
        self._file_stamp = _file_stamp(saved)
        self.save_path_hint = None
        self.undo_stack.set_clean()
        log.info("saved %s%s", saved, " (incremental)" if incremental else "")
        self._emit(SessionEvent(EventKind.SAVED))
        return saved

    def _wants_incremental(self, in_place: bool) -> bool:
        """The incremental-or-full decision shared by :meth:`save` and :meth:`save_bytes`:
        a signed document saved over its own file keeps its signatures by an update."""
        return in_place and not self.require_full_save and self.document.info().has_signatures

    def _garbage_level(self) -> int:
        return 4 if self.require_full_save else 3

    def save_bytes(self, mode: Literal["in_place", "copy"] = "in_place") -> SaveBytes:
        """The document as bytes, for a caller that writes the file itself (the web).

        ``"copy"`` is always a full rewrite, as Save As. ``"in_place"`` makes the same decision
        as :meth:`save` over the document's own file: a signed document gets an incremental
        update that keeps its signatures, and it raises SaveError when that can't be made,
        rather than falling back to a rewrite that would break the signatures. The bytes are
        opened again before they're returned; a failed check raises SaveError.

        This is a read: it clears neither ``require_full_save`` nor the clean state, sets no file
        stamp and emits no SAVED. A caller that has written the bytes to a file decides that.
        """
        if self._tasks:
            raise SaveError(f"wait until “{self.busy}” has finished, or cancel it, then save")
        with self.lock:
            doc = self.document
            if mode == "copy":
                incremental = False
            elif mode == "in_place":
                incremental = self._wants_incremental(in_place=True)
            else:
                raise ValueError(f"unknown save mode {mode!r}")
            if incremental:
                if doc.path is not None and self.file_changed_on_disk():
                    raise SaveError(
                        "the file changed on disk after it was opened; reopen it, or save as a "
                        "new file, before saving in place"
                    )
                data = doc.incremental_bytes(SaveOptions(incremental=True))
                if data is None:
                    raise SaveError(
                        "this signed document can't be saved in place; save as a new file to "
                        "keep the signatures"
                    )
            else:
                options = SaveOptions(incremental=False, garbage=self._garbage_level())
                doc.prepare_full_save(options)  # the same preparation as save()
                data = doc.to_bytes(options)
            self._verify_bytes(data, doc.page_count)
        log.info("saved %d bytes%s", len(data), " (incremental)" if incremental else "")
        return SaveBytes(data=data, incremental=incremental)

    def _verify_bytes(self, data: bytes, pages: int) -> None:
        """Open the bytes again and compare the page count. An encrypted document would need its
        password, which the session doesn't keep, so only the page count is checked for it
        (the engine's own save check still covers it)."""
        if self.document.info().encryption is not EncryptionMethod.NONE:
            return
        try:
            reopened = self.engine.open(data)
        except Exception as exc:
            raise SaveError(f"saved bytes cannot be reopened: {exc}") from exc
        try:
            if reopened.is_repaired:
                raise SaveError("saved bytes needed repair when reopened")
            if reopened.page_count != pages:
                raise SaveError(f"saved bytes have {reopened.page_count} pages, expected {pages}")
        finally:
            reopened.close()

    def close(self) -> None:
        with self.lock:
            if self.closed:
                return
            self.undo_stack.clear()
            self.document.close()
            self.closed = True
            if self._snapshots is not None:
                self._snapshots.cleanup()
        self._emit(SessionEvent(EventKind.CLOSED))
        self._listeners.clear()
