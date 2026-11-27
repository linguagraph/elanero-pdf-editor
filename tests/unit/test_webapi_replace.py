"""``pages.replace`` through dispatch (``actions.run``), the route the web uses (R1, design 772 s4).

The action's own rules (which pages, which source pages, undo) are checked in
``tests/actions/test_pages.py``. These tests cover what only the web layer adds: the arguments
arrive as JSON with the source as a ``$bin`` buffer, a password the source needs is asked for
through ``PASSWORD_REQUIRED`` and never logged or kept, and a refusal comes back as ``REFUSED``
with its reason.

The saved bytes are checked in pikepdf and pypdfium2 through ``tests.hostcheck.record``, so the
same assertions run under Pyodide, which has neither library at module level.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator
from typing import Any

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.webapi import dispatch
from pdfeditor.webapi.errors import PASSWORD_REQUIRED, REFUSED
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
    request = json.dumps({"v": 1, "id": 11, "method": method, "params": params})
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


def page_total(handle: str) -> int:
    return int(ok(call("session.info", {"handle": handle}))["page_count"])


def page_texts(handle: str) -> list[str]:
    session = REGISTRY.get(handle)
    with session.lock:
        doc = session.document
        return [doc.page(i).text_page(with_chars=False).text for i in range(doc.page_count)]


def replace(
    handle: str,
    data: bytes,
    pages: list[int],
    source_pages: list[int],
    password: str | None = None,
) -> dict[str, Any]:
    reply, _ = call_raw(
        "actions.run",
        {
            "handle": handle,
            "name": "pages.replace",
            "args": {
                "pages": pages,
                "data": {"$bin": 0},
                "source_pages": source_pages,
                "password": password,
            },
        },
        [data],
    )
    return reply


def saved_bytes(handle: str) -> bytes:
    reply, out = call_raw("save.save_bytes", {"handle": handle, "mode": "copy"})
    result = ok(reply)
    assert result["verified"] is True
    assert len(out) == 1
    return out[0]


def test_replace_through_actions_run_swaps_the_pages(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("text_multipage").read_bytes(), "text_multipage.pdf")
    before = page_texts(handle)
    source = fixture_pdf("outline").read_bytes()
    source_texts = page_texts(open_data(source, "outline.pdf"))

    result = ok(replace(handle, source, [1, 2], [0, 1]))
    assert result["executed"] is True
    assert result["label"] == "Replace 2 Pages"
    assert page_texts(handle) == [before[0], source_texts[0], source_texts[1], *before[3:]]

    saved = saved_bytes(handle)
    record("page_count_pikepdf", saved, pages=len(before))
    record("page_count_pdfium", saved, pages=len(before))
    record("text_contains_pdfium", saved, page=1, text=source_texts[0].split()[0])
    record("render_first_page_pdfium", saved)


def test_the_replace_undoes_in_one_step(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("text_multipage").read_bytes(), "text_multipage.pdf")
    before = page_texts(handle)
    source = fixture_pdf("outline").read_bytes()
    ok(replace(handle, source, [1, 2], [0, 1]))

    undone = ok(call("actions.undo", {"handle": handle}))
    assert undone["done"] is True
    assert page_texts(handle) == before
    assert ok(call("actions.undo", {"handle": handle}))["done"] is False


def test_an_encrypted_source_needs_its_password_and_changes_nothing_without_it(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_data(fixture_pdf("text_multipage").read_bytes(), "text_multipage.pdf")
    before = page_texts(handle)
    secret = fixture_pdf("encrypted").read_bytes()
    digest = hashlib.sha256(secret).hexdigest()

    for password in (None, "wrong"):
        err = error(replace(handle, secret, [0], [0], password))
        assert err["code"] == PASSWORD_REQUIRED
        assert page_texts(handle) == before
        assert not REGISTRY.get(handle).undo_stack.can_undo
    assert hashlib.sha256(secret).hexdigest() == digest  # the source is never written

    result = ok(replace(handle, secret, [0], [0], "user"))
    assert result["executed"] is True
    assert page_texts(handle)[0] != before[0]
    assert page_total(handle) == len(before)
    record("page_count_pikepdf", saved_bytes(handle), pages=len(before))


@pytest.mark.parametrize(
    ("pages", "source_pages", "reason"),
    [
        ([], [0], "invalid_pages"),
        ([99], [0], "invalid_pages"),
        ([-1], [0], "invalid_pages"),
        ([0], [], "invalid_source_pages"),
        ([0], [999], "invalid_source_pages"),
    ],
)
def test_a_bad_selection_is_refused_with_its_reason_and_changes_nothing(
    web: None, fixture_pdf: Any, pages: list[int], source_pages: list[int], reason: str
) -> None:
    handle = open_data(fixture_pdf("text_multipage").read_bytes(), "text_multipage.pdf")
    before = page_texts(handle)
    source = fixture_pdf("outline").read_bytes()

    err = error(replace(handle, source, pages, source_pages))
    assert err["code"] == REFUSED
    assert err["details"] == {"reason": reason}
    assert page_texts(handle) == before
    assert not REGISTRY.get(handle).undo_stack.can_undo


def test_a_bad_target_is_refused_before_a_password_is_asked_for(
    web: None, fixture_pdf: Any
) -> None:
    # The target check runs before the source is opened, so an encrypted source with no password
    # gets the refusal for the selection, not PASSWORD_REQUIRED.
    handle = open_data(fixture_pdf("text_multipage").read_bytes(), "text_multipage.pdf")
    secret = fixture_pdf("encrypted").read_bytes()
    err = error(replace(handle, secret, [], [0], None))
    assert err["code"] == REFUSED
    assert err["details"] == {"reason": "invalid_pages"}
