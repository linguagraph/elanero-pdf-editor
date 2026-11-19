"""Password protection in the browser (W7.5, slice S2): ``session.security`` reads the security
state, and ``security.set`` / ``security.remove`` run through ``actions.run`` with one undo step.

Every saved file is checked on its own through ``tests.hostcheck.record``: pikepdf and pypdfium2
are independent of MuPDF, and this module imports neither at module level, so the host replay can
run it under Pyodide. The passwords used here are fake; the leak tests check that no reply or log
line carries them.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from typing import Any

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.webapi import dispatch, jobs
from pdfeditor.webapi.errors import INVALID_ARGS, REFUSED
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.actions.conftest import pretend_signed
from tests.hostcheck import record
from tests.unit.test_webapi_jobs import apply, prepare, run_job, sanitize_args

OPEN_PW = "open me"
OWNER_PW = "boss"
AES_128_PW = "open-128"  # AES-128 takes ASCII only (see actions/security.py)
UNICODE_PW = "pässwörd-密码"  # AES-256 only (UTF-8)
PERMISSION_KEYS = {
    "print",
    "modify",
    "copy",
    "annotate",
    "fill_forms",
    "accessibility",
    "assemble",
    "print_high_quality",
}
SECURITY_KEYS = {
    "encryption",
    "permissions",
    "owner_access",
    "pending",
    "pending_method",
    "has_signatures",
}


@pytest.fixture
def web() -> Iterator[None]:
    previous = model_platform.current()
    configure_web()
    try:
        yield
    finally:
        jobs.PREPARED.clear()
        REGISTRY.close_all()
        model_platform.configure(previous)


def call_raw(
    method: str, params: dict[str, Any], buffers: list[bytes] | None = None
) -> tuple[dict[str, Any], list[bytes]]:
    request = json.dumps({"v": 1, "id": 9, "method": method, "params": params})
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


def open_bytes(data: bytes, name: str = "doc.pdf", password: str | None = None) -> tuple[str, int]:
    """The handle and the page count of an opened document."""
    reply, _ = call_raw(
        "session.open", {"name": name, "data": {"$bin": 0}, "password": password}, [data]
    )
    result = ok(reply)
    return str(result["handle"]), int(result["pages"])


def security(handle: str) -> dict[str, Any]:
    result: dict[str, Any] = ok(call("session.security", {"handle": handle}))
    return result


def permissions(**allowed: bool) -> dict[str, bool]:
    """All eight permission flags, true unless named."""
    flags = {key: True for key in PERMISSION_KEYS}
    flags.update(allowed)
    return flags


def settings(
    method: str = "aes-256",
    user: str = OPEN_PW,
    owner: str = OWNER_PW,
    perms: dict[str, bool] | None = None,
) -> dict[str, Any]:
    return {
        "settings": {
            "method": method,
            "user_password": user,
            "owner_password": owner,
            "permissions": permissions() if perms is None else perms,
        }
    }


def set_security(handle: str, args: dict[str, Any]) -> dict[str, Any]:
    return call("actions.run", {"handle": handle, "name": "security.set", "args": args})


def remove_security(handle: str) -> dict[str, Any]:
    return call("actions.run", {"handle": handle, "name": "security.remove", "args": {}})


def save_copy(handle: str) -> bytes:
    reply, out = call_raw("save.save_bytes", {"handle": handle, "mode": "copy"})
    result = ok(reply)
    assert result["verified"] is True
    return out[result["data"]["$bin"]]


def encrypt_and_save(data: bytes, method: str, user: str, owner: str) -> tuple[str, bytes]:
    handle, _ = open_bytes(data, "report.pdf")
    ok(set_security(handle, settings(method, user, owner, permissions(print=False, copy=False))))
    return handle, save_copy(handle)


# -- session.security ------------------------------------------------------------------------


def test_security_state_of_a_plain_document(web: None, fixture_pdf: Any) -> None:
    handle, _ = open_bytes(fixture_pdf("report").read_bytes(), "report.pdf")
    state = security(handle)
    assert set(state) == SECURITY_KEYS
    assert state["encryption"] == "none"
    assert set(state["permissions"]) == PERMISSION_KEYS
    assert state["owner_access"] is True
    assert state["pending"] is None and state["pending_method"] is None
    assert state["has_signatures"] is False


def test_security_state_of_an_encrypted_document_follows_the_owner_password(
    web: None, fixture_pdf: Any
) -> None:
    handle, _ = open_bytes(fixture_pdf("encrypted").read_bytes(), "encrypted.pdf", "user")
    state = security(handle)  # opened with the user password only
    assert state["encryption"] == "aes-256"
    assert state["owner_access"] is False
    assert state["permissions"]["print"] is True and state["permissions"]["copy"] is False

    unlock = ok(call("session.unlock_owner", {"handle": handle, "password": "owner"}))
    assert unlock == {"unlocked": True}
    assert security(handle)["owner_access"] is True


def test_the_security_state_never_carries_a_password(web: None, fixture_pdf: Any) -> None:
    handle, _ = open_bytes(fixture_pdf("report").read_bytes(), "report.pdf")
    ok(set_security(handle, settings(user=OPEN_PW, owner=OWNER_PW)))
    state = security(handle)
    assert state["pending"] == "encrypt" and state["pending_method"] == "aes-256"
    text = json.dumps(state)
    assert OPEN_PW not in text and OWNER_PW not in text


# -- encrypt round trips ---------------------------------------------------------------------


def test_encrypt_round_trip_with_aes_256(web: None, fixture_pdf: Any) -> None:
    handle, pages = open_bytes(fixture_pdf("report").read_bytes(), "report.pdf")
    perms = permissions(print=False, copy=False)
    result = ok(set_security(handle, settings(perms=perms)))
    assert result["label"] == "Encrypt with Password"
    assert result["value"] is None

    queued = security(handle)
    assert queued["pending"] == "encrypt" and queued["pending_method"] == "aes-256"

    saved = save_copy(handle)
    record("refuses_without_password_pikepdf", saved)
    record("encrypted_pages_pikepdf", saved, pages=pages, password=OPEN_PW)
    record("encrypted_pages_pikepdf", saved, pages=pages, password=OWNER_PW)
    record(
        "permissions_pikepdf",
        saved,
        password=OPEN_PW,
        allowed={"print_lowres": False, "extract": False, "modify_other": True},
    )
    record("page_count_pdfium", saved, pages=pages, password=OPEN_PW)
    record("render_first_page_pdfium", saved, password=OPEN_PW)

    reopened, _ = open_bytes(saved, "report.pdf", OPEN_PW)
    state = security(reopened)
    assert state["encryption"] == "aes-256"
    assert state["permissions"]["print"] is False and state["permissions"]["copy"] is False


@pytest.mark.parametrize(
    ("method", "user", "owner", "password_for_reopen"),
    [
        ("aes-128", AES_128_PW, OWNER_PW, AES_128_PW),
        ("aes-256", UNICODE_PW, OWNER_PW, UNICODE_PW),
    ],
)
def test_encrypt_round_trip_with_each_method_and_password(
    web: None,
    fixture_pdf: Any,
    method: str,
    user: str,
    owner: str,
    password_for_reopen: str,
) -> None:
    _, saved = encrypt_and_save(fixture_pdf("report").read_bytes(), method, user, owner)
    record("encrypted_pages_pikepdf", saved, pages=2, password=password_for_reopen)
    record("encrypted_pages_pikepdf", saved, pages=2, password=owner)
    record("page_count_pdfium", saved, pages=2, password=password_for_reopen)
    record("render_first_page_pdfium", saved, password=password_for_reopen)

    reopened, _ = open_bytes(saved, "report.pdf", password_for_reopen)
    assert security(reopened)["encryption"] == method


# -- undo and redo --------------------------------------------------------------------------


def test_undo_and_redo_of_an_encryption_change_the_saved_file(web: None, fixture_pdf: Any) -> None:
    handle, pages = open_bytes(fixture_pdf("report").read_bytes(), "report.pdf")
    ok(set_security(handle, settings()))

    undone = ok(call("actions.undo", {"handle": handle}))
    assert undone["label"] == "Encrypt with Password"
    assert security(handle)["pending"] is None
    record("not_encrypted_pikepdf", save_copy(handle))

    redone = ok(call("actions.redo", {"handle": handle}))
    assert redone["done"] is True
    assert security(handle)["pending"] == "encrypt"
    saved = save_copy(handle)
    record("encrypted_pages_pikepdf", saved, pages=pages, password=OPEN_PW)


# -- remove -----------------------------------------------------------------------------------


def test_remove_needs_the_owner_password_then_removes_and_saves(
    web: None, fixture_pdf: Any
) -> None:
    handle, _ = open_bytes(fixture_pdf("encrypted").read_bytes(), "encrypted.pdf", "user")
    err = error(remove_security(handle))
    assert err["code"] == REFUSED
    assert err["details"] == {"reason": "owner_password_needed"}

    assert ok(call("session.unlock_owner", {"handle": handle, "password": "owner"}))["unlocked"]
    removed = ok(remove_security(handle))
    assert removed["label"] == "Remove Security" and removed["value"] is None
    state = security(handle)
    assert state["pending"] == "remove" and state["pending_method"] == "none"

    saved = save_copy(handle)
    record("not_encrypted_pikepdf", saved)
    record("text_contains_pdfium", saved, page=0, text="Secret content")
    reopened, _ = open_bytes(saved, "encrypted.pdf")  # no password needed any more
    assert security(reopened)["encryption"] == "none"


def test_remove_on_a_plain_document_is_no_security(web: None, fixture_pdf: Any) -> None:
    handle, _ = open_bytes(fixture_pdf("report").read_bytes(), "report.pdf")
    err = error(remove_security(handle))
    assert err["code"] == REFUSED
    assert err["details"] == {"reason": "no_security"}


def test_remove_drops_a_pending_encryption_without_an_owner_step(
    web: None, fixture_pdf: Any
) -> None:
    handle, _ = open_bytes(fixture_pdf("report").read_bytes(), "report.pdf")
    ok(set_security(handle, settings()))
    assert security(handle)["pending"] == "encrypt"

    ok(remove_security(handle))
    assert security(handle)["pending"] is None  # nothing is queued on a plain document
    record("not_encrypted_pikepdf", save_copy(handle))


# -- signed documents -------------------------------------------------------------------------


def test_both_actions_on_a_signed_document_are_refused_with_a_reason(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle, _ = open_bytes(fixture_pdf("report").read_bytes(), "report.pdf")
    pretend_signed(REGISTRY.get(handle), monkeypatch)

    for reply in (set_security(handle, settings()), remove_security(handle)):
        err = error(reply)
        assert err["code"] == REFUSED
        assert err["details"] == {"reason": "signed_document"}

    state = security(handle)
    assert state["has_signatures"] is True and state["pending"] is None
    assert REGISTRY.get(handle).undo_stack.can_undo is False


# -- invalid settings ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "args",
    [
        settings(method="rc4-128"),
        settings(method="unknown"),
        settings(user="", owner=""),
        settings(user="same", owner="same", perms=permissions(print=False)),
        settings(method="aes-256", user="ä" * 64, owner=OWNER_PW),  # 128 bytes in UTF-8
        settings(method="aes-128", user="密码", owner=OWNER_PW),  # not ASCII
        settings(method="aes-128", user=UNICODE_PW, owner=OWNER_PW),  # non-ASCII letters
        settings(method="aes-128", user="a" * 33, owner=OWNER_PW),  # over 32 characters
    ],
    ids=[
        "rc4",
        "unknown-method",
        "no-password",
        "equal-passwords",
        "aes256-over-127-bytes",
        "aes128-not-ascii",
        "aes128-non-ascii-letters",
        "aes128-over-32-chars",
    ],
)
def test_invalid_settings_are_refused_and_queue_nothing(
    web: None, fixture_pdf: Any, args: dict[str, Any]
) -> None:
    handle, _ = open_bytes(fixture_pdf("report").read_bytes(), "report.pdf")
    err = error(set_security(handle, args))
    assert err["code"] == REFUSED
    assert err["details"] == {"reason": "invalid_settings"}
    assert security(handle)["pending"] is None
    assert REGISTRY.get(handle).undo_stack.can_undo is False


def test_limits_at_the_boundary_are_accepted(web: None, fixture_pdf: Any) -> None:
    handle, _ = open_bytes(fixture_pdf("report").read_bytes(), "report.pdf")
    ok(set_security(handle, settings(method="aes-256", user="ä" * 63 + "b", owner=OWNER_PW)))
    ok(set_security(handle, settings(method="aes-128", user="a" * 32, owner=OWNER_PW)))
    assert security(handle)["pending_method"] == "aes-128"


def test_an_open_password_alone_may_repeat_as_the_owner_password(
    web: None, fixture_pdf: Any
) -> None:
    # The desktop sends owner = user for "open password only" (ui/dialogs/security.py).
    handle, _ = open_bytes(fixture_pdf("report").read_bytes(), "report.pdf")
    ok(set_security(handle, settings(user="same", owner="same")))
    assert security(handle)["pending"] == "encrypt"


def test_malformed_settings_are_invalid_args_with_their_path(web: None, fixture_pdf: Any) -> None:
    handle, _ = open_bytes(fixture_pdf("report").read_bytes(), "report.pdf")
    args = settings()
    args["settings"]["permissions"] = "x"
    err = error(set_security(handle, args))
    assert err["code"] == INVALID_ARGS


# -- a pending change and a mutating job -------------------------------------------------------


def test_a_pending_encryption_survives_a_mutating_job(web: None, fixture_pdf: Any) -> None:
    handle, pages = open_bytes(fixture_pdf("report").read_bytes(), "report.pdf")
    ok(set_security(handle, settings()))

    prepared, copy = prepare(handle, "action", sanitize_args())
    assert prepared["mutating"] is True
    reply, out = run_job("action", sanitize_args(), copy)
    result = ok(reply)
    document = out[result["document"]["$bin"]]
    assert ok(apply(handle, prepared["token"], document, result["label"], True))["applied"]

    assert security(handle)["pending"] == "encrypt"
    saved = save_copy(handle)
    record("encrypted_pages_pikepdf", saved, pages=pages, password=OPEN_PW)


# -- leaks ---------------------------------------------------------------------------------------


def test_no_reply_or_log_line_carries_a_password(
    web: None, fixture_pdf: Any, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    passwords = (OPEN_PW, OWNER_PW, AES_128_PW, UNICODE_PW)
    replies: list[dict[str, Any]] = []

    handle, _ = open_bytes(fixture_pdf("report").read_bytes(), "report.pdf")
    replies.append(set_security(handle, settings(user=OPEN_PW, owner=OWNER_PW)))
    replies.append(security(handle))
    replies.append(set_security(handle, settings(user=UNICODE_PW, owner=OWNER_PW)))
    replies.append(set_security(handle, settings(method="aes-128", user="ä" * 40, owner="")))
    replies.append(set_security(handle, settings(user="same", owner="same")))
    replies.append(
        set_security(handle, settings(method="aes-128", user=AES_128_PW, owner=OWNER_PW))
    )
    bad = settings(user=OPEN_PW, owner=OWNER_PW)
    bad["settings"]["permissions"] = "x"
    replies.append(set_security(handle, bad))
    replies.append(remove_security(handle))
    replies.append(call("actions.undo", {"handle": handle}))
    replies.append(call("session.unlock_owner", {"handle": handle, "password": "wrong-try"}))
    save_copy(handle)

    encrypted, _ = open_bytes(fixture_pdf("encrypted").read_bytes(), "encrypted.pdf", "user")
    replies.append(remove_security(encrypted))
    replies.append(call("session.unlock_owner", {"handle": encrypted, "password": OWNER_PW}))
    for reply in replies:
        for text in (json.dumps(reply), json.dumps(reply, ensure_ascii=False)):
            for password in passwords:
                assert password not in text
    for password in passwords:
        assert password not in caplog.text
