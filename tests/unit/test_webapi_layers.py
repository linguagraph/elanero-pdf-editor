"""The read-only layers call of W7.9 S3 (``layers.list``) through dispatch.

On the ``layers`` fixture (a "Shown layer" that is on and a "Hidden layer" that is off) the call
gives each layer's name and default visibility. The call changes nothing: the page revisions and
the structure version stay the same, and the document stays clean with nothing to undo. (Two saves
of an unchanged document are not byte-identical, because of the trailer's date, so the state is
compared instead of the bytes.)
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.webapi import dispatch
from pdfeditor.webapi.jobs import document_fingerprint
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
    reply_json, _out = dispatch(request, [])
    reply: dict[str, Any] = json.loads(reply_json)
    return reply


def ok(reply: dict[str, Any]) -> dict[str, Any]:
    assert reply["ok"] is True, reply
    result: dict[str, Any] = reply["result"]
    return result


def state(handle: str) -> tuple[object, ...]:
    session = REGISTRY.get(handle)
    with session.lock:
        return (*document_fingerprint(session), session.is_dirty, session.undo_stack.undo_label)


def test_lists_each_layers_name_and_default_visibility(web: None, fixture_pdf: Any) -> None:
    handle = handle_of(open_bytes(fixture_pdf("layers").read_bytes()))
    layers = ok(call("layers.list", {"handle": handle}))["layers"]
    assert [(layer["name"], layer["visible"]) for layer in layers] == [
        ("Shown layer", True),
        ("Hidden layer", False),
    ]
    for layer in layers:
        assert isinstance(layer["id"], int)
        assert layer["depth"] == 0
        assert layer["locked"] is False


def test_a_document_without_layers_gives_an_empty_list(web: None, fixture_pdf: Any) -> None:
    handle = handle_of(open_bytes(fixture_pdf("images").read_bytes()))
    assert ok(call("layers.list", {"handle": handle})) == {"layers": []}


def test_listing_does_not_change_the_document(web: None, fixture_pdf: Any) -> None:
    handle = handle_of(open_bytes(fixture_pdf("layers").read_bytes()))
    before = state(handle)
    ok(call("layers.list", {"handle": handle}))
    ok(call("layers.list", {"handle": handle}))
    assert state(handle) == before
    session = REGISTRY.get(handle)
    assert session.is_dirty is False
    assert session.undo_stack.can_undo is False
