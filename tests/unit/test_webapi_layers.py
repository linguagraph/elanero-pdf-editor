"""The layer calls of W7.9 through dispatch: ``layers.list`` (S3) and ``layers.set_visible`` (L1).

On the ``layers`` fixture (a "Shown layer" that is on and a "Hidden layer" that is off) the call
gives each layer's name and default visibility. The call changes nothing: the page revisions and
the structure version stay the same, and the document stays clean with nothing to undo. (Two saves
of an unchanged document are not byte-identical, because of the trailer's date, so the state is
compared instead of the bytes.)
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.model.metadata import LayerInfo
from pdfeditor.webapi import dispatch
from pdfeditor.webapi.jobs import document_fingerprint
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.hostcheck import record
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


def call_raw(method: str, params: dict[str, Any]) -> tuple[dict[str, Any], list[bytes]]:
    request = json.dumps({"v": 1, "id": 1, "method": method, "params": params})
    reply_json, out = dispatch(request, [])
    return json.loads(reply_json), out


def layer_id(handle: str, name: str) -> int:
    layers = ok(call("layers.list", {"handle": handle}))["layers"]
    return int(next(layer["id"] for layer in layers if layer["name"] == name))


def set_visible(handle: str, layer: int, visible: bool) -> dict[str, Any]:
    return call("layers.set_visible", {"handle": handle, "id": layer, "visible": visible})


def failure(reply: dict[str, Any]) -> dict[str, Any]:
    assert reply["ok"] is False, reply
    error: dict[str, Any] = reply["error"]
    return error


def snapshot(handle: str) -> tuple[int, tuple[object, ...]]:
    """Page 0's revision plus the document state, taken before a call that must be refused."""
    session = REGISTRY.get(handle)
    with session.lock:
        revision = session.document.page(0).revision
    return revision, state(handle)


def assert_refused_without_mutation(
    handle: str, reply: dict[str, Any], before: tuple[int, tuple[object, ...]]
) -> None:
    """A refusal raises before the mutation: no ``changed`` event, same revision, still clean."""
    assert "changed" not in [event["kind"] for event in reply.get("events", [])]
    assert snapshot(handle) == before
    session = REGISTRY.get(handle)
    assert session.is_dirty is False
    assert session.undo_stack.can_undo is False


def test_showing_a_hidden_layer_returns_the_new_list_and_a_changed_event(
    web: None, fixture_pdf: Any
) -> None:
    handle = handle_of(open_bytes(fixture_pdf("layers").read_bytes()))
    reply = set_visible(handle, layer_id(handle, "Hidden layer"), True)
    layers = ok(reply)["layers"]
    assert [(layer["name"], layer["visible"]) for layer in layers] == [
        ("Shown layer", True),
        ("Hidden layer", True),
    ]
    changed = [event for event in reply["events"] if event["kind"] == "changed"]
    assert len(changed) == 1
    session = REGISTRY.get(handle)
    assert changed[0]["revisions"] == {"0": session.document.page(0).revision}


def test_a_view_toggle_is_not_an_edit(web: None, fixture_pdf: Any) -> None:
    handle = handle_of(open_bytes(fixture_pdf("layers").read_bytes()))
    before = state(handle)
    reply = set_visible(handle, layer_id(handle, "Hidden layer"), True)
    assert "state" not in [event["kind"] for event in reply["events"]]
    session = REGISTRY.get(handle)
    assert session.is_dirty is False
    assert session.undo_stack.can_undo is False
    assert state(handle)[2:] == before[2:]  # dirty, undo label: unchanged


def test_an_unknown_layer_id_is_stale(web: None, fixture_pdf: Any) -> None:
    handle = handle_of(open_bytes(fixture_pdf("layers").read_bytes()))
    before = snapshot(handle)
    reply = set_visible(handle, 999_999, True)
    assert failure(reply)["code"] == "STALE_OBJECT"
    assert_refused_without_mutation(handle, reply, before)


def test_a_locked_layer_is_refused(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle = handle_of(open_bytes(fixture_pdf("layers").read_bytes()))
    session = REGISTRY.get(handle)
    locked = [LayerInfo(id=7, name="Locked", visible=True, locked=True)]
    monkeypatch.setattr(session.document, "layers", lambda: locked)
    calls: list[tuple[int, bool]] = []

    def spy(layer_id: int, visible: bool) -> None:
        calls.append((layer_id, visible))

    monkeypatch.setattr(session.document, "set_layer_visible", spy)
    before = snapshot(handle)
    reply = set_visible(handle, 7, False)
    error = failure(reply)
    assert error["code"] == "REFUSED"
    assert error["details"] == {"reason": "layer_locked"}
    assert calls == []  # the engine's mutation was never reached
    assert_refused_without_mutation(handle, reply, before)


def test_a_backend_without_layers_refuses(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle = handle_of(open_bytes(fixture_pdf("layers").read_bytes()))
    session = REGISTRY.get(handle)
    no_layers = SimpleNamespace(capabilities=SimpleNamespace(layers=False))
    monkeypatch.setattr(session, "engine", no_layers)
    before = snapshot(handle)
    reply = set_visible(handle, 1, True)
    error = failure(reply)
    assert error["code"] == "REFUSED"
    assert error["details"] == {"reason": "layers_unsupported"}
    assert_refused_without_mutation(handle, reply, before)


def test_a_hidden_layer_shown_in_the_view_is_saved_hidden(web: None, fixture_pdf: Any) -> None:
    """Round trip: showing a layer in the view writes nothing, so the saved copy keeps the file's
    default (the layer is off in /OCProperties /D /OFF, and its red box is not drawn)."""
    handle = handle_of(open_bytes(fixture_pdf("layers").read_bytes()))
    set_visible(handle, layer_id(handle, "Hidden layer"), True)
    reply, out = call_raw("save.save_bytes", {"handle": handle, "mode": "copy"})
    ok(reply)
    (saved,) = out
    record("ocg_default_off_pikepdf", saved, layer="Hidden layer")
    record("no_red_pixels_pdfium", saved, page=0, clip=[100.0, 150.0, 110.0, 160.0])
    record("render_first_page_pdfium", saved)
    reopened = handle_of(open_bytes(saved))
    layers = ok(call("layers.list", {"handle": reopened}))["layers"]
    assert [(layer["name"], layer["visible"]) for layer in layers] == [
        ("Shown layer", True),
        ("Hidden layer", False),
    ]
