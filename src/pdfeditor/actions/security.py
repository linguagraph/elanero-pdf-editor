"""Security actions (``security.*``) and ``document.sanitize`` (W1.3 §1).

Ported from the desktop's ``ui/protect_controller.py``. The owner-password prompt stays in the UI:
the front end unlocks the document first, then calls :func:`set_security` or
:func:`remove_security`. ``document.sanitize`` lives here because it is part of the same
"clean up before sharing" group, though its registry name is ``document.sanitize`` (#161).
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field

from pdfeditor.actions import action
from pdfeditor.actions.base import (
    ActionResult,
    Refused,
    ensure_idle,
    execute_command,
    snapshot,
)
from pdfeditor.core.commands import SetSecurityCommand
from pdfeditor.core.session import DocumentSession
from pdfeditor.model.metadata import EncryptionMethod, SecuritySettings
from pdfeditor.model.redaction import SanitizeOptions

OWNER_NEEDED = "The permissions password is needed to change this document's security."
# Changing encryption needs a full rewrite, which would break the signatures (Acrobat refuses too).
SIGNED_REFUSED = "This document is signed. Changing its security would invalidate the signatures."
NO_SECURITY_MESSAGE = "This document has no security."

# Stable reason codes (W7.5): the web words each one itself, so these never change meaning. The
# English messages above are the desktop's and stay as they are.
SIGNED = "signed_document"
OWNER = "owner_password_needed"
NO_SECURITY = "no_security"
INVALID = "invalid_settings"

# Methods the browser offers (the desktop's AES choices); RC4 is refused here (W7.5 section 3).
SUPPORTED_METHODS = (EncryptionMethod.AES_256, EncryptionMethod.AES_128)
# AES-256 takes UTF-8 up to 127 bytes. AES-128 takes at most 32 characters, and only ASCII: MuPDF
# writes the RC4/AES-128 user password as UTF-8, which pikepdf and other Latin-1 readers reject for
# any non-ASCII letter, so such a file would open only in MuPDF (W7.5 S2 finding).
AES_256_MAX_BYTES = 127
AES_128_MAX_CHARS = 32

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


def _refuse_if_signed(session: DocumentSession) -> None:
    """Caller holds ``session.lock``."""
    if session.document.info().has_signatures:
        raise Refused(SIGNED_REFUSED, reason=SIGNED)


def _check_settings(settings: SecuritySettings) -> None:
    """Refuse settings that the engine would write badly or that the desktop would not accept.

    The rule lives here, the single source; the web repeats it for inline messages (W7.5 section
    7). A message names the rule only, never a password. ``method`` NONE is removal, always allowed.
    """
    if settings.method is EncryptionMethod.NONE:
        return
    if settings.method not in SUPPORTED_METHODS:
        raise Refused("Only AES-256 and AES-128 encryption are supported.", reason=INVALID)
    user, owner = settings.user_password, settings.owner_password
    if not user and not owner:
        raise Refused("Enter a password to open the document or to restrict it.", reason=INVALID)
    # Equal passwords only mean "open password only, everything allowed" (the desktop sends
    # owner = user for that case); restricting with the same password is refused.
    restricted = not all(dataclasses.astuple(settings.permissions))
    if user and owner and user == owner and restricted:
        raise Refused(
            "The permissions password must differ from the open password.", reason=INVALID
        )
    for password in (user, owner):
        if settings.method is EncryptionMethod.AES_256:
            if len(password.encode("utf-8")) > AES_256_MAX_BYTES:
                raise Refused(
                    f"AES-256 passwords can be at most {AES_256_MAX_BYTES} bytes in UTF-8.",
                    reason=INVALID,
                )
        elif len(password) > AES_128_MAX_CHARS or not password.isascii():
            raise Refused(
                f"AES-128 passwords can be at most {AES_128_MAX_CHARS} characters, "
                "using ASCII letters only.",
                reason=INVALID,
            )


@action("security.set", SetSecurity, requires=("encrypt",))
def set_security(session: DocumentSession, args: SetSecurity) -> ActionResult[None]:
    """Queue password protection (or its removal) for the next save."""
    ensure_idle(session)
    with session.lock:
        _refuse_if_signed(session)
        if not session.document.has_owner_access():
            raise Refused(OWNER_NEEDED, reason=OWNER)
    _check_settings(args.settings)
    command = SetSecurityCommand(args.settings)
    execute_command(session, command)
    return ActionResult(command.label, None)


@action("security.remove", RemoveSecurity, requires=("encrypt",))
def remove_security(session: DocumentSession, args: RemoveSecurity) -> ActionResult[None]:
    """Lift the passwords and restrictions on the next save, or drop a pending change."""
    ensure_idle(session)
    with session.lock:
        _refuse_if_signed(session)
        doc = session.document
        encrypted = doc.info().encryption is not EncryptionMethod.NONE
        pending = doc.pending_security()
        owner = doc.has_owner_access()
    if not encrypted and (pending is None or pending.method is EncryptionMethod.NONE):
        raise Refused(NO_SECURITY_MESSAGE, reason=NO_SECURITY)
    if encrypted and not owner:
        raise Refused(OWNER_NEEDED, reason=OWNER)
    command = SetSecurityCommand(SecuritySettings(EncryptionMethod.NONE))
    execute_command(session, command)
    return ActionResult(command.label, None)


@action("document.sanitize", SanitizeDocument, long=True)
def sanitize(session: DocumentSession, args: SanitizeDocument) -> ActionResult[tuple[str, ...]]:
    """Remove hidden or sensitive data; the value lists what was removed, for the report."""
    ensure_idle(session)
    removed = snapshot(session, "Sanitize Document", lambda doc: doc.sanitize(args.options))
    session.require_full_save = True
    return ActionResult("Sanitize Document", tuple(removed))
