"""The read-only outline call of W5.2 (bookmarks) through dispatch, on real fixtures."""

from __future__ import annotations

import json
import math
from collections.abc import Iterator
from typing import Any

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.model.geometry import Point
from pdfeditor.model.outline import Destination, OutlineItem
from pdfeditor.webapi import dispatch
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from pdfeditor.webapi.session import outline_entries
from tests.unit.test_webapi_session import handle_of, open_bytes


@pytest.fixture
def web() -> Iterator[None]:
    previous = model_platform.current()
    configure_web()
    try:
        yield
    finally:
        REGISTRY.close_all()
        model_platform.configure(previous)


def call(method: str, params: dict[str, Any]) -> dict[str, Any]:
    request = json.dumps({"v": 1, "id": 1, "method": method, "params": params})
    reply_json, out = dispatch(request, [])
    assert out == []
    return json.loads(reply_json)


def test_outline_lists_titles_pages_and_levels(web: None, fixture_pdf: Any) -> None:
    handle = handle_of(open_bytes(fixture_pdf("outline").read_bytes()))
    reply = call("session.outline", {"handle": handle})
    assert reply["ok"] is True, reply
    entries = reply["result"]["entries"]
    # Three chapters (level 1), each followed by its two sections (level 2); pages are zero-based.
    assert [(e["title"], e["level"], e["page"]) for e in entries] == [
        ("Chapter 1", 1, 0),
        ("Section 1.1", 2, 0),
        ("Section 1.2", 2, 1),
        ("Chapter 2", 1, 2),
        ("Section 2.1", 2, 2),
        ("Section 2.2", 2, 3),
        ("Chapter 3", 1, 4),
        ("Section 3.1", 2, 4),
        ("Section 3.2", 2, 5),
    ]
    assert all(isinstance(e["is_open"], bool) for e in entries)


def test_outline_of_a_document_without_bookmarks_is_empty(web: None, fixture_pdf: Any) -> None:
    handle = handle_of(open_bytes(fixture_pdf("text_multipage").read_bytes()))
    reply = call("session.outline", {"handle": handle})
    assert reply["ok"] is True, reply
    assert reply["result"] == {"entries": []}


def test_outline_needs_an_open_document(web: None) -> None:
    reply = call("session.outline", {"handle": "0" * 32})
    assert reply["ok"] is False
    assert reply["error"]["code"] == "NO_DOCUMENT"


def test_deep_levels_step_back_and_a_bookmark_without_destination(
    web: None, fixture_pdf: Any
) -> None:
    handle = handle_of(open_bytes(fixture_pdf("outline_irregular").read_bytes()))
    reply = call("session.outline", {"handle": handle})
    assert reply["ok"] is True, reply
    assert [(e["title"], e["level"], e["page"]) for e in reply["result"]["entries"]] == [
        ("Deep A", 1, 0),
        ("Deep B", 2, 1),
        ("Deep C", 3, 2),
        ("Back to B level", 2, 3),
        ("No destination", 1, None),
    ]


def test_destinations_outside_the_document_have_no_page() -> None:
    items = [
        OutlineItem(title="first", dest=Destination(page_index=0)),
        OutlineItem(title="last", dest=Destination(page_index=2)),
        OutlineItem(title="past the end", dest=Destination(page_index=3)),
        OutlineItem(title="negative", dest=Destination(page_index=-1)),
        OutlineItem(title="no destination", uri="https://example.org/"),
    ]
    entries = outline_entries(items, page_count=3)
    assert [(e.title, e.page) for e in entries] == [
        ("first", 0),
        ("last", 2),
        ("past the end", None),
        ("negative", None),
        ("no destination", None),
    ]


def test_outline_entries_follow_the_tree_depth() -> None:
    child = OutlineItem(title="child", dest=Destination(page_index=1))
    root = OutlineItem(title="root", dest=Destination(page_index=0), children=[child])
    entries = outline_entries([root], page_count=2)
    assert [(e.title, e.level) for e in entries] == [("root", 1), ("child", 2)]


def test_outline_entries_carry_the_destination_top() -> None:
    items = [
        OutlineItem(title="mid", dest=Destination(page_index=1, point=Point(0.0, 120.5))),
        OutlineItem(title="page top", dest=Destination(page_index=1)),
        OutlineItem(title="no page", dest=Destination(page_index=9, point=Point(0.0, 5.0))),
        OutlineItem(title="infinite", dest=Destination(page_index=0, point=Point(0.0, math.inf))),
        OutlineItem(title="link", uri="https://example.org/"),
    ]
    entries = outline_entries(items, page_count=3)
    assert [(e.title, e.top) for e in entries] == [
        ("mid", 120.5),
        ("page top", None),
        ("no page", None),
        ("infinite", None),
        ("link", None),
    ]
