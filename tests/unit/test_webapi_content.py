"""The web's ``content.objects`` call (W6.7a S1): the content objects of one page, read-only.

The list is checked against the engine's own ``content_objects()`` on the same page. The
document bytes and the undo history are compared before and after the call, since the call must
change neither.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.webapi import content
from pdfeditor.webapi.errors import INVALID_ARGS, NO_DOCUMENT
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.unit.test_webapi_jobs import call, error, ok, open_data


@pytest.fixture
def web() -> Iterator[None]:
    previous = model_platform.current()
    configure_web()
    try:
        yield
    finally:
        REGISTRY.close_all()
        model_platform.configure(previous)


def objects_of(handle: str, page: int) -> dict[str, Any]:
    return ok(call("content.objects", {"handle": handle, "page": page}))


def test_lists_the_engine_objects_of_a_page(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    result = objects_of(handle, 0)

    session = REGISTRY.get(handle)
    with session.lock:
        page = session.document.page(0)
        expected = page.content_objects()
        revision = page.revision

    assert result["revision"] == revision
    assert result["truncated"] is False
    assert [o["key"] for o in result["objects"]] == [o.key for o in expected]
    assert {o["type"] for o in result["objects"]} >= {"text", "image"}
    text = next(o for o in result["objects"] if o["type"] == "text")
    assert text["style"] is not None
    assert set(text["style"]) == {
        "font",
        "size",
        "color",
        "bold",
        "italic",
        "align",
        "line_height",
        "char_spacing",
        "word_spacing",
    }
    image = next(o for o in result["objects"] if o["type"] == "image")
    assert image["style"] is None
    assert image["image_size"][0] > 0 and image["image_size"][1] > 0
    assert set(image["bbox"]) == {"x0", "y0", "x1", "y1"}


def test_the_reply_is_truncated_at_the_cap(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    total = len(objects_of(handle, 0)["objects"])
    assert total > 2

    monkeypatch.setattr(content, "MAX_PAGE_OBJECTS", 2)
    capped = objects_of(handle, 0)
    assert len(capped["objects"]) == 2
    assert capped["truncated"] is True
    # The kept objects are the first ones the engine lists, so their keys are a prefix.
    assert [o["key"] for o in capped["objects"]] == [
        o["key"] for o in objects_of(handle, 0)["objects"][:2]
    ]


def test_a_bad_page_number_is_invalid_args(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    for page in (-1, 99):
        reply = call("content.objects", {"handle": handle, "page": page})
        err = error(reply)
        assert err["code"] == INVALID_ARGS
        assert err["details"]["path"] == "params.page"


def test_a_closed_handle_is_no_document(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    ok(call("session.close", {"handle": handle}))
    assert error(call("content.objects", {"handle": handle, "page": 0}))["code"] == NO_DOCUMENT


def test_the_call_changes_no_document_state(web: None, fixture_pdf: Any) -> None:
    """Read-only: no page revision moves, no history entry is made, the document stays clean.

    The saved bytes are not compared: two saves of the same document differ (MuPDF writes a new
    trailer ID and dates), so a byte comparison would not show what the call did.
    """
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    session = REGISTRY.get(handle)

    def state() -> tuple[tuple[int, ...], int, bool]:
        with session.lock:
            revisions = tuple(session.document.page(i).revision for i in range(session.page_count))
        return revisions, session.undo_stack.version, session.is_dirty

    before = state()
    for page in range(session.page_count):
        ok(call("content.objects", {"handle": handle, "page": page}))
    assert state() == before
    assert before[2] is False
