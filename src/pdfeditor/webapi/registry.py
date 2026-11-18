"""Open documents of this worker, by opaque handle (W1.2 section 11, decision 1 of W1.1).

A handle is random, so it can't be guessed from another one. The open password is kept with the
entry only while the document is open: ``close`` drops it, and no reply, log or error carries it.
"""

from __future__ import annotations

import secrets

from pdfeditor.core.session import DocumentSession
from pdfeditor.webapi.errors import NO_DOCUMENT, RpcFailure


class _Entry:
    __slots__ = ("password", "session")

    def __init__(self, session: DocumentSession, password: str | None) -> None:
        self.session = session
        self.password = password


class DocumentRegistry:
    def __init__(self) -> None:
        self._entries: dict[str, _Entry] = {}

    def __contains__(self, handle: object) -> bool:
        return handle in self._entries

    def open(self, session: DocumentSession, password: str | None) -> str:
        handle = secrets.token_hex(16)
        while handle in self._entries:  # a collision is practically impossible; never reuse one
            handle = secrets.token_hex(16)
        self._entries[handle] = _Entry(session, password)
        return handle

    def get(self, handle: str) -> DocumentSession:
        entry = self._entries.get(handle)
        if entry is None or entry.session.closed:
            raise RpcFailure(NO_DOCUMENT, "no open document has this handle")
        return entry.session

    def close(self, handle: str) -> None:
        """Forget the handle and its password first, then close the document."""
        entry = self._entries.pop(handle, None)
        if entry is None:
            raise RpcFailure(NO_DOCUMENT, "no open document has this handle")
        entry.password = None
        entry.session.close()

    def passwords_kept(self) -> int:
        """How many open documents hold a password (for tests and the memory report)."""
        return sum(1 for entry in self._entries.values() if entry.password is not None)


REGISTRY = DocumentRegistry()
