"""Attachment actions (``attachments.add``, ``attachments.remove``): embedded files (W7.9 A1).

Add is an :class:`AddAttachmentCommand`, so Undo removes the file again. Remove is a snapshot
step, as flatten is: undo must restore the exact file specification (dates, MIME type, the
relationship of a PDF/A-3 file), which a re-add from the bytes and description would lose.

Signed documents refuse both (an in-place save is incremental, so a "removed" file would still be
in the earlier revision). The reasons are stable codes for the web (W7.5); the English messages are
what the desktop shows.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from pdfeditor.actions import action
from pdfeditor.actions.base import (
    ActionResult,
    Refused,
    StaleObject,
    ensure_idle,
    execute_command,
    snapshot,
)
from pdfeditor.actions.security import SIGNED
from pdfeditor.core.commands import AddAttachmentCommand
from pdfeditor.core.session import DocumentSession
from pdfeditor.engine.base import Document
from pdfeditor.model import platform

ADD_SIGNED_REFUSED = (
    "This document is signed. Adding an attachment would invalidate the signatures."
)
REMOVE_SIGNED_REFUSED = (
    "This document is signed. Removing an attachment would invalidate the signatures."
)
EMPTY = "This file is empty, so it can't be attached."
TOO_LARGE_PREFIX = "This file is larger than"
NAME_UNUSABLE = "This file has no usable name."
MISSING = "That attachment is no longer in the document."

LABEL_REMOVE = "Remove Attachment"

# -- argument types ------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class AddAttachment:
    data: bytes
    filename: str
    description: str = ""


@dataclass(frozen=True, slots=True)
class RemoveAttachment:
    name: str


# -- helpers -------------------------------------------------------------------------------


def clean_filename(declared: str) -> str:
    """The name a picked file is embedded under: its last path part, without control characters
    (a browser or OS may send a path; a name must never carry one). Empty or "." / ".." is no
    name at all. The caller refuses an empty result."""
    last = re.split(r"[\\/]", declared)[-1]
    kept = "".join(ch for ch in last if not unicodedata.category(ch).startswith("C"))
    kept = kept.strip()
    return "" if kept in (".", "..") else kept


def free_name(filename: str, taken: set[str]) -> str:
    """``filename`` if no attachment has it, else ``stem (2).ext``, ``stem (3).ext``, ... The
    stem is everything before the last dot, so ``.profile`` has no extension to keep."""
    if filename not in taken:
        return filename
    dot = filename.rfind(".")
    stem, ext = (filename[:dot], filename[dot:]) if dot > 0 else (filename, "")
    n = 2
    while f"{stem} ({n}){ext}" in taken:
        n += 1
    return f"{stem} ({n}){ext}"


def _taken_names(doc: Document) -> set[str]:
    """Every key and every shown file name already in use: a new file must not collide with
    either, so the list never shows two entries with one name."""
    taken: set[str] = set()
    for f in doc.embedded_files():
        taken.add(f.name)
        taken.add(f.filename)
    return taken


def _refuse_signed(doc: Document, message: str) -> None:
    """Caller holds ``session.lock``."""
    if doc.info().has_signatures:
        raise Refused(message, reason=SIGNED)


# -- actions -------------------------------------------------------------------------------


@action("attachments.add", AddAttachment, requires=("attachments_write",))
def add(session: DocumentSession, args: AddAttachment) -> ActionResult[str]:
    """Embed the file; the value is the name it was embedded under (a free one, when the name
    was taken)."""
    ensure_idle(session)
    filename = clean_filename(args.filename)
    if not filename:
        raise Refused(NAME_UNUSABLE, reason="attachment_name")
    if not args.data:
        raise Refused(EMPTY, reason="attachment_empty")
    cap = platform.current().max_attachment_bytes
    if cap is not None and len(args.data) > cap:
        raise Refused(
            f"{TOO_LARGE_PREFIX} {cap // 1024**2} MB.",
            reason="attachment_too_large",
        )
    # Name and execute under one hold of the (re-entrant) engine lock, so no other edit can
    # take the chosen name in between.
    with session.lock:
        _refuse_signed(session.document, ADD_SIGNED_REFUSED)
        name = free_name(filename, _taken_names(session.document))
        command = AddAttachmentCommand(name, args.data, args.description)
        execute_command(session, command)
    return ActionResult(command.label, name)


@action("attachments.remove", RemoveAttachment, requires=("attachments_write",), long=True)
def remove(session: DocumentSession, args: RemoveAttachment) -> ActionResult[None]:
    ensure_idle(session)
    with session.lock:
        _refuse_signed(session.document, REMOVE_SIGNED_REFUSED)
        if args.name not in {f.name for f in session.document.embedded_files()}:
            raise StaleObject(MISSING)
    snapshot(session, LABEL_REMOVE, lambda doc: doc.remove_embedded_file(args.name))
    return ActionResult(LABEL_REMOVE, None)
