"""Flatten annotations in the browser (W7.9): ``annotations.flatten`` runs as a mutating action job
(W1.2 section 13), is applied as one undoable step, and the saved file is checked on its own.

The job worker runs in this process. The saved file must open in pikepdf and render in pypdfium2,
through ``tests.hostcheck.record``, so this module imports neither at module level.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from pdfeditor.core.session import DocumentSession
from pdfeditor.model import platform as model_platform
from pdfeditor.webapi import dispatch, jobs, jobworker
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.hostcheck import record

FLATTEN = "annotations.flatten"
FLATTEN_LABEL = "Flatten Comments"  # the undo label of "every comment", as the desktop has it
COMMENTS = 6  # the annotations fixture: highlight, sticky note, free text, square, ink, line


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
    request = json.dumps({"v": 1, "id": 3, "method": method, "params": params})
    reply_json, out = dispatch(request, buffers or [])
    return json.loads(reply_json), out


def ok(reply: dict[str, Any]) -> dict[str, Any]:
    assert reply["ok"] is True, reply
    result: dict[str, Any] = reply["result"]
    return result


def binary(value: dict[str, Any], out: list[bytes]) -> bytes:
    assert set(value) == {"$bin"}
    return out[value["$bin"]]


def test_flatten_job_removes_the_comments_and_round_trips(
    web: None, fixture_pdf: Any, tmp_path: Path
) -> None:
    data = fixture_pdf("annotations").read_bytes()
    reply, _ = call_raw(
        "session.open", {"name": "annotations.pdf", "data": {"$bin": 0}, "password": None}, [data]
    )
    handle = str(ok(reply)["handle"])
    session = REGISTRY.get(handle)

    args = {"name": FLATTEN, "args": {"refs": None}}
    reply, out = call_raw("jobs.prepare", {"handle": handle, "job": "action", "args": args})
    prepared = ok(reply)
    assert prepared["mutating"] is True
    copy = binary(prepared["document"], out)

    job_reply = json.dumps(
        {
            "v": 1,
            "id": 5,
            "method": "job.run",
            "params": {"job": "action", "args": args, "document": {"$bin": 0}},
        }
    )
    job_json, job_out = jobworker.dispatch(job_reply, [copy], None, None)
    result = ok(json.loads(job_json))
    assert result["kind"] == "document"
    assert result["label"] == FLATTEN_LABEL
    assert result["value"] == COMMENTS

    reply, _ = call_raw(
        "jobs.apply",
        {
            "handle": handle,
            "token": prepared["token"],
            "document": {"$bin": 0},
            "label": result["label"],
            "require_full_save": result["require_full_save"],
        },
        [binary(result["document"], job_out)],
    )
    assert ok(reply)["applied"] is True
    assert session.undo_stack.undo_label == FLATTEN_LABEL

    reply, saved_out = call_raw("save.save_bytes", {"handle": handle, "mode": "copy"})
    saved = saved_out[0]
    assert ok(reply)["verified"] is True

    # The saved file: no annotations on the page, the page content still there and drawn.
    record("opens_pikepdf", saved)
    record("page_count_pikepdf", saved, pages=1)
    record("no_annots_pikepdf", saved, page=0)
    record("page_count_pdfium", saved, pages=1)
    record("text_contains_pdfium", saved, page=0, text="Highlight this sentence")
    record("render_first_page_pdfium", saved)

    # The same file, read on the desktop side: the comments are gone and the text is still there.
    path = tmp_path / "flattened.pdf"
    path.write_bytes(saved)
    reopened = DocumentSession.open(path)
    try:
        with reopened.lock:
            assert reopened.document.page(0).annotations() == []
            assert (
                "Highlight this sentence"
                in reopened.document.page(0).text_page(with_chars=False).text
            )
    finally:
        with reopened.lock:
            reopened.document.close()
