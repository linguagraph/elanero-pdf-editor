"""The crop action (W4.11 S1) through dispatch: run, undo, redo, refusals, and the saved bytes.

The crop is ``pages.crop_margins`` (points trimmed from each visible edge). Its guards live in the
actions layer, so the web gets them unchanged: a refusal arrives as ``REFUSED`` with
``details.reason``. The saved files are reopened in pikepdf and rendered in pypdfium2 (the
round-trip rule in AGENTS.md) through ``tests.hostcheck.record``, so they replay under Pyodide.
The signed sample is read only; nothing here signs or opens a certificate.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.webapi import dispatch
from pdfeditor.webapi.errors import BUSY, REFUSED
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.hostcheck import record

SIGNED = Path(__file__).parent.parent / "fixtures" / "real" / "signed_selfsigned.pdf"
MARGINS = {"left": 10, "top": 20, "right": 30, "bottom": 40}


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


def save_bytes(handle: str, mode: str) -> tuple[dict[str, Any], bytes]:
    reply, out = call_raw("save.save_bytes", {"handle": handle, "mode": mode})
    result = ok(reply)
    assert len(out) == 1
    assert result["verified"] is True
    assert result["size"] == len(out[0])
    return result, out[0]


def sizes(handle: str) -> list[tuple[float, float]]:
    pages = ok(call("session.pages", {"handle": handle}))["pages"]
    return [(float(p["width"]), float(p["height"])) for p in pages]


def run(handle: str, name: str, args: dict[str, Any]) -> dict[str, Any]:
    return call("actions.run", {"handle": handle, "name": name, "args": args})


def crop(handle: str, pages: list[int], **margins: float) -> dict[str, Any]:
    return run(handle, "pages.crop_margins", {"pages": pages, **margins})


def test_crop_two_pages_shrinks_each_page_and_undo_redo_follow(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("text_multipage").read_bytes(), "text.pdf")
    before = sizes(handle)
    result = ok(crop(handle, [0, 1], **MARGINS))
    assert result["label"] == "Crop 2 Pages"
    assert result["executed"] is True
    assert {"0", "1"} <= set(result["changed"]["revisions"])
    after = sizes(handle)
    for (w0, h0), (w1, h1) in zip(before[:2], after[:2], strict=True):
        assert (w1, h1) == pytest.approx((w0 - 40, h0 - 60))
    assert after[2:] == before[2:]

    undone = ok(call("actions.undo", {"handle": handle}))
    assert undone["done"] is True and undone["label"] == "Crop 2 Pages"
    assert sizes(handle) == before

    redone = ok(call("actions.redo", {"handle": handle}))
    assert redone["done"] is True
    assert sizes(handle)[0] == pytest.approx((before[0][0] - 40, before[0][1] - 60))


def test_cropped_document_round_trips_through_pikepdf_and_pdfium(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_data(fixture_pdf("text_multipage").read_bytes(), "text.pdf")
    w, h = sizes(handle)[0]
    ok(crop(handle, [0], **MARGINS))
    _, saved = save_bytes(handle, "copy")
    record("crop_box_size_pikepdf", saved, width=w - 40, height=h - 60)
    record("page_count_pikepdf", saved, pages=5)
    record("page_count_pdfium", saved, pages=5)
    record("render_width_pdfium", saved, scale=0.5)
    record("text_contains_pdfium", saved, page=0, text="Page 1 heading")


def test_a_rotated_page_is_cropped_on_its_visible_edges(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("text_multipage").read_bytes(), "text.pdf")
    ok(run(handle, "pages.rotate", {"pages": [0], "delta": 90}))
    visible_w, visible_h = sizes(handle)[0]
    ok(crop(handle, [0], **MARGINS))
    assert sizes(handle)[0] == pytest.approx((visible_w - 40, visible_h - 60))
    _, saved = save_bytes(handle, "copy")
    # The stored CropBox is unrotated: a quarter turn swaps the axes, so its width is the
    # visible height less the top and bottom margins.
    record("crop_box_size_pikepdf", saved, width=visible_h - 60, height=visible_w - 40, page=0)
    record("rotation_pikepdf", saved, page=0, degrees=90)


def test_refusals_over_rpc_name_the_reason_and_change_nothing(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("text_multipage").read_bytes(), "text.pdf")
    cases = [
        (crop(handle, [0], left=400, top=0, right=400, bottom=0), "crop_too_large"),
        (crop(handle, [0], left=-5, top=0, right=0, bottom=0), "invalid_margins"),
        (crop(handle, [99], **MARGINS), "invalid_pages"),
    ]
    for reply, reason in cases:
        err = error(reply)
        assert err["code"] == REFUSED
        assert err["details"]["reason"] == reason
    assert ok(call("actions.undo", {"handle": handle}))["done"] is False  # no step was added


def test_zero_margins_are_a_no_op_with_no_undo_step(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("text_multipage").read_bytes(), "text.pdf")
    result = ok(crop(handle, [0, 1], left=0, top=0, right=0, bottom=0))
    assert result["executed"] is False
    assert result["changed"] is None
    assert ok(call("actions.undo", {"handle": handle}))["done"] is False


def test_a_busy_document_refuses_a_crop_with_busy(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("text_multipage").read_bytes(), "text.pdf")
    session = REGISTRY.get(handle)
    session.begin_task("Optimize")
    try:
        err = error(crop(handle, [0], **MARGINS))
    finally:
        session.end_task("Optimize")
    assert err["code"] == BUSY


def test_a_crop_of_a_signed_document_saves_incrementally(web: None) -> None:
    original = SIGNED.read_bytes()
    handle = open_data(original, "signed.pdf")
    w, h = sizes(handle)[0]
    assert ok(crop(handle, [0], **MARGINS))["executed"] is True
    result, saved = save_bytes(handle, "in_place")
    assert result["incremental"] is True
    assert saved.startswith(original)  # the signature bytes are untouched
    record("page_count_pikepdf", saved, pages=len(sizes(handle)))
    record("crop_box_size_pikepdf", saved, width=w - 40, height=h - 60)
    record("render_width_pdfium", saved, scale=0.5)


def test_a_crop_of_an_encrypted_document_keeps_the_encryption(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("encrypted").read_bytes(), "encrypted.pdf", password="user")
    w, h = sizes(handle)[0]
    assert ok(crop(handle, [0], **MARGINS))["executed"] is True
    result, saved = save_bytes(handle, "copy")
    assert result["verified"] is True
    record("refuses_without_password_pikepdf", saved)
    record("encrypted_pages_pikepdf", saved, pages=1, password="user")
    record("crop_box_size_pikepdf", saved, width=w - 40, height=h - 60, password="user")
