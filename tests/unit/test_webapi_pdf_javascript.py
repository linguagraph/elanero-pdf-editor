"""F9, engine half (docs/web/security-review.md): a PDF's document-open JavaScript does nothing.

The fixtures ``sensitive`` and ``xref_gap`` carry a catalogue ``/OpenAction`` whose action is
``/S /JavaScript``. The web engine never enables PDF JavaScript (MuPDF's ``pdf_js_supported`` stays
0), so opening, rendering and a plain save must leave the document as it was, and the action must
still be in the saved file. Sanitize removes it; that is tested elsewhere.

The saved bytes are reopened in pymupdf, not pikepdf, so this module imports fine under Pyodide.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any, cast

import pymupdf
import pymupdf.mupdf as mupdf
import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.webapi import dispatch
from pdfeditor.webapi.platform import configure_web
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


def open_data(data: bytes, name: str = "doc.pdf") -> dict[str, Any]:
    reply, out = call_raw(
        "session.open",
        {"name": name, "data": {"$bin": 0}, "password": None},
        [data],
    )
    assert out == []
    return ok(reply)


def saved_copy(handle: str) -> bytes:
    reply, out = call_raw("save.save_bytes", {"handle": handle, "mode": "copy"})
    result = ok(reply)
    assert len(out) == 1
    assert result["verified"] is True
    return out[0]


def engine_js_enabled(handle: str) -> int:
    """MuPDF's JavaScript switch for the engine document (0 = disabled).

    The path: the session's ``document`` is the MuPDF backend's ``MuDocument``, whose ``fz`` is the
    pymupdf document; ``pdf_document_from_fz_document`` gives the PDF document that
    ``pdf_js_supported`` reads. The session lock is held, as for every engine call.
    """
    session = REGISTRY.get(handle)
    fz = cast(Any, session.document).fz
    with session.lock:
        pdf = mupdf.pdf_document_from_fz_document(fz)
        return int(mupdf.pdf_js_supported(pdf))


def open_action(data: bytes) -> tuple[tuple[str, str], tuple[str, str]]:
    """The /S and /JS of the catalogue's /OpenAction, resolved through its indirect object."""
    doc = pymupdf.open(stream=data, filetype="pdf")
    try:
        kind, value = doc.xref_get_key(doc.pdf_catalog(), "OpenAction")
        assert kind == "xref", (kind, value)
        action = int(value.split()[0])
        return doc.xref_get_key(action, "S"), doc.xref_get_key(action, "JS")
    finally:
        doc.close()


@pytest.mark.parametrize(
    ("name", "expected_js"),
    [
        ("sensitive", "app.alert('hi');"),
        ("xref_gap", "app.alert('gap secret');"),
    ],
)
def test_document_open_javascript_does_nothing(
    web: None, fixture_pdf: Any, name: str, expected_js: str
) -> None:
    data = fixture_pdf(name).read_bytes()
    opened = open_data(data, f"{name}.pdf")
    handle = str(opened["handle"])

    # The fixture is armed: the document reports JavaScript on open, and the open state is clean.
    assert ok(call("session.info", {"handle": handle}))["has_javascript"] is True
    assert opened["state"]["dirty"] is False
    assert opened["state"]["can_undo"] is False
    session = REGISTRY.get(handle)
    assert session.is_dirty is False
    assert session.undo_stack.can_undo is False

    # Rendering page 0 changes nothing: no state event, and the session stays clean.
    reply, out = call_raw(
        "render.page",
        {
            "handle": handle,
            "page": 0,
            "revision": 0,
            "scale_milli": 1000,
            "rotation": 0,
            "annotations": False,
        },
    )
    assert ok(reply)["width"] > 0
    assert len(out) == 1
    assert reply["events"] == []
    assert session.is_dirty is False
    assert session.undo_stack.can_undo is False

    # The engine document never had JavaScript enabled, before or after the render.
    assert not engine_js_enabled(handle)

    # A copy save keeps the action, with the same script as the fixture.
    (s_kind, s_value), (js_kind, js_value) = open_action(saved_copy(handle))
    assert (s_kind, s_value) == ("name", "/JavaScript")
    assert (js_kind, js_value) == ("string", expected_js)
    assert session.is_dirty is False
