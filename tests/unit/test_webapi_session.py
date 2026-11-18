"""The session calls of the web RPC (W3.2) on real fixtures, through dispatch, host CPython.

Each test that touches the platform flags uses the ``web`` fixture, which restores the desktop
flags afterwards: the rest of the suite must see the desktop values.
"""

from __future__ import annotations

import dataclasses
import json
import re
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from pdfeditor.engine.base import Capabilities
from pdfeditor.engine.registry import get_engine
from pdfeditor.model import platform as model_platform
from pdfeditor.webapi import dispatch
from pdfeditor.webapi.dto import PlatformFlags
from pdfeditor.webapi.errors import (
    INVALID_ARGS,
    NO_DOCUMENT,
    OPEN_FAILED,
    PASSWORD_REQUIRED,
    WRONG_PASSWORD,
)
from pdfeditor.webapi.platform import WEB_PLATFORM, configure_web
from pdfeditor.webapi.registry import REGISTRY


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
    request = json.dumps({"v": 1, "id": 1, "method": method, "params": params})
    reply_json, out = dispatch(request, buffers or [])
    assert out == []  # no call here returns bytes
    return json.loads(reply_json)


def open_bytes(data: bytes, password: str | None = None) -> dict[str, Any]:
    return call(
        "session.open",
        {"name": "a.pdf", "data": {"$bin": 0}, "password": password},
        [data],
    )


def handle_of(reply: dict[str, Any]) -> str:
    assert reply["ok"] is True, reply
    return str(reply["result"]["handle"])


def test_open_by_bytes_returns_handle_info_and_pages(web: None, fixture_pdf: Any) -> None:
    path = fixture_pdf("text_multipage")
    reply = open_bytes(path.read_bytes())
    assert reply["ok"] is True, reply
    result = reply["result"]
    assert re.fullmatch(r"[0-9a-f]{32}", result["handle"])
    assert result["warning"] is None
    assert result["info"]["encrypted"] is False
    assert result["info"]["has_signatures"] is False
    count = _engine_count(path)
    assert result["pages"] == count
    assert result["info"]["page_count"] == count


def test_pages_and_info_match_the_engine(web: None, fixture_pdf: Any) -> None:
    path = fixture_pdf("text_multipage")
    handle = handle_of(open_bytes(path.read_bytes()))
    doc = get_engine().open(path)
    try:
        expected = [
            {"width": p.rect.width, "height": p.rect.height, "rotation": p.rotation}
            for p in (doc.page(i) for i in range(doc.page_count))
        ]
    finally:
        doc.close()
    pages = call("session.pages", {"handle": handle})
    assert pages["result"]["pages"] == expected
    info = call("session.info", {"handle": handle})
    assert info["result"]["page_count"] == len(expected)
    assert info["result"]["encrypted"] is False


def test_capabilities_report_the_web_flags(web: None, fixture_pdf: Any) -> None:
    handle = handle_of(open_bytes(fixture_pdf("text_multipage").read_bytes()))
    reply = call("session.capabilities", {"handle": handle})
    result = reply["result"]
    platform = result["platform"]
    for name in ("linearize", "ocr", "signing", "system_fonts", "office_import", "threads", "pdfa"):
        assert platform[name] is False, name
    assert platform["tiff_compression"] == "tiff_lzw"
    assert set(result["engine"]) == {f.name for f in dataclasses.fields(Capabilities)}
    assert all(isinstance(value, bool) for value in result["engine"].values())


def test_platform_flags_match_the_model_fields(web: None) -> None:
    fields = {f.name for f in dataclasses.fields(model_platform.PlatformCapabilities)}
    assert {f.name for f in dataclasses.fields(PlatformFlags)} == fields
    assert model_platform.current() == WEB_PLATFORM


def test_configure_web_is_idempotent(web: None) -> None:
    configure_web()
    configure_web()
    assert model_platform.current() == WEB_PLATFORM


def test_close_then_every_call_is_no_document(web: None, fixture_pdf: Any) -> None:
    handle = handle_of(open_bytes(fixture_pdf("text_multipage").read_bytes()))
    closed = call("session.close", {"handle": handle})
    assert closed == {"v": 1, "id": 1, "ok": True, "result": {}}
    for method, params in [
        ("session.info", {"handle": handle}),
        ("session.pages", {"handle": handle}),
        ("session.capabilities", {"handle": handle}),
        ("session.close", {"handle": handle}),
        ("session.unlock_owner", {"handle": handle, "password": "owner"}),
    ]:
        reply = call(method, params)
        assert reply["error"]["code"] == NO_DOCUMENT, method


def test_an_unknown_handle_is_no_document(web: None) -> None:
    assert call("session.info", {"handle": "00" * 16})["error"]["code"] == NO_DOCUMENT


def test_a_file_that_is_not_a_pdf_is_open_failed(web: None) -> None:
    assert open_bytes(b"this is not a pdf")["error"]["code"] == OPEN_FAILED


def test_encrypted_file_needs_the_right_password(web: None, fixture_pdf: Any) -> None:
    data = fixture_pdf("encrypted").read_bytes()
    missing = open_bytes(data, None)
    assert missing["error"]["code"] == PASSWORD_REQUIRED

    wrong = open_bytes(data, "wrongpw-x")
    assert wrong["error"]["code"] == WRONG_PASSWORD
    assert "wrongpw-x" not in json.dumps(wrong)

    right = open_bytes(data, "user")
    assert right["ok"] is True, right
    assert right["result"]["info"]["encrypted"] is True
    assert "user" not in json.dumps(right)  # the password is never echoed back


def test_the_password_is_dropped_when_the_document_closes(web: None, fixture_pdf: Any) -> None:
    handle = handle_of(open_bytes(fixture_pdf("encrypted").read_bytes(), "user"))
    assert REGISTRY.passwords_kept() == 1
    call("session.close", {"handle": handle})
    assert REGISTRY.passwords_kept() == 0
    assert handle not in REGISTRY


def test_unlock_owner_gains_owner_access_without_echoing_the_password(
    web: None, fixture_pdf: Any
) -> None:
    handle = handle_of(open_bytes(fixture_pdf("encrypted").read_bytes(), "user"))
    good = call("session.unlock_owner", {"handle": handle, "password": "owner"})
    assert good == {"v": 1, "id": 1, "ok": True, "result": {"unlocked": True}}
    bad = call("session.unlock_owner", {"handle": handle, "password": "nope-nope"})
    assert bad["result"] == {"unlocked": False}
    assert "nope-nope" not in json.dumps(bad)


def test_missing_password_field_is_invalid_args(web: None, fixture_pdf: Any) -> None:
    reply = call("session.open", {"name": "a.pdf", "data": {"$bin": 0}}, [b"%PDF"])
    assert reply["error"]["code"] == INVALID_ARGS
    assert reply["error"]["details"] == {"path": "params.password"}


def _engine_count(path: Path) -> int:
    doc = get_engine().open(path)
    try:
        return int(doc.page_count)
    finally:
        doc.close()
