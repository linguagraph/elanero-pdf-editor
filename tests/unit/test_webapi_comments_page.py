"""The web's ``comments.page`` call (W7.1a slice 2): one page's comment threads, read-only.

The threads are the panel's threads (``page_threads``) for that page, each with its tight bounds
and the Select tool's movable and resizable flags, so the browser's hit testing and handles use
the same rules as the desktop.
"""

from __future__ import annotations

from typing import Any

import pytest

from pdfeditor.webapi.errors import INVALID_ARGS, NO_DOCUMENT
from tests.unit.test_webapi_comments_list import THREADED, listed, web  # noqa: F401
from tests.unit.test_webapi_jobs import call, error, ok, open_data

# comments_flags (scripts/make_fixtures.py): page 0 has a highlight, a hidden and a locked note.
FLAGS = "comments_flags"


def page_of(handle: str, page: int) -> dict[str, Any]:
    result: dict[str, Any] = ok(call("comments.page", {"handle": handle, "page": page}))
    return result


def test_each_page_lists_the_panel_threads_of_that_page(web: None, fixture_pdf: Any) -> None:  # noqa: F811
    handle = open_data(fixture_pdf(THREADED).read_bytes(), "threaded.pdf")
    panel = listed(handle)["threads"]
    for page in (0, 1):
        result = page_of(handle, page)
        expected = [t for t in panel if t["comment"]["page"] == page]
        assert [t["comment"]["name"] for t in result["threads"]] == [
            t["comment"]["name"] for t in expected
        ]
        for got, want in zip(result["threads"], expected, strict=True):
            assert got["replies"] == want["replies"]
            assert isinstance(result["revision"], int)


def test_notes_have_tight_bounds_and_the_select_rules(web: None, fixture_pdf: Any) -> None:  # noqa: F811
    handle = open_data(fixture_pdf(THREADED).read_bytes(), "threaded.pdf")
    threads = page_of(handle, 0)["threads"]
    assert threads
    for thread in threads:
        comment = thread["comment"]
        assert comment["hidden"] is False
        assert comment["movable"] is True  # a note can move
        assert comment["resizable"] is False  # but keeps its icon size
        assert comment["bounds"] == comment["rect"]


def test_markup_hidden_and_locked_comments_follow_the_select_rules(
    web: None,  # noqa: F811
    fixture_pdf: Any,
) -> None:
    handle = open_data(fixture_pdf(FLAGS).read_bytes(), "flags.pdf")
    by_name = {t["comment"]["name"]: t["comment"] for t in page_of(handle, 0)["threads"]}

    # The highlight's quad (x 72-200, y 630-610 in PDF space) is inside its /Rect (72-300, 600-640).
    # The page is A4 (842 pt tall), so the visible y runs from 842 - 630 to 842 - 610.
    highlight = by_name["markup-a"]
    assert highlight["movable"] is False  # text markup never moves
    assert highlight["bounds"] == pytest.approx(
        {"x0": 72.0, "y0": 842.0 - 630.0, "x1": 200.0, "y1": 842.0 - 610.0}, abs=0.01
    )
    assert highlight["bounds"] != highlight["rect"]

    hidden = by_name["hidden-a"]
    assert hidden["hidden"] is True  # FLAG_HIDDEN: never hit
    assert hidden["movable"] is True  # hidden is not locked: the rules are unchanged

    locked = by_name["locked-a"]
    assert locked["hidden"] is False
    assert locked["movable"] is False  # locked comments do not move
    assert locked["resizable"] is False  # nor resize


def test_a_page_without_comments_is_empty(web: None, fixture_pdf: Any) -> None:  # noqa: F811
    handle = open_data(fixture_pdf("images").read_bytes(), "images.pdf")
    result = page_of(handle, 0)
    assert result["threads"] == []
    assert isinstance(result["revision"], int)


def test_a_page_out_of_range_is_invalid_args(web: None, fixture_pdf: Any) -> None:  # noqa: F811
    handle = open_data(fixture_pdf(THREADED).read_bytes(), "threaded.pdf")
    assert error(call("comments.page", {"handle": handle, "page": 99}))["code"] == INVALID_ARGS


def test_an_unknown_handle_is_no_document(web: None) -> None:  # noqa: F811
    assert error(call("comments.page", {"handle": "nope", "page": 0}))["code"] == NO_DOCUMENT
