"""The ``combine.unlock`` call (W6.3b P1): one open with the password returns an unprotected copy,
and the merge's refusal names the locked source's place. The password is used once: it reaches no
log record, reply or error, the job request carries none, and the registry keeps nothing."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import pytest

from pdfeditor.engine.registry import DEFAULT_ENGINE, get_engine
from pdfeditor.webapi import combine, limits
from pdfeditor.webapi.errors import (
    FILE_TOO_LARGE,
    INTERNAL,
    INVALID_ARGS,
    OPEN_FAILED,
    REFUSED,
    WRONG_PASSWORD,
)
from pdfeditor.webapi.registry import REGISTRY
from tests.hostcheck import record
from tests.unit.test_webapi_job_types import (  # noqa: F401 (the fixture)
    binary,
    run_without_document,
    web,
)
from tests.unit.test_webapi_jobs import call_raw, error, ok

SECRET = "pw-Zq7!x"  # a password no fixture uses, so a leak is easy to spot


def _unlock(name: str, data: bytes, password: str) -> tuple[dict[str, Any], list[bytes]]:
    params = {"name": name, "data": {"$bin": 0}, "password": password}
    return call_raw("combine.unlock", params, [data])


def _pages(data: bytes) -> int:
    document = get_engine(DEFAULT_ENGINE).open(data)
    try:
        return int(document.page_count)
    finally:
        document.close()


def test_the_unlocked_copy_opens_without_a_password_and_renders(fixture_pdf: Any) -> None:
    data = Path(fixture_pdf("encrypted")).read_bytes()
    reply, out = _unlock("encrypted.pdf", data, "user")
    result = ok(reply)
    copy = binary(result["data"], out)
    assert result["page_count"] == 1
    record("not_encrypted_pikepdf", copy)
    record("page_count_pikepdf", copy, pages=1)
    record("text_contains_pdfium", copy, page=0, text="Secret content")


def test_the_owner_password_also_unlocks(fixture_pdf: Any) -> None:
    data = Path(fixture_pdf("encrypted")).read_bytes()
    reply, out = _unlock("encrypted.pdf", data, "owner")
    assert ok(reply)["page_count"] == 1
    record("not_encrypted_pikepdf", binary(ok(reply)["data"], out))


@pytest.mark.usefixtures("web")
def test_the_unlocked_copy_merges_with_a_plain_pdf(
    fixture_pdf: Any,
) -> None:
    locked = Path(fixture_pdf("encrypted")).read_bytes()
    plain = Path(fixture_pdf("text_multipage")).read_bytes()
    reply, out = _unlock("encrypted.pdf", locked, "user")
    copy = binary(ok(reply)["data"], out)
    args = {
        "sources": [
            {"name": "encrypted.pdf", "data": {"$bin": 0}},
            {"name": "text.pdf", "data": {"$bin": 1}},
        ]
    }
    merged_reply, merged_out = run_without_document("merge", args, [copy, plain])
    merged = binary(ok(merged_reply)["document"], merged_out)
    record("page_count_pikepdf", merged, pages=1 + _pages(plain))
    record("not_encrypted_pikepdf", merged)
    record("text_contains_pdfium", merged, page=0, text="Secret content")


@pytest.mark.parametrize("password", ["nope", "", "user "], ids=["wrong", "empty", "near-miss"])
def test_a_wrong_password_is_wrong_password_with_no_details(
    fixture_pdf: Any, password: str
) -> None:
    data = Path(fixture_pdf("encrypted")).read_bytes()
    reply, _ = _unlock("encrypted.pdf", data, password)
    assert error(reply)["code"] == WRONG_PASSWORD
    assert error(reply)["details"] == {}


def test_the_argument_checks_come_before_any_open(
    fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    data = Path(fixture_pdf("encrypted")).read_bytes()
    reply, _ = _unlock("encrypted.png", data, SECRET)
    assert error(reply)["code"] == INVALID_ARGS
    reply, _ = _unlock("encrypted.pdf", data, "x" * (combine.MAX_PASSWORD_CHARS + 1))
    assert error(reply)["details"]["path"] == "params.password"
    monkeypatch.setattr(limits, "MAX_PROBE_BYTES", 10)
    reply, _ = _unlock("encrypted.pdf", data, SECRET)
    assert error(reply)["code"] == FILE_TOO_LARGE


def test_garbage_bytes_are_open_failed(fixture_pdf: Any) -> None:
    reply, _ = _unlock("junk.pdf", b"not a pdf at all", SECRET)
    assert error(reply)["code"] == OPEN_FAILED


def test_the_password_is_never_in_a_log_record_or_a_reply(
    fixture_pdf: Any, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    data = Path(fixture_pdf("encrypted")).read_bytes()
    ok_reply, _ = _unlock("encrypted.pdf", data, "user")
    wrong_reply, _ = _unlock("encrypted.pdf", data, SECRET)
    assert SECRET not in str(wrong_reply)
    assert "user" not in str(ok_reply)  # the reply holds no password
    assert all(SECRET not in record.getMessage() for record in caplog.records)


class _BrokenCopy:
    """Opens like the engine but fails to copy the file; records that it was closed."""

    def __init__(self, closed: list[bool]) -> None:
        self.closed = closed

    @property
    def page_count(self) -> int:
        return 1

    def to_bytes(self, options: object) -> bytes:
        raise RuntimeError("copy failed")

    def close(self) -> None:
        self.closed.append(True)


class _BrokenEngine:
    def __init__(self, closed: list[bool]) -> None:
        self.closed = closed
        self.passwords: list[object] = []

    def open(self, source: object, password: str | None = None) -> _BrokenCopy:
        self.passwords.append(password)
        return _BrokenCopy(self.closed)


def test_an_internal_failure_logs_no_password_and_still_closes_the_document(
    fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    closed: list[bool] = []
    engine = _BrokenEngine(closed)
    monkeypatch.setattr(combine, "get_engine", lambda name: engine)
    data = Path(fixture_pdf("encrypted")).read_bytes()
    reply, _ = _unlock("encrypted.pdf", data, SECRET)
    assert error(reply)["code"] == INTERNAL
    assert engine.passwords == [SECRET]  # one open, no retry
    assert closed == [True]
    assert SECRET not in str(reply)
    assert all(SECRET not in record.getMessage() for record in caplog.records)


def test_unlock_keeps_nothing_in_the_registry(fixture_pdf: Any) -> None:
    before = len(REGISTRY)
    data = Path(fixture_pdf("encrypted")).read_bytes()
    ok(_unlock("encrypted.pdf", data, "user")[0])
    assert len(REGISTRY) == before
    assert REGISTRY.passwords_kept() == 0


def test_a_merge_job_never_takes_a_password(fixture_pdf: Any) -> None:
    plain = Path(fixture_pdf("text_multipage")).read_bytes()
    args = {
        "sources": [
            {"name": "a.pdf", "data": {"$bin": 0}, "password": SECRET},
            {"name": "b.pdf", "data": {"$bin": 1}},
        ]
    }
    reply, _ = run_without_document("merge", args, [plain, plain])
    assert error(reply)["code"] == INVALID_ARGS
    assert SECRET not in str(reply)


@pytest.mark.usefixtures("web")
def test_a_locked_merge_source_is_refused_with_its_index(
    fixture_pdf: Any,
) -> None:
    plain = Path(fixture_pdf("text_multipage")).read_bytes()
    locked = Path(fixture_pdf("encrypted")).read_bytes()
    args = {
        "sources": [
            {"name": "text.pdf", "data": {"$bin": 0}},
            {"name": "encrypted.pdf", "data": {"$bin": 1}},
        ]
    }
    reply, _ = run_without_document("merge", args, [plain, locked])
    assert error(reply)["code"] == REFUSED
    assert error(reply)["details"] == {"reason": "encrypted_source", "path": "args.sources[1]"}


@pytest.mark.usefixtures("web")
def test_a_locked_source_with_a_range_is_refused_with_its_index(
    fixture_pdf: Any,
) -> None:
    plain = Path(fixture_pdf("text_multipage")).read_bytes()
    locked = Path(fixture_pdf("encrypted")).read_bytes()
    args = {
        "sources": [
            {"name": "text.pdf", "data": {"$bin": 0}},
            {"name": "encrypted.pdf", "data": {"$bin": 1}, "ranges": "1"},
        ]
    }
    reply, _ = run_without_document("merge", args, [plain, locked])
    assert error(reply)["code"] == REFUSED
    assert error(reply)["details"] == {"reason": "encrypted_source", "path": "args.sources[1]"}
