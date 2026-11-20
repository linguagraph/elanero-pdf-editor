"""Flatten annotations in the browser (W7.9): ``annotations.flatten`` runs as a mutating action job
(W1.2 section 13), is applied as one undoable step, and the saved file is checked on its own.
The web counts the comments first (``comments.flattenable``), so a document with none never runs
the job.

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
from pdfeditor.services.comments import flattenable
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


def open_bytes(data: bytes, name: str) -> str:
    reply, _ = call_raw(
        "session.open", {"name": name, "data": {"$bin": 0}, "password": None}, [data]
    )
    return str(ok(reply)["handle"])


def comment_count(handle: str) -> tuple[int, int]:
    result = ok(call_raw("comments.flattenable", {"handle": handle})[0])
    return int(result["count"]), int(result["pages"])


def flatten_and_save(handle: str) -> tuple[bytes, Any]:
    """Runs the flatten job as the web does, applies it, and returns the saved bytes."""
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
    assert ok(reply)["verified"] is True
    return saved_out[0], result


def test_flatten_job_removes_the_comments_and_round_trips(
    web: None, fixture_pdf: Any, tmp_path: Path
) -> None:
    handle = open_bytes(fixture_pdf("annotations").read_bytes(), "annotations.pdf")
    assert comment_count(handle) == (COMMENTS, 1)

    saved, result = flatten_and_save(handle)
    assert result["value"] == COMMENTS
    assert comment_count(handle) == (0, 0)  # the count the web reads after the flatten

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


def test_a_form_widget_survives_a_flatten(web: None, fixture_pdf: Any, tmp_path: Path) -> None:
    handle = open_bytes(fixture_pdf("annotations_form").read_bytes(), "annotations_form.pdf")
    saved, _ = flatten_and_save(handle)

    record("opens_pikepdf", saved)
    record("page_count_pikepdf", saved, pages=1)
    record("widget_named_pikepdf", saved, page=0, field="Name1", value="Ada")
    record("widget_count_pikepdf", saved, page=0, count=1)
    record("render_first_page_pdfium", saved)

    path = tmp_path / "flattened_form.pdf"
    path.write_bytes(saved)
    reopened = DocumentSession.open(path)
    try:
        with reopened.lock:
            assert flattenable(reopened.document) == (0, 0)
    finally:
        with reopened.lock:
            reopened.document.close()


def test_a_signed_document_keeps_its_signature_through_a_flatten(
    web: None, fixture_pdf: Any
) -> None:
    original = fixture_pdf("annotations_signed").read_bytes()
    handle = open_bytes(original, "annotations_signed.pdf")
    assert REGISTRY.get(handle).document.info().has_signatures
    assert comment_count(handle) == (COMMENTS, 1)

    saved, _ = flatten_and_save(handle)
    assert comment_count(handle) == (0, 0)

    # A save over the original is refused after a flatten: the snapshot spends the one incremental
    # update a signed file allows. It never turns into a silent rewrite; the copy is the way out.
    reply, _ = call_raw("save.save_bytes", {"handle": handle, "mode": "in_place"})
    assert reply["ok"] is False
    assert reply["error"]["code"] == "SAVE_FAILED"

    # The copy keeps the signature field and /SigFlags; the comments are gone from the annotation
    # list, but their drawing stays on the page: the square's red outline is still in the render.
    record("opens_pikepdf", saved)
    record("signed_form_pikepdf", saved, page=0, field="Sig1", flags=3)
    record("ink_region_pdfium", saved, page=0, clip=[72.0, 250.0, 200.0, 330.0])
    record("render_first_page_pdfium", saved)


def test_a_hidden_comment_stays_after_a_flatten(
    web: None, fixture_pdf: Any, tmp_path: Path
) -> None:
    handle = open_bytes(
        fixture_pdf("comments_flattenable_mixed").read_bytes(), "comments_flattenable_mixed.pdf"
    )
    assert comment_count(handle) == (COMMENTS - 1, 1)  # the hidden square is not counted

    saved, _ = flatten_and_save(handle)
    assert comment_count(handle) == (0, 0)

    path = tmp_path / "hidden_flattened.pdf"
    path.write_bytes(saved)
    reopened = DocumentSession.open(path)
    try:
        with reopened.lock:
            kinds = [annot.type.value for annot in reopened.document.page(0).annotations()]
    finally:
        with reopened.lock:
            reopened.document.close()
    assert kinds == ["Square"]  # the flattened comments are gone; the hidden square is still there


def test_a_document_without_comments_counts_zero(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf("images").read_bytes(), "images.pdf")
    assert comment_count(handle) == (0, 0)
