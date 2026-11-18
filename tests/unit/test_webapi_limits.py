"""The resource limits of the web build (W1.1 section 7), with the limits lowered for the test.

A refused file is never registered, so a refusal leaves nothing open behind.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import pytest

from pdfeditor.engine.registry import get_engine
from pdfeditor.webapi import dispatch, limits
from pdfeditor.webapi.errors import FILE_TOO_LARGE, TOO_MANY_PAGES
from pdfeditor.webapi.registry import REGISTRY


@pytest.fixture(autouse=True)
def _no_documents_left_open() -> Iterator[None]:
    yield
    REGISTRY.close_all()


def open_bytes(data: bytes) -> dict[str, Any]:
    request = json.dumps(
        {
            "v": 1,
            "id": 1,
            "method": "session.open",
            "params": {"name": "a.pdf", "data": {"$bin": 0}, "password": None},
        }
    )
    reply_json, _ = dispatch(request, [data])
    return json.loads(reply_json)


def test_a_file_above_the_refuse_limit_is_too_large(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(limits, "FILE_REFUSE_BYTES", 100)
    reply = open_bytes(b"x" * 101)
    assert reply["error"]["code"] == FILE_TOO_LARGE
    assert reply["error"]["details"] == {"max_bytes": 100, "size": 101}
    assert len(REGISTRY) == 0


def test_a_file_at_the_refuse_limit_is_not_refused_for_size(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(limits, "FILE_REFUSE_BYTES", 100)
    reply = open_bytes(b"x" * 100)
    # Not a PDF, so it fails to open, but never for its size.
    assert reply["error"]["code"] != FILE_TOO_LARGE


def test_too_many_pages_is_refused_and_nothing_stays_open(
    monkeypatch: pytest.MonkeyPatch, fixture_pdf: Any
) -> None:
    path = fixture_pdf("text_multipage")
    data = path.read_bytes()
    doc = get_engine().open(path)
    try:
        pages = doc.page_count
    finally:
        doc.close()
    assert pages > 2, "the fixture must have more pages than the lowered limit"
    monkeypatch.setattr(limits, "MAX_PAGES", 2)
    reply = open_bytes(data)
    assert reply["error"]["code"] == TOO_MANY_PAGES
    assert reply["error"]["details"] == {"max_pages": 2, "pages": pages}
    assert len(REGISTRY) == 0


def test_a_large_file_gets_a_warning_in_the_open_reply(
    monkeypatch: pytest.MonkeyPatch, fixture_pdf: Any
) -> None:
    data = fixture_pdf("text_multipage").read_bytes()
    monkeypatch.setattr(limits, "FILE_WARN_BYTES", 10)
    reply = open_bytes(data)
    assert reply["ok"] is True, reply
    assert isinstance(reply["result"]["warning"], str)
    assert reply["result"]["warning"]


def test_a_normal_file_has_no_warning(fixture_pdf: Any) -> None:
    reply = open_bytes(fixture_pdf("text_multipage").read_bytes())
    assert reply["ok"] is True, reply
    assert reply["result"]["warning"] is None


def test_the_default_limits_are_the_documented_values() -> None:
    assert limits.FILE_WARN_BYTES == 200 * 1024 * 1024
    assert limits.FILE_REFUSE_BYTES == 1024**3
    assert limits.MAX_PAGES == 5000
