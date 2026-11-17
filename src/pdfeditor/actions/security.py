"""Security actions (``security.*``) and ``document.sanitize`` (W1.3 §1).

Ported from the desktop's ``ui/protect_controller.py``. The owner-password prompt stays in the UI:
the front end unlocks the document first, then calls :func:`set_security` or
:func:`remove_security`. ``document.sanitize`` lives here because it is part of the same
"clean up before sharing" group, though its registry name is ``document.sanitize`` (#161).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from pdfeditor.actions import action
from pdfeditor.actions.base import ActionResult, Refused, ensure_idle, snapshot
from pdfeditor.core.commands import SetSecurityCommand
from pdfeditor.core.session import DocumentSession
from pdfeditor.model.metadata import EncryptionMethod, SecuritySettings
from pdfeditor.model.redaction import SanitizeOptions

OWNER_NEEDED = "The permissions password is needed to change this document's security."

# -- argument types ------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class SetSecurity:
    settings: SecuritySettings


@dataclass(frozen=True, slots=True)
class RemoveSecurity:
    pass


@dataclass(frozen=True, slots=True)
class SanitizeDocument:
    options: SanitizeOptions = field(default_factory=SanitizeOptions)


# -- actions -------------------------------------------------------------------------------


@action("security.set", SetSecurity, requires=("encrypt",))
def set_security(session: DocumentSession, args: SetSecurity) -> ActionResult[None]:
    """Queue password protection (or its removal) for the next save."""
    ensure_idle(session)
    with session.lock:
        if not session.document.has_owner_access():
            raise Refused(OWNER_NEEDED)
    command = SetSecurityCommand(args.settings)
    session.execute(command)
    return ActionResult(command.label, None)


@action("security.remove", RemoveSecurity, requires=("encrypt",))
def remove_security(session: DocumentSession, args: RemoveSecurity) -> ActionResult[None]:
    """Lift the passwords and restrictions on the next save, or drop a pending change."""
    ensure_idle(session)
    with session.lock:
        doc = session.document
        encrypted = doc.info().encryption is not EncryptionMethod.NONE
        pending = doc.pending_security()
        owner = doc.has_owner_access()
    if not encrypted and (pending is None or pending.method is EncryptionMethod.NONE):
        raise Refused("This document has no security.")
    if encrypted and not owner:
        raise Refused(OWNER_NEEDED)
    command = SetSecurityCommand(SecuritySettings(EncryptionMethod.NONE))
    session.execute(command)
    return ActionResult(command.label, None)


@action("document.sanitize", SanitizeDocument, long=True)
def sanitize(session: DocumentSession, args: SanitizeDocument) -> ActionResult[tuple[str, ...]]:
    """Remove hidden or sensitive data; the value lists what was removed, for the report."""
    ensure_idle(session)
    removed = snapshot(session, "Sanitize Document", lambda doc: doc.sanitize(args.options))
    session.require_full_save = True
    return ActionResult("Sanitize Document", tuple(removed))
