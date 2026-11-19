"""The read-only outline call of W5.2 (bookmarks) through dispatch, on real fixtures."""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.webapi import dispatch
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.unit.test_webapi_session import handle_of, open_bytes


@pytest.fixture
def web() -> Iterator[None]:
    previous = model_platform.current()
    configure_web()
    try:
        yield
    finally:
        REGISTRY.close_all()
        model_platform.configure(previous)


def call(method: str, params: dict[str, Any]) -> dict[str, Any]:
    request = json.dumps({"v": 1, "id": 1, "method": method, "params": params})
    reply_json, out = dispatch(request, [])
    assert out == []
    return json.loads(reply_json)


def test_outline_lists_titles_pages_and_levels(web: None, fixture_pdf: Any) -> None:
    handle = handle_of(open_bytes(fixture_pdf("outline").read_bytes()))
    reply = call("session.outline", {"handle": handle})
    assert reply["ok"] is True, reply
    entries = reply["result"]["entries"]
    # The fixture is two chapters per three levels of pairs: a chapter (level 1) followed by its
    # sections (level 2); pages are zero-based.
    assert [(e["title"], e["level"], e["page"]) for e in entries] == [
        ("Chapter 1", 1, 0),
        ("Section 1.1", 2, 0),
        ("Section 1.2", 2, 1),
        ("Chapter 2", 1, 2),
        ("Section 2.1", 2, 2),
        ("Section 2.2", 2, 3),
        ("Chapter 3", 1, 4),
        ("Section 3.1", 2, 4),
        ("Section 3.2", 2, 5),
    ]
    assert all(isinstance(e["is_open"], bool) for e in entries)


def test_outline_of_a_document_without_bookmarks_is_empty(web: None, fixture_pdf: Any) -> None:
    handle = handle_of(open_bytes(fixture_pdf("text_multipage").read_bytes()))
    reply = call("session.outline", {"handle": handle})
    assert reply["ok"] is True, reply
    assert reply["result"] == {"entries": []}


def test_outline_needs_an_open_document(web: None) -> None:
    reply = call("session.outline", {"handle": "0" * 32})
    assert reply["ok"] is False
    assert reply["error"]["code"] == "NO_DOCUMENT"
