"""Sanitize through the web path (W7.4, slice S1): ``jobs.prepare``, the job worker, ``jobs.apply``
and ``save.save_bytes``, with each of the 11 categories as a leak test.

A category's content must be gone from the saved file's structure, its streams and its render.
Every saved file is checked through ``tests.hostcheck.record`` (pikepdf and pypdfium2 are
independent of MuPDF), and this module imports neither at module level, so the host replay can run
it under Pyodide. Forms must survive a sanitize (AGENTS: never silently flatten forms).
"""

from __future__ import annotations

import base64
from collections.abc import Callable, Iterator
from typing import Any

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.webapi import jobs
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
    sanitize_args,
)

CATEGORIES = (
    "metadata",
    "xmp",
    "javascript",
    "attachments",
    "links",
    "hidden_text",
    "comments",
    "form_data",
    "thumbnails",
    "hidden_layers",
    "off_page_text",
)
TITLE = "Confidential report"
INVISIBLE = "invisible OCR layer text"
Check = Callable[[bytes, bytes], None]  # (saved file, the original file)


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


def options(*on: str) -> dict[str, bool]:
    """All 11 option flags as the web sends them: the named categories on, the rest off."""
    return {name: name in on for name in CATEGORIES}


def sanitized(data: bytes, opts: dict[str, bool], mode: str = "copy") -> tuple[str, bytes]:
    """Sanitize ``data`` as one job, apply it, and return the saved bytes (``mode`` as save)."""
    handle = open_data(data, "doc.pdf")
    prepared, copy = prepare(handle, "action", sanitize_args(opts))
    reply, out = run_job("action", sanitize_args(opts), copy)
    result = ok(reply)
    ok(apply(handle, prepared["token"], binary(result["document"], out), result["label"], True))
    saved_reply, save_out = call_raw("save.save_bytes", {"handle": handle, "mode": mode})
    saved = ok(saved_reply)
    assert saved["incremental"] is False
    return handle, binary(saved["data"], save_out)


def rec(name: str, **args: Any) -> Check:
    """A check that records host check ``name`` on the saved file."""
    return lambda saved, _original: record(name, saved, **args)


def no_bytes(needle: str) -> Check:
    """The file's bytes lack ``needle`` (a JavaScript source is in a plain object, not a stream)."""

    def check(saved: bytes, _original: bytes) -> None:
        assert needle.encode() not in saved, needle

    return check


def same_render(saved: bytes, original: bytes) -> None:
    """Removing invisible content changed no page's render (the reference is the original)."""
    record("same_pages_as_pdfium", saved, reference=base64.b64encode(original).decode())


# Per category: the fixture, and the checks on the saved file that the category's content is gone.
# "sensitive" holds personal data, an attachment, a link, a note, invisible text and metadata;
# the others hold one kind of content each.
LEAKS: dict[str, tuple[str, list[Check]]] = {
    "metadata": (
        "sensitive",
        [
            rec("docinfo_lacks_key_pikepdf", key="/Title"),
            rec("docinfo_lacks_key_pikepdf", key="/Author"),
        ],
    ),
    "xmp": (
        "sensitive",
        [
            rec("sanitized_catalog_pikepdf", parts=["xmp"]),
            rec("streams_lack_pikepdf", needle="x:xmpmeta"),
        ],
    ),
    "javascript": (
        "sensitive",
        [rec("sanitized_catalog_pikepdf", parts=["javascript"]), no_bytes("app.alert")],
    ),
    "attachments": (
        "sensitive",
        [
            rec("sanitized_catalog_pikepdf", parts=["attachments"]),
            rec("streams_lack_pikepdf", needle="secret attachment"),
        ],
    ),
    "links": (
        "sensitive",
        [rec("sanitized_catalog_pikepdf", parts=["links"]), rec("comment_count_pikepdf", count=1)],
    ),
    "hidden_text": (
        "sensitive",
        [
            rec("doc_text_lacks_pdfium", text=INVISIBLE),
            rec("streams_lack_pikepdf", needle=INVISIBLE),
            rec("doc_text_contains_pdfium", text="Public paragraph that must survive."),
        ],
    ),
    "comments": (
        "sensitive",
        [no_bytes("Internal reviewer note"), rec("comment_count_pikepdf", count=1)],
    ),
    "form_data": ("annotations_form", [rec("form_fields_pikepdf", fields={"Name1": ""})]),
    "thumbnails": ("heavy", [rec("sanitized_catalog_pikepdf", parts=["thumbnails"])]),
    "hidden_layers": (
        "hidden_layers",
        [
            rec("doc_text_lacks_pdfium", text="secret", fold_case=True),
            rec("streams_lack_pikepdf", needle="secret"),
            rec("ocg_count_pikepdf", count=1),
            same_render,
        ],
    ),
    "off_page_text": (
        "off_page_text",
        [
            rec("doc_text_lacks_pdfium", text="secret", fold_case=True),
            rec("streams_lack_pikepdf", needle="secret"),
            rec("doc_text_contains_pdfium", text="Visible text stays"),
            same_render,
        ],
    ),
}


@pytest.mark.parametrize("category", CATEGORIES)
def test_each_category_removes_its_content(web: None, fixture_pdf: Any, category: str) -> None:
    fixture, checks = LEAKS[category]
    original = fixture_pdf(fixture).read_bytes()
    _, saved = sanitized(original, options(category))
    for check in checks:
        check(saved, original)
    record("render_size_pdfium", saved, page=0, scale=1)


@pytest.mark.parametrize("mode", ["copy", "in_place"])
def test_every_category_leaves_no_trace_in_the_saved_file(
    web: None, fixture_pdf: Any, mode: str
) -> None:
    original = fixture_pdf("sensitive").read_bytes()
    _, saved = sanitized(original, options(*CATEGORIES), mode)

    record("sanitized_catalog_pikepdf", saved, parts=["xmp", "attachments", "javascript"])
    record("sanitized_catalog_pikepdf", saved, parts=["links", "thumbnails"])
    record("docinfo_lacks_key_pikepdf", saved, key="/Title")
    record("docinfo_lacks_key_pikepdf", saved, key="/Author")
    for needle in ("secret attachment", "x:xmpmeta", INVISIBLE, "Internal reviewer note"):
        record("streams_lack_pikepdf", saved, needle=needle)
    record("doc_text_lacks_pdfium", saved, text=INVISIBLE)
    record("doc_text_contains_pdfium", saved, text="Jane Example")
    record("doc_text_contains_pdfium", saved, text="Public paragraph that must survive.")
    no_bytes("app.alert")(saved, original)
    no_bytes("Internal reviewer note")(saved, original)
    record("page_count_pikepdf", saved, pages=1)
    record("render_size_pdfium", saved, page=0, scale=1)


def test_options_that_are_off_keep_their_content(web: None, fixture_pdf: Any) -> None:
    """The job sends every flag: with hidden text and attachments off, both survive."""
    original = fixture_pdf("sensitive").read_bytes()
    _, saved = sanitized(
        original, options(*(c for c in CATEGORIES if c not in ("hidden_text", "attachments")))
    )
    record("doc_text_contains_pdfium", saved, text=INVISIBLE)
    assert b"secret.txt" in saved  # the attachment's file name (a plain object, not a stream)
    record("docinfo_lacks_key_pikepdf", saved, key="/Title")


def test_undo_brings_the_content_back_and_redo_removes_it_again(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_data(fixture_pdf("sensitive").read_bytes(), "sensitive.pdf")
    prepared, copy = prepare(handle, "action", sanitize_args(options(*CATEGORIES)))
    reply, out = run_job("action", sanitize_args(options(*CATEGORIES)), copy)
    result = ok(reply)
    ok(apply(handle, prepared["token"], binary(result["document"], out), result["label"], True))

    def saved() -> bytes:
        reply, save_out = call_raw("save.save_bytes", {"handle": handle, "mode": "copy"})
        return binary(ok(reply)["data"], save_out)

    record("docinfo_lacks_key_pikepdf", saved(), key="/Title")
    ok(call("actions.undo", {"handle": handle}))
    record("docinfo_title_pikepdf", saved(), title=TITLE)
    ok(call("actions.redo", {"handle": handle}))
    record("docinfo_lacks_key_pikepdf", saved(), key="/Title")


def test_form_fields_survive_a_sanitize_and_only_the_values_are_reset(
    web: None, fixture_pdf: Any
) -> None:
    original = fixture_pdf("annotations_form").read_bytes()
    _, saved = sanitized(original, options(*CATEGORIES))
    record("form_fields_pikepdf", saved, fields={"Name1": ""})
    record("render_size_pdfium", saved, page=0, scale=1)

    _, kept = sanitized(original, options(*(c for c in CATEGORIES if c != "form_data")))
    record("form_fields_pikepdf", kept, fields={"Name1": "Ada"})
