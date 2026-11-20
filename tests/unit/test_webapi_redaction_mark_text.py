"""The web's Mark Text (W4.12 S2): the browser selection's areas, sent as ``redaction.mark`` with
their quads and text. One call is one undo step, and marking never applies anything. The saved
files are checked by pikepdf and pypdfium2 through ``tests.hostcheck.record`` (AGENTS.md round-trip
and leak rules), so this module imports neither at module level (the host replay runs it under
Pyodide).
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
from tests.unit.test_webapi_redact_job import _areas_for

REDACT = "redaction.apply"
AUTHOR = "Ada Lovelace"
EMAIL = "jane.example@example.com"
STYLE: dict[str, Any] = {
    "fill": {"r": 1.0, "g": 0.502, "b": 0.0},
    "overlay_text": "REDACTED",
    "text_color": {"r": 0.0627, "g": 0.1255, "b": 0.1882},
}
FILL = [1.0, 0.502, 0.0]
TEXT = [0.0627, 0.1255, 0.1882]


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


def _email_area(handle: str) -> RedactionArea:
    """The area the browser sends for a selection of the email: its one line's quad and text."""
    areas = _areas_for(handle, ["Email addresses"])
    assert len(areas) == 1 and len(areas[0].quads) == 1, "the email is one line, one quad"
    return areas[0]


def _mark(handle: str, areas: list[RedactionArea]) -> list[dict[str, Any]]:
    args = {
        "areas": dto.to_json(tuple(areas), []),
        "author": AUTHOR,
        "style": STYLE,
    }
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


def test_a_two_line_selection_saves_its_quads(web: None, fixture_pdf: Any) -> None:
    # The email and the SSN are two lines, so one area carries two quads: the engine writes
    # /QuadPoints only for a mark with more than one quad (annots.py, REDACT).
    handle = open_data(fixture_pdf("sensitive").read_bytes(), "sensitive.pdf")
    parts = _areas_for(handle, ["Email addresses", "US Social Security numbers"])
    assert len(parts) == 2, "the fixture has an email and an SSN on two lines"
    quads = tuple(q for part in parts for q in part.quads)
    rects = [part.rect for part in parts]
    box = Rect(
        min(r.x0 for r in rects),
        min(r.y0 for r in rects),
        max(r.x1 for r in rects),
        max(r.y1 for r in rects),
    )
    area = RedactionArea(0, box, quads, "email and SSN")
    (mark,) = _mark(handle, [area])
    name = str(mark["name"])
    assert len(_listed(handle)) == 1

    saved = _save(handle)
    corners = [[p.x, p.y] for q in quads for p in (q.ul, q.ur, q.ll, q.lr)]
    record(
        "redact_annot_pikepdf", saved, page=0, mark=name, fill=FILL, overlay="REDACTED", text=TEXT
    )
    record("quad_points_pikepdf", saved, subtype="/Redact", corners=corners)
    record("render_width_pdfium", saved, scale=0.5)


def test_one_undo_removes_the_whole_selection(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("sensitive").read_bytes(), "sensitive.pdf")
    area = _email_area(handle)
    _mark(handle, [area, RedactionArea(0, area.rect, area.quads, "second")])
    assert len(_listed(handle)) == 2
    assert ok(call("actions.undo", {"handle": handle}))["label"]
    assert _listed(handle) == []


def test_marking_a_selection_leaks_nothing_once_applied(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("sensitive").read_bytes(), "sensitive.pdf")
    area = _email_area(handle)
    marks = _mark(handle, [area])

    args = {"name": REDACT, "args": {"marks": marks}}
    prepared, copy = prepare(handle, "action", args)
    reply, out = run_job("action", args, copy)
    result = ok(reply)
    assert result["value"]["leaks"] == []
    document = binary(result["document"], out)
    applied = ok(apply(handle, prepared["token"], document, result["label"], True))
    assert applied["applied"] is True

    data = _save(handle)
    record("page_count_pikepdf", data, pages=1)
    record("streams_lack_pikepdf", data, needle=EMAIL)
    record("doc_text_lacks_pdfium", data, text=EMAIL)
    # Only the selection is applied: the text on the same line, and the other secret, stay.
    record("doc_text_contains_pdfium", data, text="Email:")
    record("doc_text_contains_pdfium", data, text="Public paragraph")
    record("doc_text_contains_pdfium", data, text="123-45-6789")
    assert EMAIL.encode() not in data
