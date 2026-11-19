"""The save call of W3.6 (W1.2 section 12, ``save.save_bytes``): the document as bytes, verified.

The decision (full or incremental) and the reopen check are the core's :meth:`DocumentSession.
save_bytes`, the same path the desktop's save uses, so the web writes the same files. This module
only maps the mode, refuses a busy document and an over-limit output, and returns the bytes as a
``$bin`` buffer. No engine object leaves it.

On the web a document has no file on disk, so ``in_place`` means "the copy that replaces the
original": a signed document gets an incremental update that keeps its signatures, and an
unsigned one a full rewrite (W1.1 section 4). ``copy`` is always a full rewrite.
"""

from __future__ import annotations

from pdfeditor.model.metadata import EncryptionMethod
from pdfeditor.webapi import dto, limits
from pdfeditor.webapi.errors import BUSY, FILE_TOO_LARGE, STALE_OBJECT, RpcFailure
from pdfeditor.webapi.events import state_of
from pdfeditor.webapi.jobs import DECRYPTED_COPY_OPTIONS, document_fingerprint
from pdfeditor.webapi.registry import REGISTRY


def autosave_bytes(params: dto.HandleParams) -> dto.AutosaveResult:
    """A snapshot of the document for the browser's private autosave copy (W3.9, S1).

    The copy is written without encryption, so a password-protected or encrypted document is
    never returned: it is skipped as "protected" (W3.9 decision D2). A document above
    ``limits.FILE_WARN_BYTES`` is skipped as "too_large" (decision D5), since the copy and the
    wasm heap it needs would be large. The bytes are read under the lock and nothing else changes:
    no dirty flag, undo step, saved fingerprint or event, so an autosave is invisible to the user.
    Like the snapshots, the bytes are not verified.
    """
    session = REGISTRY.get(params.handle)
    busy = session.busy
    if busy:
        # The writer retries on its next idle turn (W1.2 section 12), so a busy document is not
        # an error the user sees.
        raise RpcFailure(BUSY, "a task is working on the document", {"task": busy})
    password = REGISTRY.password(params.handle)
    with session.lock:
        encrypted = session.document.info().encryption is not EncryptionMethod.NONE
        if password is not None or encrypted:
            return dto.AutosaveResult(data=b"", size=0, skipped="protected")
        data = session.document.to_bytes(DECRYPTED_COPY_OPTIONS)
    size = len(data)
    if size > limits.MAX_SAVE_BYTES:
        raise RpcFailure(
            FILE_TOO_LARGE,
            "the document is too large to autosave",
            {"max_bytes": limits.MAX_SAVE_BYTES, "size": size},
        )
    if size > limits.FILE_WARN_BYTES:
        return dto.AutosaveResult(data=b"", size=0, skipped="too_large")
    return dto.AutosaveResult(data=data, size=size, skipped=None)


def save_bytes(params: dto.SaveParams) -> dto.SaveResult:
    session = REGISTRY.get(params.handle)
    busy = session.busy
    if busy:
        # The core refuses a save during a task too, but as SaveError; BUSY tells the front end
        # to wait for the task instead of reporting a failed save (W1.2 section 4).
        raise RpcFailure(BUSY, "a task is working on the document", {"task": busy})
    password = REGISTRY.password(params.handle)
    with session.lock:
        # The state the bytes are written from. Calls on one worker run one at a time, so the
        # document is still this state when the save returns.
        written = document_fingerprint(session)
    # The core makes the decision and reopens the bytes; a SaveError from it becomes SAVE_FAILED
    # and no bytes are returned. A document that is not verified is never sent.
    saved = session.save_bytes(params.mode.value, password=password)
    size = len(saved.data)
    if size > limits.MAX_SAVE_BYTES:
        # The core has already written the bytes; only what is returned is limited here.
        raise RpcFailure(
            FILE_TOO_LARGE,
            "the saved file is too large for the browser",
            {"max_bytes": limits.MAX_SAVE_BYTES, "size": size},
        )
    REGISTRY.note_saved(params.handle, written)
    return dto.SaveResult(
        data=saved.data,
        size=size,
        incremental=saved.incremental,
        verified=True,
        name=session.display_name,
    )


def mark_saved(params: dto.HandleParams) -> dto.MarkSavedResult:
    """Clear the dirty flag once the front end has written the bytes of the last save_bytes.

    The rule (W1.2 section 4): the flag is cleared only while the document is in the state that
    save_bytes wrote. An edit, undo or redo since then makes the call fail with STALE_OBJECT and
    leaves the document dirty, so the user is not told a newer state was written. A clean
    document is a no-op success. The state is compared by the job fingerprint, the same check
    that jobs.apply makes.
    """
    session = REGISTRY.get(params.handle)
    with session.lock:
        if not session.is_dirty:
            return dto.MarkSavedResult(saved=False, state=state_of(session))
        written = REGISTRY.saved_fingerprint(params.handle)
        if written is None or document_fingerprint(session) != written:
            raise RpcFailure(
                STALE_OBJECT,
                "the document changed since it was saved",
                {"reason": "document changed"},
            )
        session.undo_stack.set_clean()
        return dto.MarkSavedResult(saved=True, state=state_of(session))
