"""The exception-to-code mapping of the web RPC (W1.2 section 4): one ordered table, the most
specific class first, and INTERNAL for anything unexpected without a traceback in the message."""

from __future__ import annotations

import logging

import pytest

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
