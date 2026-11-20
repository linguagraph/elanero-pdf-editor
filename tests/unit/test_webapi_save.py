"""The save call of W3.6 (``save.save_bytes``) through dispatch, on fixtures.

The bytes it returns are reopened in pikepdf (page count, /Rotate) and rendered in pypdfium2
(the round-trip rule in AGENTS.md). Those checks go through ``tests.hostcheck.record``: they run
inline on desktop and are replayed on host CPython under Pyodide, which has neither library.
The signed sample is read only: it is the committed
self-signed file, and nothing here signs or opens a certificate from the Windows store.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from pdfeditor.core.session import DocumentSession
from pdfeditor.model import platform as model_platform
from pdfeditor.webapi import dispatch, limits
from pdfeditor.webapi.errors import BUSY, FILE_TOO_LARGE, INVALID_ARGS, NO_DOCUMENT, SAVE_FAILED
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.hostcheck import record

SIGNED = Path(__file__).parent.parent / "fixtures" / "real" / "signed_selfsigned.pdf"


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


def save(handle: str, mode: str) -> tuple[dict[str, Any], list[bytes]]:
    """The reply of save.save_bytes: the JSON reply and the reply's buffers."""
    return call_raw("save.save_bytes", {"handle": handle, "mode": mode})


def saved_bytes(handle: str, mode: str) -> tuple[dict[str, Any], bytes]:
    reply, out = save(handle, mode)
    result = ok(reply)
    assert len(out) == 1
    assert result["data"] == {"$bin": 0}  # binary, not base64
    assert result["size"] == len(out[0])
    assert result["verified"] is True
    return result, out[0]


def page_total(handle: str) -> int:
    return int(ok(call("session.info", {"handle": handle}))["page_count"])


def rotate(handle: str, delta: int = 90) -> dict[str, Any]:
    return call(
        "actions.run",
        {
            "handle": handle,
            "name": "pages.rotate",
            "args": {"pages": [0], "delta": delta},
        },
    )


def test_full_save_reopens_in_pikepdf_and_renders_in_pdfium(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("images").read_bytes(), "images.pdf")
    result, saved = saved_bytes(handle, "copy")
    assert saved.startswith(b"%PDF")
    assert result["incremental"] is False
    assert result["name"] == "images.pdf"
    record("page_count_pikepdf", saved, pages=page_total(handle))
    record("render_width_pdfium", saved, scale=0.5)


def test_in_place_unsigned_document_is_a_full_save(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("images").read_bytes())
    result, saved = saved_bytes(handle, "in_place")
    assert result["incremental"] is False
    record("page_count_pikepdf", saved, pages=page_total(handle))


def test_edit_then_save_contains_the_change(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("images").read_bytes())
    assert ok(rotate(handle))["executed"] is True
    result, saved = saved_bytes(handle, "copy")
    record("rotation_pikepdf", saved, page=0, degrees=90)
    assert result["incremental"] is False


def test_signed_save_is_incremental_and_keeps_the_signature(web: None) -> None:
    original = SIGNED.read_bytes()
    handle = open_data(original, "signed.pdf")
    assert ok(call("session.info", {"handle": handle}))["has_signatures"] is True
    assert ok(rotate(handle))["executed"] is True
    result, saved = saved_bytes(handle, "in_place")
    assert result["incremental"] is True
    assert saved.startswith(original)  # the signed bytes are untouched; the change is appended
    record("page_count_pikepdf", saved, pages=page_total(handle))
    record("render_width_pdfium", saved, scale=0.5)


def test_copy_of_a_signed_document_is_a_full_rewrite(web: None) -> None:
    original = SIGNED.read_bytes()
    handle = open_data(original, "signed.pdf")
    result, saved = saved_bytes(handle, "copy")
    assert result["incremental"] is False
    assert not saved.startswith(original)


def test_a_second_change_after_an_incremental_save_is_refused(web: None) -> None:
    handle = open_data(SIGNED.read_bytes(), "signed.pdf")
    assert ok(rotate(handle))["executed"] is True
    saved_bytes(handle, "in_place")
    assert ok(rotate(handle, 180))["executed"] is True
    err = error(save(handle, "in_place")[0])
    assert err["code"] == SAVE_FAILED  # the core's once-per-lineage rule (W1.1 section 4)
    # The copy still works: it is a full rewrite and needs no lineage.
    _, saved = saved_bytes(handle, "copy")
    record("page_count_pikepdf", saved, pages=page_total(handle))


def test_undo_stack_and_dirty_flag_are_unchanged_by_a_save(web: None, fixture_pdf: Any) -> None:
    # A save is not a Command (W1.2 section 4): the dirty flag stays as it was, because the main
    # thread calls save.mark_saved after a successful write, as the desktop clears it after save.
    handle = open_data(fixture_pdf("images").read_bytes())
    assert ok(rotate(handle))["executed"] is True
    session = REGISTRY.get(handle)
    before = (session.is_dirty, session.undo_stack.can_undo, session.undo_stack.undo_label)
    assert before[:2] == (True, True)
    label = before[2]
    saved_bytes(handle, "copy")
    saved_bytes(handle, "in_place")
    assert (session.is_dirty, session.undo_stack.can_undo, session.undo_stack.undo_label) == before
    undone = ok(call("actions.undo", {"handle": handle}))
    assert undone["done"] is True
    assert undone["label"] == label


def test_saving_an_unchanged_document_twice_gives_the_same_output(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_data(fixture_pdf("images").read_bytes())
    _, first = saved_bytes(handle, "copy")
    _, second = saved_bytes(handle, "copy")
    # MuPDF's full-save output is not byte-stable (measured: same size, different bytes, most
    # likely the trailer's random /ID), so the test asserts equal page counts, not equal bytes.
    record("page_count_pikepdf", first, pages=page_total(handle))
    record("page_count_pikepdf", second, pages=page_total(handle))


def test_an_encrypted_document_is_saved_and_verified_with_its_password(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_data(fixture_pdf("encrypted").read_bytes(), "encrypted.pdf", password="user")
    result, saved = saved_bytes(handle, "copy")
    assert result["verified"] is True
    assert saved.startswith(b"%PDF")
    record("refuses_without_password_pikepdf", saved)  # still encrypted
    record("encrypted_pages_pikepdf", saved, pages=1, password="user")


def test_unknown_handle_is_no_document(web: None) -> None:
    err = error(save("0" * 32, "copy")[0])
    assert err["code"] == NO_DOCUMENT


def test_a_bad_mode_is_invalid_args(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("images").read_bytes())
    err = error(save(handle, "print")[0])
    assert err["code"] == INVALID_ARGS
    assert err["details"]["path"] == "params.mode"


def test_a_busy_document_refuses_with_busy(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("images").read_bytes())
    session = REGISTRY.get(handle)
    session.begin_task("Optimize")
    try:
        err = error(save(handle, "copy")[0])
    finally:
        session.end_task("Optimize")
    assert err["code"] == BUSY
    assert err["details"] == {"task": "Optimize"}


def test_an_output_over_the_limit_is_refused(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle = open_data(fixture_pdf("images").read_bytes())
    monkeypatch.setattr(limits, "MAX_SAVE_BYTES", 100)
    reply, out = save(handle, "copy")
    err = error(reply)
    assert err["code"] == FILE_TOO_LARGE
    assert err["details"]["max_bytes"] == 100
    assert err["details"]["size"] > 100
    assert out == []  # no bytes come back with the refusal


def test_a_failed_reopen_refuses_the_save(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle = open_data(fixture_pdf("images").read_bytes())
    assert ok(rotate(handle))["executed"] is True
    session: DocumentSession = REGISTRY.get(handle)

    def broken_open(*args: object, **kwargs: object) -> object:
        raise RuntimeError("the output is not a PDF")

    monkeypatch.setattr(session.engine, "open", broken_open)
    reply, out = save(handle, "copy")
    err = error(reply)
    assert err["code"] == SAVE_FAILED
    assert out == []  # unverified bytes are never returned
    assert session.is_dirty  # a failed save leaves the document as it was


def test_a_page_count_mismatch_on_reopen_refuses_the_save(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle = open_data(fixture_pdf("images").read_bytes())
    session: DocumentSession = REGISTRY.get(handle)

    class _Wrong:
        page_count = 99
        is_repaired = False

        def close(self) -> None:
            pass

    monkeypatch.setattr(session.engine, "open", lambda data, password=None: _Wrong())
    err = error(save(handle, "copy")[0])
    assert err["code"] == SAVE_FAILED


def test_an_in_place_save_of_an_encrypted_document_keeps_its_password(
    web: None, fixture_pdf: Any
) -> None:
    # Both modes keep the encryption: the engine holds the open password and reopens the bytes
    # with it, so no owner password is needed to save (W4.8 S2).
    handle = open_data(fixture_pdf("encrypted").read_bytes(), "encrypted.pdf", password="user")
    assert ok(rotate(handle))["executed"] is True
    result, saved = saved_bytes(handle, "in_place")
    assert result["incremental"] is False
    record("refuses_without_password_pikepdf", saved)  # still encrypted
    record("encrypted_pages_pikepdf", saved, pages=1, password="user")
    reopened = open_data(saved, "saved.pdf", password="user")
    pages = ok(call("session.pages", {"handle": reopened}))["pages"]
    assert pages[0]["rotation"] == 90


def test_require_full_save_survives_mark_saved(web: None) -> None:
    # A sanitize leaves the in-memory document as the original plus the removal, so an incremental
    # update would append to the original and carry the removed content. The web's mark_saved does
    # not clear the flag (the desktop clears it only because its document is then the new file).
    # The sanitize action sets the same flag, but its scrub fails in MuPDF on this sample, so the
    # flag is set directly after a real edit.
    handle = open_data(SIGNED.read_bytes(), "signed.pdf")
    assert ok(rotate(handle))["executed"] is True
    session = REGISTRY.get(handle)
    session.require_full_save = True
    result, saved = saved_bytes(handle, "in_place")
    assert result["incremental"] is False
    record("page_count_pikepdf", saved, pages=page_total(handle))
    assert ok(call("save.mark_saved", {"handle": handle}))["saved"] is True
    assert session.require_full_save is True
    again, _ = saved_bytes(handle, "in_place")
    assert again["incremental"] is False
