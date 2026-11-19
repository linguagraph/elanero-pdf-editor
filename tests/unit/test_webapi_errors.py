"""The exception-to-code mapping of the web RPC (W1.2 section 4): one ordered table, the most
specific class first, and INTERNAL for anything unexpected without a traceback in the message."""

from __future__ import annotations

import logging
import re
from pathlib import Path

import pytest

from pdfeditor import webapi
from pdfeditor.actions.base import Refused
from pdfeditor.engine.base import (
    EngineError,
    OpenError,
    PasswordRequired,
    SaveError,
    UnsupportedFeature,
)
from pdfeditor.webapi.errors import (
    ALL_CODES,
    ENGINE_ERROR,
    INTERNAL,
    INTERNAL_MESSAGE,
    NOT_SUPPORTED,
    OPEN_FAILED,
    OUT_OF_MEMORY,
    PASSWORD_REQUIRED,
    REFUSED,
    SAVE_FAILED,
    UNUSED_CODES,
    RpcFailure,
    failure_for,
)


@pytest.mark.parametrize(
    ("exc", "code"),
    [
        (PasswordRequired("document is password protected"), PASSWORD_REQUIRED),
        (OpenError("not a PDF"), OPEN_FAILED),
        (SaveError("saved bytes cannot be reopened"), SAVE_FAILED),
        (UnsupportedFeature("no OCR here"), NOT_SUPPORTED),
        (EngineError("engine went wrong"), ENGINE_ERROR),
        (MemoryError(), OUT_OF_MEMORY),
    ],
)
def test_engine_exceptions_map_to_their_code_and_keep_the_message(
    exc: BaseException, code: str
) -> None:
    failure = failure_for(exc)
    assert failure.code == code
    assert failure.message == (str(exc) or code)


def test_password_required_is_checked_before_open_error() -> None:
    # PasswordRequired subclasses OpenError; the table must not map it as a plain open failure.
    assert issubclass(PasswordRequired, OpenError)
    assert failure_for(PasswordRequired("x")).code == PASSWORD_REQUIRED


def test_open_error_is_checked_before_engine_error() -> None:
    assert issubclass(OpenError, EngineError)
    assert failure_for(OpenError("x")).code == OPEN_FAILED


def test_unknown_exception_is_internal_and_its_text_stays_out_of_the_message(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.ERROR, logger="pdfeditor.webapi.errors"):
        try:
            raise ZeroDivisionError("a private detail")
        except ZeroDivisionError as exc:
            failure = failure_for(exc)
    assert failure.code == INTERNAL
    assert failure.message == INTERNAL_MESSAGE
    assert "private detail" not in failure.message
    assert "Traceback" not in failure.message
    # The full traceback goes to the worker console, through the logger.
    assert any(record.exc_info for record in caplog.records)


def test_an_rpc_failure_is_returned_as_it_is() -> None:
    original = RpcFailure("NO_DOCUMENT", "gone", {"x": 1})
    assert failure_for(original) is original


def test_declared_codes_are_unique_and_unused_codes_are_declared() -> None:
    assert len(ALL_CODES) == len(set(ALL_CODES))
    assert set(ALL_CODES) >= UNUSED_CODES


def test_every_code_is_tested_or_listed_as_unused() -> None:
    """A code the calls can raise must be named by a web test; a code listed as unused must not
    be raised anywhere in the webapi package (only errors.py names it)."""
    tests_dir = Path(__file__).parent
    tests = "\n".join(p.read_text(encoding="utf-8") for p in tests_dir.glob("test_webapi_*.py"))
    package = Path(webapi.__file__).parent
    sources = "\n".join(
        p.read_text(encoding="utf-8") for p in package.glob("*.py") if p.name != "errors.py"
    )
    for code in ALL_CODES:
        named = re.search(rf"\b{code}\b", tests) is not None
        raised = re.search(rf"\b{code}\b", sources) is not None
        if code in UNUSED_CODES:
            assert not raised, f"{code} is listed as unused but the webapi package raises it"
        else:
            # Mapped from an exception class (OUT_OF_MEMORY, NOT_SUPPORTED, ...) counts as raised
            # by errors.py itself, so the test names it and it is covered there.
            assert named, f"{code} is raised but no web test names it"


def test_a_refusal_with_a_reason_sends_the_code_as_details_reason() -> None:
    # W7.5: the web words the security refusals from their code, not from the English text.
    failure = failure_for(Refused("This document has no security.", reason="no_security"))
    assert failure.code == REFUSED
    assert failure.details == {"reason": "no_security"}
    assert failure.message == "This document has no security."


def test_a_refusal_without_a_reason_keeps_its_text_as_details_reason() -> None:
    failure = failure_for(Refused("Some other refusal."))
    assert failure.details == {"reason": "Some other refusal."}
