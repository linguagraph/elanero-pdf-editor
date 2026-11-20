"""The web's Mark Pages (W4.13 S3): one page-sized mark per chosen page, sent as ``redaction.mark``
with the page's visible box. One call is one undo step, and marking never applies anything. The
saved files are checked by pikepdf and pypdfium2 through ``tests.hostcheck.record`` (AGENTS.md
round-trip and leak rules), so this module imports neither at module level (the host replay runs
it under Pyodide).
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.model.geometry import Rect
from pdfeditor.model.redaction import RedactionArea
from pdfeditor.webapi import dto, jobs
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.hostcheck import record
from tests.unit.test_webapi_jobs import (
    apply,
    binary,
    call,
    call_raw,
    ok,
    open_data,
    prepare,
    run_job,
)

REDACT = "redaction.apply"
AUTHOR = "Ada Lovelace"
STYLE: dict[str, Any] = {
    "fill": {"r": 1.0, "g": 0.502, "b": 0.0},
    "overlay_text": "REDACTED",
    "text_color": {"r": 0.0627, "g": 0.1255, "b": 0.1882},
}
RED_STYLE: dict[str, Any] = {
    "fill": {"r": 1.0, "g": 0.0, "b": 0.0},
    "overlay_text": "REDACTED",
    "text_color": {"r": 0.0, "g": 0.0, "b": 0.0},
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


def _sizes(handle: str) -> list[dict[str, Any]]:
    """The visible size of each page, as the browser reads it (session.pages)."""
    pages: list[dict[str, Any]] = ok(call("session.pages", {"handle": handle}))["pages"]
    return pages


def _whole(pages: list[int], sizes: list[dict[str, Any]]) -> list[RedactionArea]:
    """The areas the browser sends for the chosen pages (0-based): each whole box, no quads."""
    return [
        RedactionArea(index, Rect(0.0, 0.0, sizes[index]["width"], sizes[index]["height"]), (), "")
        for index in pages
    ]


def _mark(
    handle: str, areas: list[RedactionArea], style: dict[str, Any] = STYLE
) -> list[dict[str, Any]]:
    args = {"areas": dto.to_json(tuple(areas), []), "author": AUTHOR, "style": style}
    result = ok(call("actions.run", {"handle": handle, "name": "redaction.mark", "args": args}))
    assert result["executed"] is True
    marks: list[dict[str, Any]] = result["value"]
    return marks


def _listed(handle: str) -> list[Any]:
    marks: list[Any] = ok(call("redaction.list", {"handle": handle}))["marks"]
    return marks


def _save(handle: str) -> bytes:
    reply, out = call_raw("save.save_bytes", {"handle": handle, "mode": "copy"})
    result = ok(reply)
    assert result["verified"] is True
    return binary(result["data"], out)


def test_marked_pages_save_one_page_box_each(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("text_multipage").read_bytes(), "text_multipage.pdf")
    sizes = _sizes(handle)
    marks = _mark(handle, _whole([1, 2], sizes))
    assert [mark["page"] for mark in marks] == [1, 2]
    assert sorted(mark["page"] for mark in _listed(handle)) == [1, 2]

    saved = _save(handle)
    width, height = sizes[1]["width"], sizes[1]["height"]
    record("page_count_pikepdf", saved, pages=5)
    for page in (1, 2):
        record("redact_rects_pikepdf", saved, page=page, count=1, rect=[0.0, 0.0, width, height])
    record("render_pdfium", saved, page=1, scale=0.5)

    # One undo step takes both marks back.
    assert ok(call("actions.undo", {"handle": handle}))["label"]
    assert _listed(handle) == []


def test_an_applied_whole_page_mark_leaves_no_text_or_pixels(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("text_multipage").read_bytes(), "text_multipage.pdf")
    sizes = _sizes(handle)
    marks = _mark(handle, _whole([1], sizes), RED_STYLE)

    args = {"name": REDACT, "args": {"marks": marks}}
    prepared, copy = prepare(handle, "action", args)
    reply, out = run_job("action", args, copy)
    result = ok(reply)
    assert result["value"]["leaks"] == []
    document = binary(result["document"], out)
    assert ok(apply(handle, prepared["token"], document, result["label"], True))["applied"] is True

    data = _save(handle)
    width, height = sizes[1]["width"], sizes[1]["height"]
    record("streams_lack_pikepdf", data, needle="needle-2")
    record("text_lacks_pdfium", data, page=1, text="Page 2 heading")
    record("doc_text_lacks_pdfium", data, text="needle-2")
    # The other pages keep their text: only the marked page was applied.
    record("doc_text_contains_pdfium", data, text="needle-1")
    record("doc_text_contains_pdfium", data, text="needle-3")
    record("red_pixels_pdfium", data, page=1, clip=[0.0, 0.0, width, height], minimum=200000)
