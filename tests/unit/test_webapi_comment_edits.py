"""The Comments panel's reply and status calls (W7.1b S4) through dispatch, on the threaded fixture.

A reply and a status are ``annotations.reply`` (an AddAnnotationCommand linked to its parent by
``irt_name``), so each is one undo step and survives a save. The saved bytes are read back in
pikepdf (the /IRT link, /State and /StateModel) and rendered in pypdfium2, through the host checks
of ``tests.hostcheck``.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.webapi import jobs
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.hostcheck import record
from tests.unit.test_webapi_comments_list import NOTE_B
from tests.unit.test_webapi_jobs import call, ok, open_data
from tests.unit.test_webapi_save import saved_bytes

THREADED = "comments_threaded"
TEXT = "Looks good"


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


def reply(handle: str, text: str, state: str) -> dict[str, Any]:
    """Replies to note-b (which has no replies in the fixture) with text and/or a status."""
    args = {
        "parent": {"page": 0, "name": NOTE_B},
        "text": text,
        "author": "Eve",
        "state": state,
    }
    result: dict[str, Any] = ok(
        call("actions.run", {"handle": handle, "name": "annotations.reply", "args": args})
    )
    return result


def status_of_note_b(handle: str) -> str:
    threads = ok(call("comments.list", {"handle": handle}))["threads"]
    (note_b,) = (t for t in threads if t["comment"]["name"] == NOTE_B)
    status: str = note_b["status"]
    return status


def replies_of_note_b(handle: str) -> list[dict[str, Any]]:
    threads = ok(call("comments.list", {"handle": handle}))["threads"]
    (note_b,) = (t for t in threads if t["comment"]["name"] == NOTE_B)
    replies: list[dict[str, Any]] = note_b["replies"]
    return replies


def test_a_reply_and_a_status_are_saved_linked_to_their_parent(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf(THREADED).read_bytes(), "threaded.pdf")

    first = reply(handle, TEXT, "None")
    assert first["executed"] is True
    assert first["state"]["can_undo"] is True
    assert replies_of_note_b(handle)[0]["contents"] == TEXT
    assert replies_of_note_b(handle)[0]["author"] == "Eve"

    second = reply(handle, "", "Accepted")
    assert second["executed"] is True
    assert status_of_note_b(handle) == "Accepted"
    assert replies_of_note_b(handle)[1]["state"] == "Accepted"

    _, saved = saved_bytes(handle, "copy")
    record("comment_replies_pikepdf", saved, parent=NOTE_B, replies=[[TEXT, ""], ["", "Accepted"]])
    record("render_pdfium", saved, page=0, scale=1.0)


def test_undo_and_redo_remove_and_restore_the_reply_and_status(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf(THREADED).read_bytes(), "threaded.pdf")
    reply(handle, TEXT, "None")
    reply(handle, "", "Accepted")

    undone = ok(call("actions.undo", {"handle": handle}))
    assert undone["done"] is True
    assert status_of_note_b(handle) == "None"
    assert len(replies_of_note_b(handle)) == 1
    _, after_one = saved_bytes(handle, "copy")
    record("comment_replies_pikepdf", after_one, parent=NOTE_B, replies=[[TEXT, ""]])

    ok(call("actions.undo", {"handle": handle}))
    assert replies_of_note_b(handle) == []
    _, after_two = saved_bytes(handle, "copy")
    record("comment_replies_pikepdf", after_two, parent=NOTE_B, replies=[])
    record("render_pdfium", after_two, page=0, scale=1.0)

    redone = ok(call("actions.redo", {"handle": handle}))
    assert redone["done"] is True
    assert len(replies_of_note_b(handle)) == 1
    assert status_of_note_b(handle) == "None"
