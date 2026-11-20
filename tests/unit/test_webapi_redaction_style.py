"""The author and the redaction mark style of W4.5 S3, through the web's actions layer.

The Preferences dialog saves an author name and a mark style (box colour, overlay text, text
colour); the web sends them with each ``redaction.mark``. Each saved file is checked by pikepdf
and pypdfium2 through ``tests.hostcheck.record`` (AGENTS.md round-trip rule), so this module
imports neither at module level (the host replay runs it under Pyodide).
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from pdfeditor.core.session import DocumentSession
from pdfeditor.model import platform as model_platform
from pdfeditor.webapi import dto, jobs
from pdfeditor.webapi.errors import INVALID_ARGS
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

AUTHOR = "Ada Lovelace"
RECT = {"x0": 60.0, "y0": 90.0, "x1": 250.0, "y1": 200.0}
# The web's default colours are black and white; these are the saved ones the tests use. The
# channel values are #ff8000 and #102030 as 0..1 numbers (the web converts them, colour.ts).
STYLE: dict[str, Any] = {
    "fill": {"r": 1.0, "g": 0.502, "b": 0.0},
    "overlay_text": "REDACTED",
    "text_color": {"r": 0.0627, "g": 0.1255, "b": 0.1882},
}
FILL = [1.0, 0.502, 0.0]
TEXT = [0.0627, 0.1255, 0.1882]
SECRETS = ("jane.example@example.com", "123-45-6789")


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


def mark_args(author: str = AUTHOR, style: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "areas": [{"page": 0, "rect": RECT}],
        "author": author,
        "style": STYLE if style is None else style,
    }


def mark(handle: str, args: dict[str, Any]) -> dict[str, Any]:
    """Runs redaction.mark through actions.run; the reply names the mark it added."""
    result: dict[str, Any] = ok(
        call("actions.run", {"handle": handle, "name": "redaction.mark", "args": args})
    )
    assert result["executed"] is True
    return result


def save_copy(handle: str) -> bytes:
    reply, out = call_raw("save.save_bytes", {"handle": handle, "mode": "copy"})
    result = ok(reply)
    assert result["verified"] is True
    return binary(result["data"], out)


def check_mark(saved: bytes, name: str) -> None:
    record(
        "redact_annot_pikepdf",
        saved,
        page=0,
        mark=name,
        fill=FILL,
        overlay="REDACTED",
        text=TEXT,
    )
    record("annot_author_pikepdf", saved, page=0, mark=name, author=AUTHOR)
    record("render_width_pdfium", saved, scale=0.5)


def test_the_mark_takes_the_author_and_style_and_saves_them(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("images").read_bytes(), "images.pdf")
    value = mark(handle, mark_args())["value"]
    assert len(value) == 1
    name = str(value[0]["name"])
    check_mark(save_copy(handle), name)


def test_the_style_survives_an_edit_and_a_reopen(
    web: None, fixture_pdf: Any, tmp_path: Path
) -> None:
    handle = open_data(fixture_pdf("images").read_bytes(), "images.pdf")
    name = str(mark(handle, mark_args())["value"][0]["name"])
    rotate = {"name": "pages.rotate", "args": {"pages": [0], "delta": 90}}
    assert ok(call("actions.run", {"handle": handle, **rotate}))["executed"] is True

    saved = save_copy(handle)
    check_mark(saved, name)

    path = tmp_path / "styled.pdf"
    path.write_bytes(saved)
    pages = int(ok(call("session.info", {"handle": handle}))["page_count"])
    reopened = DocumentSession.open(path)
    try:
        with reopened.lock:
            assert reopened.document.page_count == pages
    finally:
        with reopened.lock:
            reopened.document.close()


def test_an_apply_with_overlay_text_passes_the_leak_check(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("sensitive").read_bytes(), "sensitive.pdf")
    areas = _areas_for(handle, ["Email addresses", "US Social Security numbers"])
    assert len(areas) >= 2, "the fixture has an email and an SSN to redact"
    args = mark_args()
    args["areas"] = dto.to_json(tuple(areas), [])
    marks = mark(handle, args)["value"]
    assert len(marks) == len(areas)

    action = {"name": "redaction.apply", "args": {"marks": marks}}
    prepared, copy = prepare(handle, "action", action)
    assert prepared["mutating"] is True
    reply, out = run_job("action", action, copy)
    result = ok(reply)
    # The overlay label is not text left behind: the engine's check still finds no leak.
    assert result["value"]["leaks"] == []
    applied = ok(
        apply(handle, prepared["token"], binary(result["document"], out), result["label"], True)
    )
    assert applied["applied"] is True

    data = save_copy(handle)
    for secret in SECRETS:
        record("streams_lack_pikepdf", data, needle=secret)
        record("doc_text_lacks_pdfium", data, text=secret)


def test_a_style_with_an_unknown_field_is_refused(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("images").read_bytes(), "images.pdf")
    bad_style = dict(STYLE, bogus=1)
    reply, _ = call_raw(
        "actions.run",
        {"handle": handle, "name": "redaction.mark", "args": mark_args(style=bad_style)},
    )
    assert reply["ok"] is False
    assert reply["error"]["code"] == INVALID_ARGS
