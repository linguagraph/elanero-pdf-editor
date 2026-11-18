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

from pdfeditor.webapi import dto, limits
from pdfeditor.webapi.errors import BUSY, FILE_TOO_LARGE, RpcFailure
from pdfeditor.webapi.registry import REGISTRY


def save_bytes(params: dto.SaveParams) -> dto.SaveResult:
    session = REGISTRY.get(params.handle)
    busy = session.busy
    if busy:
        # The core refuses a save during a task too, but as SaveError; BUSY tells the front end
        # to wait for the task instead of reporting a failed save (W1.2 section 4).
        raise RpcFailure(BUSY, "a task is working on the document", {"task": busy})
    password = REGISTRY.password(params.handle)
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
    return dto.SaveResult(
        data=saved.data,
        size=size,
        incremental=saved.incremental,
        verified=True,
        name=session.display_name,
    )
