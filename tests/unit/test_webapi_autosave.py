"""The autosave call of W3.9 (``save.autosave_bytes``) through dispatch, on fixtures.

The bytes it returns are reopened in MuPDF and checked in pikepdf (page count, the rotation of an
edit) and rendered in pypdfium2 (the round-trip rule in AGENTS.md). Those checks go through
``tests.hostcheck.record``, so they also run under Pyodide, which has neither library.
"""

from __future__ import annotations

import dataclasses
import json
from collections.abc import Iterator
from typing import Any

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.model.metadata import EncryptionMethod
from pdfeditor.webapi import dispatch, limits
from pdfeditor.webapi.errors import BUSY, FILE_TOO_LARGE, NO_DOCUMENT
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.hostcheck import record


@pytest.fixture
def web() -> Iterator[None]:
    previous = model_platform.current()
    configure_web()
    try:
        yield
    finally:
        REGISTRY.close_all()
        model_platform.configure(previous)


def call_raw(
    method: str, params: dict[str, Any], buffers: list[bytes] | None = None
) -> tuple[dict[str, Any], list[bytes]]:
    request = json.dumps({"v": 1, "id": 7, "method": method, "params": params})
    reply_json, out = dispatch(request, buffers or [])
    return json.loads(reply_json), out


def call(method: str, params: dict[str, Any]) -> dict[str, Any]:
    reply, _ = call_raw(method, params)
    return reply


def ok(reply: dict[str, Any]) -> dict[str, Any]:
    assert reply["ok"] is True, reply
    result: dict[str, Any] = reply["result"]
    return result


def error(reply: dict[str, Any]) -> dict[str, Any]:
    assert reply["ok"] is False, reply
    err: dict[str, Any] = reply["error"]
    return err


def open_data(data: bytes, name: str = "doc.pdf", password: str | None = None) -> str:
    reply, out = call_raw(
        "session.open",
        {"name": name, "data": {"$bin": 0}, "password": password},
        [data],
    )
    assert out == []
    return str(ok(reply)["handle"])


def autosave(handle: str) -> tuple[dict[str, Any], bytes]:
    """save.autosave_bytes of an unprotected document: its result and its bytes."""
    reply, out = call_raw("save.autosave_bytes", {"handle": handle})
    result = ok(reply)
    assert result["skipped"] is None
    assert result["data"] == {"$bin": 0}  # binary, not base64
    assert len(out) == 1
    assert result["size"] == len(out[0])
    return result, out[0]


def page_total(handle: str) -> int:
    return int(ok(call("session.info", {"handle": handle}))["page_count"])


def rotate(handle: str, delta: int = 90) -> dict[str, Any]:
    return call(
        "actions.run",
        {"handle": handle, "name": "pages.rotate", "args": {"pages": [0], "delta": delta}},
    )


def test_autosave_reopens_in_mupdf_pikepdf_and_pdfium(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("images").read_bytes(), "images.pdf")
    _, saved = autosave(handle)
    assert saved.startswith(b"%PDF")
    reopened = open_data(saved, "copy.pdf")  # MuPDF reads what it wrote
    assert page_total(reopened) == page_total(handle)
    record("page_count_pikepdf", saved, pages=page_total(handle))
    record("render_width_pdfium", saved, scale=0.5)


def test_autosave_keeps_an_edit(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("images").read_bytes())
    assert ok(rotate(handle))["executed"] is True
    _, saved = autosave(handle)
    record("rotation_pikepdf", saved, page=0, degrees=90)


def test_autosave_changes_no_state_and_emits_no_event(web: None, fixture_pdf: Any) -> None:
    # An autosave is not a save (W1.2 section 12): the dirty flag, the undo step and the saved
    # fingerprint stay as they were, and the reply carries no events for the front end.
    handle = open_data(fixture_pdf("images").read_bytes())
    assert ok(rotate(handle))["executed"] is True
    session = REGISTRY.get(handle)
    before = (session.is_dirty, session.undo_stack.can_undo, session.undo_stack.undo_label)
    assert before[:2] == (True, True)
    fingerprint = REGISTRY.saved_fingerprint(handle)
    reply, _ = call_raw("save.autosave_bytes", {"handle": handle})
    assert ok(reply)["skipped"] is None
    assert reply["events"] == []
    assert (session.is_dirty, session.undo_stack.can_undo, session.undo_stack.undo_label) == before
    assert REGISTRY.saved_fingerprint(handle) == fingerprint


def test_a_password_protected_document_is_skipped(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("encrypted").read_bytes(), "encrypted.pdf", password="user")
    reply, out = call_raw("save.autosave_bytes", {"handle": handle})
    assert ok(reply)["skipped"] == "protected"
    assert ok(reply)["size"] == 0
    assert all(buffer == b"" for buffer in out)  # no plain text of a protected document


def test_an_encrypted_document_without_a_password_is_skipped(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    # An owner-only encryption opens without a password, so the password check alone misses it.
    handle = open_data(fixture_pdf("images").read_bytes())
    document = REGISTRY.get(handle).document
    original = document.info()
    monkeypatch.setattr(
        document,
        "info",
        lambda: dataclasses.replace(original, encryption=EncryptionMethod.AES_128),
    )
    reply, out = call_raw("save.autosave_bytes", {"handle": handle})
    assert ok(reply)["skipped"] == "protected"
    assert all(buffer == b"" for buffer in out)


def test_a_busy_document_refuses_with_busy(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("images").read_bytes())
    session = REGISTRY.get(handle)
    session.begin_task("Optimize")
    try:
        err = error(call("save.autosave_bytes", {"handle": handle}))
    finally:
        session.end_task("Optimize")
    assert err["code"] == BUSY
    assert err["details"] == {"task": "Optimize"}


def test_an_autosave_over_the_limit_is_refused(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle = open_data(fixture_pdf("images").read_bytes())
    _, saved = autosave(handle)
    size = len(saved)
    monkeypatch.setattr(limits, "MAX_SAVE_BYTES", size - 1)
    reply, out = call_raw("save.autosave_bytes", {"handle": handle})
    err = error(reply)
    assert err["code"] == FILE_TOO_LARGE
    assert err["details"]["max_bytes"] == size - 1
    assert out == []


def test_an_autosave_at_the_limit_succeeds(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle = open_data(fixture_pdf("images").read_bytes())
    _, saved = autosave(handle)
    monkeypatch.setattr(limits, "MAX_SAVE_BYTES", len(saved))
    result, again = autosave(handle)
    assert result["size"] == len(again)


def test_a_document_above_the_autosave_cap_is_skipped(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    # W3.9 decision D5: no copy is kept above FILE_WARN_BYTES, although a save may be larger.
    handle = open_data(fixture_pdf("images").read_bytes())
    _, saved = autosave(handle)
    monkeypatch.setattr(limits, "FILE_WARN_BYTES", len(saved) - 1)
    result = ok(call("save.autosave_bytes", {"handle": handle}))
    assert result["skipped"] == "too_large"
    assert result["size"] == 0


def test_an_autosave_of_a_closed_handle_is_no_document(web: None) -> None:
    err = error(call("save.autosave_bytes", {"handle": "0" * 32}))
    assert err["code"] == NO_DOCUMENT
