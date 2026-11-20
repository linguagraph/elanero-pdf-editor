"""The read-only attachment calls of W7.9 S2: ``attachments.list`` and ``attachments.get``.

They mirror the desktop's attachments panel (``Document.embedded_files()`` and
``extract_embedded_file()``) and change nothing: no Command, no dirty flag, no page revision. The
web never opens, previews or runs an attachment (W1.1 threat E); it only returns the bytes so the
front end can save them on request. Names and descriptions come from the file and are untrusted
text; this module passes them through unchanged and the front end shows them as text only.
"""

from __future__ import annotations

from pdfeditor.webapi import dto, limits
from pdfeditor.webapi.errors import FILE_TOO_LARGE, STALE_OBJECT, RpcFailure
from pdfeditor.webapi.registry import REGISTRY


def list_attachments(params: dto.HandleParams) -> dto.AttachmentsResult:
    session = REGISTRY.get(params.handle)
    with session.lock:
        files = session.document.embedded_files()
    return dto.AttachmentsResult(
        entries=tuple(
            dto.AttachmentEntry(
                name=f.name,
                filename=f.filename,
                size=f.size,
                description=f.description,
            )
            for f in files
        )
    )


def get_attachment(params: dto.AttachmentParams) -> dto.AttachmentData:
    """One attachment's bytes, as one buffer. The size is checked twice: first against the size
    the listing reports (so a large file is never copied), then against the bytes read, since the
    listed size can be missing or wrong."""
    session = REGISTRY.get(params.handle)
    with session.lock:
        found = next((f for f in session.document.embedded_files() if f.name == params.name), None)
        if found is None:
            # The name comes from an earlier attachments.list; a changed document no longer has it.
            raise RpcFailure(STALE_OBJECT, "the attachment is no longer in the document")
        if found.size > limits.MAX_JOB_BYTES:
            raise RpcFailure(
                FILE_TOO_LARGE,
                "the attachment is too large for the browser",
                {"max_bytes": limits.MAX_JOB_BYTES, "size": found.size},
            )
        data = session.document.extract_embedded_file(params.name)
    if len(data) > limits.MAX_JOB_BYTES:
        raise RpcFailure(
            FILE_TOO_LARGE,
            "the attachment is too large for the browser",
            {"max_bytes": limits.MAX_JOB_BYTES, "size": len(data)},
        )
    return dto.AttachmentData(filename=found.filename, data=data)
