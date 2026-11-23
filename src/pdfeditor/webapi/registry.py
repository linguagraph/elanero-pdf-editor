"""Open documents of this worker, by opaque handle (W1.2 section 11, decision 1 of W1.1).

A handle is random, so it can't be guessed from another one. The open password is kept with the
entry only while the document is open: ``close`` drops it, and no reply, log or error carries it.
Each entry also holds the call recorder of its document (W1.2 section 7): subscribed once when the
document opens, and armed only while a call on it runs.
"""

from __future__ import annotations

import secrets
from collections.abc import Iterator
from contextlib import contextmanager

from pdfeditor.core.session import DocumentSession
from pdfeditor.webapi.errors import NO_DOCUMENT, RpcFailure
from pdfeditor.webapi.events import CallRecorder


class _Entry:
    __slots__ = (
        "held_size",
        "password",
        "pending_size",
        "recorder",
        "saved",
        "session",
        "unsubscribe",
    )

    def __init__(self, session: DocumentSession, password: str | None) -> None:
        self.session = session
        self.password = password
        # The document state the last save_bytes wrote (see jobs.document_fingerprint); None until
        # the document is saved through the web. save.mark_saved compares against it.
        self.saved: tuple[object, ...] | None = None
        # The size of the file the user holds: the bytes opened, or the last bytes saved. A reduce
        # compares with it while the document is clean (jobs.prepare sends it as the baseline).
        self.held_size: int | None = None
        # The size of the bytes the last save_bytes returned. It becomes held_size only when the
        # browser has written them (mark_saved); a failed write leaves the older file held.
        self.pending_size: int | None = None
        self.recorder = CallRecorder(session)
        self.unsubscribe = session.subscribe(self.recorder)


class DocumentRegistry:
    def __init__(self) -> None:
        self._entries: dict[str, _Entry] = {}

    def __contains__(self, handle: object) -> bool:
        return handle in self._entries

    def __len__(self) -> int:
        return len(self._entries)

    def open(self, session: DocumentSession, password: str | None) -> str:
        handle = secrets.token_hex(16)
        while handle in self._entries:  # a collision is practically impossible; never reuse one
            handle = secrets.token_hex(16)
        self._entries[handle] = _Entry(session, password)
        return handle

    def find(self, handle: object) -> DocumentSession | None:
        """The open session of a handle, or None when there is none (no error)."""
        entry = self._entries.get(handle) if isinstance(handle, str) else None
        if entry is None or entry.session.closed:
            return None
        return entry.session

    def get(self, handle: str) -> DocumentSession:
        session = self.find(handle)
        if session is None:
            raise RpcFailure(NO_DOCUMENT, "no open document has this handle")
        return session

    @contextmanager
    def recording(self, handle: str) -> Iterator[CallRecorder | None]:
        """Arm the recorder of an open document for the duration of a call. Yields None for an
        unknown or closed handle, which has nothing to record."""
        session = self.find(handle)
        if session is None:
            yield None
            return
        recorder = self._entries[handle].recorder
        recorder.arm()
        try:
            yield recorder
        finally:
            recorder.disarm()

    def password(self, handle: str) -> str | None:
        """The open password of a document, for the engine to reopen what it saves. The caller
        must not put it in a reply, a log or an error."""
        entry = self._entries.get(handle)
        if entry is None or entry.session.closed:
            raise RpcFailure(NO_DOCUMENT, "no open document has this handle")
        return entry.password

    def note_saved(self, handle: str, fingerprint: tuple[object, ...]) -> None:
        """Record the state that a save wrote, so that a later mark_saved can tell whether the
        document has changed since."""
        entry = self._entries.get(handle)
        if entry is not None:
            entry.saved = fingerprint

    def saved_fingerprint(self, handle: str) -> tuple[object, ...] | None:
        entry = self._entries.get(handle)
        return None if entry is None else entry.saved

    def set_held_size(self, handle: str, size: int) -> None:
        entry = self._entries.get(handle)
        if entry is not None:
            entry.held_size = size

    def set_pending_size(self, handle: str, size: int) -> None:
        entry = self._entries.get(handle)
        if entry is not None:
            entry.pending_size = size

    def promote_pending_size(self, handle: str) -> None:
        """The browser wrote the last saved bytes: they are now the file the user holds."""
        entry = self._entries.get(handle)
        if entry is not None and entry.pending_size is not None:
            entry.held_size = entry.pending_size
            entry.pending_size = None

    def held_size(self, handle: str) -> int | None:
        entry = self._entries.get(handle)
        return None if entry is None else entry.held_size

    def close(self, handle: str) -> None:
        """Forget the handle and its password first, then close the document. The recorder is
        unsubscribed before the close, so a closed document keeps no listener."""
        entry = self._entries.pop(handle, None)
        if entry is None:
            raise RpcFailure(NO_DOCUMENT, "no open document has this handle")
        entry.password = None
        entry.unsubscribe()
        entry.session.close()

    def close_all(self) -> None:
        for handle in list(self._entries):
            self.close(handle)

    def sessions(self) -> list[DocumentSession]:
        """The open documents (for the memory report); a closed one is skipped."""
        return [entry.session for entry in self._entries.values() if not entry.session.closed]

    def passwords_kept(self) -> int:
        """How many open documents hold a password (for tests and the memory report)."""
        return sum(1 for entry in self._entries.values() if entry.password is not None)


REGISTRY = DocumentRegistry()
