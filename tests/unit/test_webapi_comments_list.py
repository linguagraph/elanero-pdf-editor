"""The web's ``comments.list`` call (W7.1b S1): the comment threads of the document, read-only.

The order and the replies are the desktop panel's (``comment_threads``): page, then y, then x, with
each thread's replies oldest first. The call runs no Command, so the bytes, the page revisions and
the history stay as they were.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from typing import Any

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.webapi import actions, jobs
from pdfeditor.webapi.errors import INVALID_ARGS, NO_DOCUMENT
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.unit.test_webapi_jobs import binary, call, call_raw, error, ok, open_data

THREADED = "comments_threaded"
# comments_threaded (scripts/make_fixtures.py): page 1 has note-b above note-a, and note-a has the
# text reply reply-a1 and the status-only reply reply-a2; page 2 has note-c.
NOTE_A = "note-a"
NOTE_B = "note-b"
NOTE_C = "note-c"
REPLIES_OF_A = ["reply-a1", "reply-a2"]


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


def listed(handle: str) -> dict[str, Any]:
    result: dict[str, Any] = ok(call("comments.list", {"handle": handle}))
    return result


def names(threads: list[dict[str, Any]]) -> list[str]:
    return [t["comment"]["name"] for t in threads]


def test_a_document_without_comments_lists_nothing(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("images").read_bytes(), "images.pdf")
    assert listed(handle) == {"threads": [], "truncated": False}


def test_comments_come_back_in_page_order_with_author_date_page_and_text(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_data(fixture_pdf(THREADED).read_bytes(), "threaded.pdf")
    result = listed(handle)
    assert result["truncated"] is False
    # Page 1 first, then by y: note-b (top) before note-a; page 2 last.
    assert names(result["threads"]) == [NOTE_B, NOTE_A, NOTE_C]
    note_b, note_a, note_c = (t["comment"] for t in result["threads"])

    assert (note_b["page"], note_b["author"], note_b["contents"]) == (0, "Cy", "Check the heading")
    assert note_b["type"] == "Text"
    assert note_b["created"].startswith("2026-01-01T11:00:00")
    assert note_b["rect"] == {"x0": 72.0, "y0": 80.0, "x1": 88.0, "y1": 96.0}

    assert (note_a["page"], note_a["author"], note_a["contents"]) == (
        0,
        "Ada",
        "Please check the total",
    )
    assert note_a["created"].startswith("2026-01-01T10:00:00")

    assert (note_c["page"], note_c["author"], note_c["contents"]) == (1, "Dee", "On page two")


def test_replies_come_back_under_their_parent_oldest_first(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf(THREADED).read_bytes(), "threaded.pdf")
    threads = {t["comment"]["name"]: t for t in listed(handle)["threads"]}
    replies = threads[NOTE_A]["replies"]
    # reply-a1 is dated 2 January and reply-a2 3 January, so the text reply comes first.
    assert [r["name"] for r in replies] == REPLIES_OF_A
    assert replies[0]["author"] == "Bob"
    assert replies[0]["contents"] == "Fixed it"
    assert replies[0]["created"].startswith("2026-01-02T09:00:00")
    assert threads[NOTE_B]["replies"] == []
    assert threads[NOTE_C]["replies"] == []


def test_the_thread_status_is_the_latest_state(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf(THREADED).read_bytes(), "threaded.pdf")
    threads = {t["comment"]["name"]: t for t in listed(handle)["threads"]}
    assert threads[NOTE_A]["status"] == "Accepted"
    assert threads[NOTE_B]["status"] == "None"
    status_reply = threads[NOTE_A]["replies"][1]
    assert status_reply["state"] == "Accepted"
    assert status_reply["contents"] == ""


def test_the_list_changes_nothing(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf(THREADED).read_bytes(), "threaded.pdf")
    session = REGISTRY.get(handle)

    def state() -> tuple[bytes, list[int], int]:
        reply, out = call_raw("save.save_bytes", {"handle": handle, "mode": "copy"})
        # MuPDF writes a new random trailer /ID on every save, so it is left out of the bytes.
        data = re.sub(rb"/ID\[[^\]]*\]", b"", binary(ok(reply)["data"], out))
        revisions = [session.document.page(i).revision for i in range(session.document.page_count)]
        return data, revisions, session.undo_stack.version

    before = state()
    listed(handle)
    listed(handle)
    assert state() == before


def test_a_cap_at_the_total_lists_everything(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle = open_data(fixture_pdf(THREADED).read_bytes(), "threaded.pdf")
    # Five entries in all: three roots and the two replies of note-a.
    monkeypatch.setattr(actions, "MAX_COMMENT_ENTRIES", 5)
    result = listed(handle)
    assert result["truncated"] is False
    assert len(result["threads"]) == 3


def test_a_cap_below_the_total_leaves_whole_threads_out(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle = open_data(fixture_pdf(THREADED).read_bytes(), "threaded.pdf")
    # note-b (1) and note-a with its two replies (3) make 4, which fits; note-c would make 5,
    # past the cap, so it is left out and the flag is set.
    monkeypatch.setattr(actions, "MAX_COMMENT_ENTRIES", 4)
    result = listed(handle)
    assert result["truncated"] is True
    assert names(result["threads"]) == [NOTE_B, NOTE_A]
    assert len(result["threads"][1]["replies"]) == 2


def test_a_cap_that_cuts_a_thread_drops_the_thread_and_its_replies(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle = open_data(fixture_pdf(THREADED).read_bytes(), "threaded.pdf")
    # note-b (1) fits; note-a with its two replies (3) would make 4, past the cap of 3.
    monkeypatch.setattr(actions, "MAX_COMMENT_ENTRIES", 3)
    result = listed(handle)
    assert result["truncated"] is True
    assert names(result["threads"]) == [NOTE_B]


def test_an_unknown_handle_is_no_document(web: None) -> None:
    assert error(call("comments.list", {"handle": "nope"}))["code"] == NO_DOCUMENT


def test_a_closed_handle_is_no_document(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf(THREADED).read_bytes(), "threaded.pdf")
    assert listed(handle)["threads"]
    ok(call("session.close", {"handle": handle}))
    assert error(call("comments.list", {"handle": handle}))["code"] == NO_DOCUMENT


def test_an_extra_param_is_invalid_args(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf(THREADED).read_bytes(), "threaded.pdf")
    assert error(call("comments.list", {"handle": handle, "page": 0}))["code"] == INVALID_ARGS
