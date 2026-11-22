"""Stable error codes (W1.2 section 4) and the one mapping from exceptions to them.

The front end translates ``code`` (W4.7), so codes never change meaning. ``message`` is English
for logs and the "Details" disclosure. It never carries a password, document text or a
traceback: an unexpected exception is logged in full on the worker side and reported as
``INTERNAL`` with a fixed message.
"""

from __future__ import annotations

import logging

from pdfeditor.actions.base import (
    ActionError,
    Busy,
    InvalidArgs,
    NotSupported,
    Refused,
    StaleObject,
)
from pdfeditor.core.jobs import Cancelled
from pdfeditor.engine.base import (
    EngineError,
    OpenError,
    PasswordRequired,
    SaveError,
    UnsupportedFeature,
)

log = logging.getLogger(__name__)

INVALID_REQUEST = "INVALID_REQUEST"
INVALID_ARGS = "INVALID_ARGS"
PROTOCOL_MISMATCH = "PROTOCOL_MISMATCH"
NO_DOCUMENT = "NO_DOCUMENT"
PASSWORD_REQUIRED = "PASSWORD_REQUIRED"
WRONG_PASSWORD = "WRONG_PASSWORD"
OPEN_FAILED = "OPEN_FAILED"
SAVE_FAILED = "SAVE_FAILED"
REFUSED = "REFUSED"
BUSY = "BUSY"
NOT_SUPPORTED = "NOT_SUPPORTED"
STALE_OBJECT = "STALE_OBJECT"
STALE_CURSOR = "STALE_CURSOR"
STALE_JOB = "STALE_JOB"
CANCELLED = "CANCELLED"
FILE_TOO_LARGE = "FILE_TOO_LARGE"
TOO_MANY_PAGES = "TOO_MANY_PAGES"
RENDER_TOO_LARGE = "RENDER_TOO_LARGE"
IMAGE_TOO_LARGE = "IMAGE_TOO_LARGE"
OUT_OF_MEMORY = "OUT_OF_MEMORY"
ENGINE_ERROR = "ENGINE_ERROR"
INVALID_FONT = "INVALID_FONT"
FONT_NOT_EMBEDDABLE = "FONT_NOT_EMBEDDABLE"
FONT_STORAGE_FULL = "FONT_STORAGE_FULL"
TRANSLATION_OFFLINE = "TRANSLATION_OFFLINE"
TRANSLATION_QUOTA = "TRANSLATION_QUOTA"
TRANSLATION_AUTH = "TRANSLATION_AUTH"
TRANSLATION_CONFIG = "TRANSLATION_CONFIG"
TRANSLATION_TOO_LONG = "TRANSLATION_TOO_LONG"
TRANSLATION_SAME_LANGUAGE = "TRANSLATION_SAME_LANGUAGE"
TRANSLATION_SERVICE = "TRANSLATION_SERVICE"
INTERNAL = "INTERNAL"

ALL_CODES: tuple[str, ...] = (
    INVALID_REQUEST,
    INVALID_ARGS,
    PROTOCOL_MISMATCH,
    NO_DOCUMENT,
    PASSWORD_REQUIRED,
    WRONG_PASSWORD,
    OPEN_FAILED,
    SAVE_FAILED,
    REFUSED,
    BUSY,
    NOT_SUPPORTED,
    STALE_OBJECT,
    STALE_CURSOR,
    STALE_JOB,
    CANCELLED,
    FILE_TOO_LARGE,
    TOO_MANY_PAGES,
    RENDER_TOO_LARGE,
    IMAGE_TOO_LARGE,
    OUT_OF_MEMORY,
    ENGINE_ERROR,
    INVALID_FONT,
    FONT_NOT_EMBEDDABLE,
    FONT_STORAGE_FULL,
    TRANSLATION_OFFLINE,
    TRANSLATION_QUOTA,
    TRANSLATION_AUTH,
    TRANSLATION_CONFIG,
    TRANSLATION_TOO_LONG,
    TRANSLATION_SAME_LANGUAGE,
    TRANSLATION_SERVICE,
    INTERNAL,
)

# Declared by W1.2 but not raised yet. Each is raised by a later group (translation calls), so
# the tests check this list against the codes the code can raise and nothing else. REFUSED, BUSY
# and STALE_OBJECT are raised by the actions calls (W3.5); STALE_JOB and CANCELLED by the jobs
# calls (W3.7); INVALID_FONT and FONT_NOT_EMBEDDABLE by fonts.validate and fonts.add (W6.9).
UNUSED_CODES: frozenset[str] = frozenset(
    {
        IMAGE_TOO_LARGE,
    }
)

INTERNAL_MESSAGE = "an internal error occurred; the details are in the worker console"


class RpcFailure(Exception):
    """A failure with a stable code. Raised inside webapi and turned into an error reply."""

    def __init__(self, code: str, message: str, details: dict[str, object] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details: dict[str, object] = details or {}


# Ordered: the first matching class wins, so the more specific classes come first.
_MAPPING: tuple[tuple[type[BaseException], str], ...] = (
    (PasswordRequired, PASSWORD_REQUIRED),  # WRONG_PASSWORD is chosen by the caller (session)
    (OpenError, OPEN_FAILED),
    (SaveError, SAVE_FAILED),
    (UnsupportedFeature, NOT_SUPPORTED),
    (Refused, REFUSED),
    (Cancelled, CANCELLED),
    (Busy, BUSY),
    (InvalidArgs, INVALID_ARGS),
    (StaleObject, STALE_OBJECT),
    (NotSupported, NOT_SUPPORTED),
    (EngineError, ENGINE_ERROR),
    (MemoryError, OUT_OF_MEMORY),
)


def failure_for(exc: BaseException) -> RpcFailure:
    """The reply for any exception that escapes a call. Logs the traceback of unexpected ones."""
    if isinstance(exc, RpcFailure):
        return exc
    for cls, code in _MAPPING:
        if isinstance(exc, cls):
            return RpcFailure(code, str(exc) or code, _action_details(exc, code))
    log.error("unexpected error in a web call", exc_info=exc)
    return RpcFailure(INTERNAL, INTERNAL_MESSAGE)


def _action_details(exc: BaseException, code: str) -> dict[str, object] | None:
    """The W1.2 section 4 details of an actions-layer error: the busy task, or the reason."""
    if not isinstance(exc, ActionError):
        return None
    if code == BUSY:
        return {"task": str(exc)}
    if exc.reason is not None:  # a stable code from the action (W7.5), never a password
        return {"reason": exc.reason}
    return {"reason": str(exc)}
