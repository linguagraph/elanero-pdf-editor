"""The memory call of W3.9 (``system.memory``) through dispatch.

The wasm heap is read only under Pyodide, so the desktop run checks the None it returns and the
Pyodide run checks the int. The other tests replace the probe to pass a value through.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import pytest

from pdfeditor.core.commands.snapshot import SNAPSHOT_OPTIONS, SnapshotCommand
from pdfeditor.model import platform as model_platform
from pdfeditor.webapi import dispatch, limits, memory
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.hostcheck import in_pyodide


@pytest.fixture
def web() -> Iterator[None]:
    previous = model_platform.current()
    configure_web()
    try:
        yield
    finally:
        REGISTRY.close_all()
        model_platform.configure(previous)


def call(method: str, params: dict[str, Any], buffers: list[bytes] | None = None) -> dict[str, Any]:
    request = json.dumps({"v": 1, "id": 7, "method": method, "params": params})
    reply_json, out = dispatch(request, buffers or [])
    assert out == []
    reply: dict[str, Any] = json.loads(reply_json)
    assert reply["ok"] is True, reply
    result: dict[str, Any] = reply["result"]
    return result


def open_fixture(data: bytes) -> str:
    result = call(
        "session.open", {"name": "doc.pdf", "data": {"$bin": 0}, "password": None}, [data]
    )
    return str(result["handle"])


def test_the_heap_is_none_on_desktop_and_an_int_under_pyodide(web: None) -> None:
    value = memory.wasm_heap_bytes()
    if in_pyodide():
        assert isinstance(value, int)
        assert value > 0
    else:
        assert value is None


def test_the_probe_value_is_passed_through(web: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(memory, "_probe", lambda: 123_456)
    assert call("system.memory", {})["wasm_heap_bytes"] == 123_456


def test_an_unreadable_heap_is_null(web: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(memory, "_probe", lambda: None)
    assert call("system.memory", {})["wasm_heap_bytes"] is None


def test_the_warning_limit_comes_from_limits(web: None) -> None:
    assert call("system.memory", {})["heap_warn_bytes"] == limits.HEAP_WARN_BYTES
    assert limits.HEAP_WARN_BYTES == 1536 * 1024**2


def test_documents_count_the_open_handles(web: None, fixture_pdf: Any) -> None:
    before = call("system.memory", {})["documents"]
    open_fixture(fixture_pdf("images").read_bytes())
    assert call("system.memory", {})["documents"] == before + 1


def test_snapshot_bytes_grow_with_an_undo_snapshot(web: None, fixture_pdf: Any) -> None:
    handle = open_fixture(fixture_pdf("images").read_bytes())
    assert call("system.memory", {})["snapshot_bytes"] == 0

    session = REGISTRY.get(handle)
    with session.lock:
        before = session.document.to_bytes(SNAPSHOT_OPTIONS)
    command = SnapshotCommand("Resize", lambda doc: doc.load_state(before), session.snapshots)
    assert session.execute(command)

    snapshot = call("system.memory", {})["snapshot_bytes"]
    assert snapshot > 0
    assert snapshot == session.undo_stack.disk_bytes
