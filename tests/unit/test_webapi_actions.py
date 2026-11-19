"""The actions calls of W3.5 through dispatch: run a named action, undo, redo, the dirty state,
the change events and their errors (W1.2 sections 4, 7 and 12, W1.3 section 2)."""

from __future__ import annotations

import json
import struct
import zlib
from collections.abc import Iterator
from typing import Any

import pytest

from pdfeditor import actions as action_layer
from pdfeditor.actions.base import ActionResult, ActionSpec, StaleObject
from pdfeditor.actions.pages import RotatePages
from pdfeditor.model import platform as model_platform
from pdfeditor.webapi import dispatch
from pdfeditor.webapi.errors import (
    BUSY,
    INTERNAL,
    INVALID_ARGS,
    NO_DOCUMENT,
    NOT_SUPPORTED,
    PASSWORD_REQUIRED,
    REFUSED,
    STALE_OBJECT,
)
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.hostcheck import record

ROTATE_RIGHT = "Rotate Page Right"


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
) -> tuple[dict[str, Any], str, list[bytes]]:
    request = json.dumps({"v": 1, "id": 9, "method": method, "params": params})
    reply_json, out = dispatch(request, buffers or [])
    return json.loads(reply_json), reply_json, out


def call(method: str, params: dict[str, Any]) -> dict[str, Any]:
    reply, _, _ = call_raw(method, params)
    return reply


def ok(reply: dict[str, Any]) -> dict[str, Any]:
    assert reply["ok"] is True, reply
    result: dict[str, Any] = reply["result"]
    return result


def error(reply: dict[str, Any]) -> dict[str, Any]:
    assert reply["ok"] is False, reply
    err: dict[str, Any] = reply["error"]
    return err


def open_bytes(fixture_pdf: Any, name: str = "text_multipage") -> str:
    data = fixture_pdf(name).read_bytes()
    reply, _, out = call_raw(
        "session.open",
        {"name": f"{name}.pdf", "data": {"$bin": 0}, "password": None},
        [data],
    )
    assert out == []
    return str(ok(reply)["handle"])


def page_count(handle: str) -> int:
    return int(ok(call("session.info", {"handle": handle}))["page_count"])


def rotation_of(handle: str, page: int) -> int:
    pages: list[dict[str, Any]] = ok(call("session.pages", {"handle": handle}))["pages"]
    return int(pages[page]["rotation"])


def revision_of(handle: str, page: int) -> int:
    return int(ok(call("text.layer", {"handle": handle, "page": page}))["revision"])


def rotate(handle: str, delta: int = 90, pages: list[int] | None = None) -> dict[str, Any]:
    return call(
        "actions.run",
        {
            "handle": handle,
            "name": "pages.rotate",
            "args": {"pages": pages if pages is not None else [0], "delta": delta},
        },
    )


def undo(handle: str) -> dict[str, Any]:
    return call("actions.undo", {"handle": handle})


def redo(handle: str) -> dict[str, Any]:
    return call("actions.redo", {"handle": handle})


def test_a_page_action_runs_and_reports_the_change(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf)
    before = revision_of(handle, 0)
    result = ok(rotate(handle))
    assert result["label"] == ROTATE_RIGHT
    assert result["executed"] is True
    assert result["value"] is None
    changed = result["changed"]
    assert changed is not None
    assert {c["kind"] for c in changed["changes"]} == {"structure"}
    assert changed["revisions"]["0"] > before
    assert changed["revisions"]["0"] == revision_of(handle, 0)
    state = result["state"]
    assert state["dirty"] is True
    assert state["can_undo"] is True and state["can_redo"] is False
    assert state["undo_label"] == ROTATE_RIGHT and state["redo_label"] == ""
    assert state["page_count"] == page_count(handle)
    assert state["structure_version"] == 1  # a rotate is a snapshot step: a structure change


def test_undo_restores_the_previous_state_and_redo_applies_it_again(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_bytes(fixture_pdf)
    ok(rotate(handle, 90))
    assert rotation_of(handle, 0) == 90

    undone = ok(undo(handle))
    assert undone["done"] is True
    assert undone["label"] == ROTATE_RIGHT
    assert undone["changed"] is not None
    assert undone["state"]["can_undo"] is False
    assert undone["state"]["can_redo"] is True
    assert undone["state"]["redo_label"] == ROTATE_RIGHT
    assert rotation_of(handle, 0) == 0

    redone = ok(redo(handle))
    assert redone["done"] is True
    assert redone["label"] == ROTATE_RIGHT
    assert redone["state"]["undo_label"] == ROTATE_RIGHT
    assert redone["state"]["redo_label"] == ""
    assert rotation_of(handle, 0) == 90


def test_dirty_flag_follows_the_undo_stack_back_to_the_opened_state(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_bytes(fixture_pdf)
    assert ok(undo(handle))["state"]["dirty"] is False  # opened clean, nothing to undo
    assert ok(rotate(handle))["state"]["dirty"] is True
    assert ok(undo(handle))["state"]["dirty"] is False  # undone to the opened state
    assert ok(redo(handle))["state"]["dirty"] is True


def test_undo_with_an_empty_stack_is_a_clear_reply(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf)
    result = ok(undo(handle))
    assert result["done"] is False
    assert result["label"] == ""
    assert result["changed"] is None
    assert result["state"]["can_undo"] is False
    assert result["state"]["structure_version"] == 0
    redo_result = ok(redo(handle))
    assert redo_result["done"] is False and redo_result["changed"] is None


def test_a_new_edit_clears_the_redo_branch(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf)
    ok(rotate(handle, 90))
    ok(undo(handle))
    ok(rotate(handle, 270))
    state = ok(redo(handle))["state"]
    assert state["can_redo"] is False
    assert rotation_of(handle, 0) == 270


def test_the_same_sequence_gives_the_same_replies(web: None, fixture_pdf: Any) -> None:
    def replies(handle: str) -> list[dict[str, Any]]:
        return [rotate(handle, 90), undo(handle), redo(handle), undo(handle), undo(handle)]

    first = [ok(r) for r in replies(open_bytes(fixture_pdf))]
    second = [ok(r) for r in replies(open_bytes(fixture_pdf))]
    assert first == second


def test_an_unknown_action_is_invalid_args_with_the_name_path(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf)
    err = error(call("actions.run", {"handle": handle, "name": "pages.nope", "args": {}}))
    assert err["code"] == INVALID_ARGS
    assert err["details"] == {"path": "params.name"}


@pytest.mark.parametrize(
    ("args", "path"),
    [
        ({"pages": "0", "delta": 90}, "args.pages"),
        ({"pages": [0]}, "args.delta"),
        ({"pages": [0], "delta": 90, "extra": 1}, "args.extra"),
        ({"pages": [0], "delta": 90.5}, "args.delta"),
        ({"pages": [0, "1"], "delta": 90}, "args.pages[1]"),
    ],
)
def test_bad_arguments_are_invalid_args_with_the_field_path(
    web: None, fixture_pdf: Any, args: dict[str, Any], path: str
) -> None:
    handle = open_bytes(fixture_pdf)
    err = error(call("actions.run", {"handle": handle, "name": "pages.rotate", "args": args}))
    assert err["code"] == INVALID_ARGS
    assert err["details"] == {"path": path}


def test_arguments_must_be_an_object(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf)
    err = error(call("actions.run", {"handle": handle, "name": "pages.rotate", "args": [1]}))
    assert err["code"] == INVALID_ARGS
    assert err["details"] == {"path": "params.args"}


def test_an_action_refused_by_the_layer_is_refused_with_its_reason(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_bytes(fixture_pdf)
    everything = list(range(page_count(handle)))
    err = error(
        call(
            "actions.run", {"handle": handle, "name": "pages.delete", "args": {"pages": everything}}
        )
    )
    assert err["code"] == REFUSED
    assert err["details"]["reason"] == "A document must keep at least one page."
    assert page_count(handle) == len(everything)  # nothing was changed


def test_an_action_the_web_does_not_have_is_not_supported(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The web platform turns signing off (W1.1 section 3). No registered action needs it yet,
    # so a test action stands in for one.
    spec = ActionSpec(name="test.sign", args=RotatePages, fn=_never, requires=("signing",))
    monkeypatch.setitem(action_layer.REGISTRY, "test.sign", spec)
    handle = open_bytes(fixture_pdf)
    err = error(
        call(
            "actions.run",
            {"handle": handle, "name": "test.sign", "args": {"pages": [0], "delta": 90}},
        )
    )
    assert err["code"] == NOT_SUPPORTED
    names = ok(call("actions.available", {"handle": handle}))["names"]
    assert "test.sign" not in names
    assert "pages.rotate" in names


def test_a_busy_document_refuses_actions_and_undo_with_the_task(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_bytes(fixture_pdf)
    ok(rotate(handle, 90))
    session = REGISTRY.get(handle)
    session.begin_task("OCR")
    try:
        err = error(rotate(handle, 90))
        assert err["code"] == BUSY
        assert err["details"] == {"task": "OCR"}
        err = error(undo(handle))
        assert err["code"] == BUSY
        assert err["details"] == {"task": "OCR"}
    finally:
        session.end_task("OCR")
    assert ok(undo(handle))["done"] is True  # the refused undo changed nothing


def test_a_stale_object_from_the_layer_is_stale_object(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    spec = ActionSpec(name="test.stale", args=RotatePages, fn=_stale, requires=())
    monkeypatch.setitem(action_layer.REGISTRY, "test.stale", spec)
    handle = open_bytes(fixture_pdf)
    err = error(
        call(
            "actions.run",
            {"handle": handle, "name": "test.stale", "args": {"pages": [0], "delta": 90}},
        )
    )
    assert err["code"] == STALE_OBJECT


def test_an_unexpected_error_is_internal_without_a_traceback(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    spec = ActionSpec(name="test.crash", args=RotatePages, fn=_crash, requires=())
    monkeypatch.setitem(action_layer.REGISTRY, "test.crash", spec)
    handle = open_bytes(fixture_pdf)
    err = error(
        call(
            "actions.run",
            {"handle": handle, "name": "test.crash", "args": {"pages": [0], "delta": 90}},
        )
    )
    assert err["code"] == INTERNAL
    assert "secret detail" not in err["message"]


def test_an_unknown_handle_is_no_document(web: None) -> None:
    err = error(call("actions.undo", {"handle": "nope"}))
    assert err["code"] == NO_DOCUMENT


def test_available_lists_the_page_actions_on_the_web(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf)
    names = ok(call("actions.available", {"handle": handle}))["names"]
    assert "pages.rotate" in names
    assert list(names) == sorted(names)


def test_insert_blank_and_duplicate_change_the_page_count_and_undo_restores(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_bytes(fixture_pdf)
    count = page_count(handle)
    blank = ok(
        call("actions.run", {"handle": handle, "name": "pages.insert_blank", "args": {"at": 1}})
    )
    assert blank["executed"] is True and blank["label"] == "Insert Blank Page"
    assert blank["changed"] is not None
    assert blank["state"]["page_count"] == count + 1
    assert page_count(handle) == count + 1
    copies = ok(
        call(
            "actions.run",
            {"handle": handle, "name": "pages.duplicate", "args": {"pages": [0, 2]}},
        )
    )
    assert copies["executed"] is True and copies["changed"] is not None
    assert copies["state"]["page_count"] == count + 3
    assert page_count(handle) == count + 3
    assert ok(undo(handle))["done"] is True
    assert page_count(handle) == count + 1
    assert ok(undo(handle))["done"] is True
    assert page_count(handle) == count


def _png(width: int = 4, height: int = 4) -> bytes:
    """A small red PNG, written out by hand so the test needs no imaging library."""
    rows = b"".join(b"\x00" + b"\xff\x00\x00" * width for _ in range(height))

    def chunk(tag: bytes, body: bytes) -> bytes:
        crc = zlib.crc32(tag + body) & 0xFFFFFFFF
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", crc)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(rows))
        + chunk(b"IEND", b"")
    )


def insert_file(
    handle: str, data: bytes, name: str, at: int, password: str | None = None
) -> dict[str, Any]:
    """The reply of pages.insert_file, with the file's bytes as the call's first buffer."""
    reply, _, _ = call_raw(
        "actions.run",
        {
            "handle": handle,
            "name": "pages.insert_file",
            "args": {
                "data": {"$bin": 0},
                "name": name,
                "at": at,
                "pages": None,
                "password": password,
            },
        },
        [data],
    )
    return reply


def test_insert_file_adds_a_pdfs_pages_and_undo_restores(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf)
    count = page_count(handle)
    source = fixture_pdf("images").read_bytes()
    result = ok(insert_file(handle, source, "images.pdf", 1))
    inserted = result["value"]
    assert result["executed"] is True and inserted > 0
    assert page_count(handle) == count + inserted
    reply, _, out = call_raw("save.save_bytes", {"handle": handle, "mode": "copy"})
    assert ok(reply)["verified"] is True
    record("page_count_pikepdf", out[0], pages=count + inserted)
    record("page_count_pdfium", out[0], pages=count + inserted)
    assert ok(undo(handle))["done"] is True
    assert page_count(handle) == count


def test_insert_file_adds_an_image_as_one_page(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf)
    count = page_count(handle)
    result = ok(insert_file(handle, _png(), "scan.png", 2))
    assert result["value"] == 1
    assert page_count(handle) == count + 1


def test_an_encrypted_source_needs_its_password_and_changes_nothing_without_it(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_bytes(fixture_pdf)
    count = page_count(handle)
    secret = fixture_pdf("encrypted").read_bytes()
    for password in (None, "wrong"):
        err = error(insert_file(handle, secret, "secret.pdf", 1, password))
        assert err["code"] == PASSWORD_REQUIRED
        assert page_count(handle) == count
    result = ok(insert_file(handle, secret, "secret.pdf", 1, "user"))
    assert result["value"] == 1
    assert page_count(handle) == count + 1


def _never(session: Any, args: Any) -> ActionResult[None]:
    raise AssertionError("an action the web does not have must not run")


def _stale(session: Any, args: Any) -> ActionResult[None]:
    raise StaleObject("the page changed")


def _crash(session: Any, args: Any) -> ActionResult[None]:
    raise RuntimeError("secret detail")
