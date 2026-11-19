"""The web's redaction job (W7.4): marks made through actions.run, applied through the action job
of W1.2 section 13, then saved. The saved bytes are checked by pikepdf and pypdfium2 through the
host-check manifest, not only by MuPDF (AGENTS.md leak rule).
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest

from pdfeditor.core.session import DocumentSession
from pdfeditor.model import platform as model_platform
from pdfeditor.model.geometry import Quad, Rect
from pdfeditor.model.redaction import RedactionArea
from pdfeditor.services.redaction import find_sensitive
from pdfeditor.services.text import PageTextIndex
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
SECRETS = ("jane.example@example.com", "123-45-6789")
PUBLIC = "Public paragraph that must survive."


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


class _Cache:
    """A text-index cache over a bare document; the caller holds the session lock."""

    def __init__(self, doc: Any) -> None:
        self._doc = doc
        self.session = type("S", (), {"page_count": doc.page_count})()

    def get(self, page: int) -> PageTextIndex:
        return PageTextIndex(self._doc.page(page).text_page(with_chars=True))


def _areas_for(handle: str, patterns: list[str]) -> list[RedactionArea]:
    """The marks a front end makes for each found match: its box, its runs and its text."""
    session: DocumentSession = REGISTRY.get(handle)
    with session.lock:
        hits = find_sensitive(_Cache(session.document), patterns)
    return [
        RedactionArea(
            hit.page_index,
            hit.rect,
            tuple(Quad.from_rect(q.rect) for q in hit.quads),
            hit.text,
        )
        for hit in hits
    ]


def _mark(handle: str, areas: list[RedactionArea]) -> list[dict[str, Any]]:
    """Marks the areas through actions.run; the reply names the marks it added."""
    args = {"areas": dto.to_json(tuple(areas), [])}
    result = ok(call("actions.run", {"handle": handle, "name": "redaction.mark", "args": args}))
    assert result["executed"] is True
    marks: list[dict[str, Any]] = result["value"]
    return marks


def test_redaction_job_leaks_nothing_after_save(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("sensitive").read_bytes(), "sensitive.pdf")
    areas = _areas_for(handle, ["Email addresses", "US Social Security numbers"])
    assert len(areas) >= 2, "the fixture has an email and an SSN to redact"
    # One mark over part of the page too, so the rectangle path is covered as well as the runs.
    areas.append(RedactionArea(0, Rect(60, 90, 250, 200)))
    marks = _mark(handle, areas)
    assert len(marks) == len(areas)

    args = {"name": REDACT, "args": {"marks": marks}}
    prepared, copy = prepare(handle, "action", args)
    assert prepared["mutating"] is True

    reply, out = run_job("action", args, copy)
    result = ok(reply)
    assert result["kind"] == "document"
    assert result["label"] == f"Apply {len(marks)} Redactions"
    assert result["value"]["leaks"] == []
    document = binary(result["document"], out)
    applied = ok(apply(handle, prepared["token"], document, result["label"], True))
    assert applied["applied"] is True
    assert applied["state"]["undo_label"] == result["label"]

    reply, save_out = call_raw("save.save_bytes", {"handle": handle, "mode": "copy"})
    saved = ok(reply)
    assert saved["verified"] is True
    data = binary(saved["data"], save_out)

    # The text under the marks is gone from the saved file, in every reader.
    record("page_count_pikepdf", data, pages=1)
    for secret in SECRETS:
        record("streams_lack_pikepdf", data, needle=secret)
        record("doc_text_lacks_pdfium", data, text=secret)
    record("doc_text_contains_pdfium", data, text=PUBLIC)
    record("render_size_pdfium", data, page=0, scale=1)
    assert b"jane.example" not in data
