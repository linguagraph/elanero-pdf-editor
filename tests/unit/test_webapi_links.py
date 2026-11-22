"""The read-only link list of W5.3 (``session.links``) through dispatch, on fixtures.

The rects are checked against the text layer's boxes for the same anchor text, so a rotated page
must give visible-space rects (the same check as the text layer's rotated test).
"""

from __future__ import annotations

import re
import struct
from collections.abc import Iterator
from typing import Any

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.model.geometry import Point, Rect
from pdfeditor.model.outline import Destination, Link, LinkKind
from pdfeditor.webapi.errors import INVALID_ARGS, NO_DOCUMENT
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from pdfeditor.webapi.session import MAX_LINKS_PER_PAGE, MAX_URI_CHARS, link_entries
from tests.unit.test_webapi_text import call, call_raw, error, ok, open_bytes, split_chars


@pytest.fixture
def web() -> Iterator[None]:
    previous = model_platform.current()
    configure_web()
    try:
        yield
    finally:
        REGISTRY.close_all()
        model_platform.configure(previous)


def links_of(handle: str, page: int) -> dict[str, Any]:
    return ok(call("session.links", {"handle": handle, "page": page}))


def text_boxes(handle: str, page: int) -> tuple[str, list[tuple[float, ...]]]:
    reply, _, out = call_raw("text.layer", {"handle": handle, "page": page})
    text = ok(reply)["text"]
    box_bytes, _ = split_chars(out)
    values = struct.unpack(f"<{4 * len(text)}f", box_bytes)
    return text, [tuple(values[i : i + 4]) for i in range(0, len(values), 4)]


def union_of(boxes: list[tuple[float, ...]]) -> tuple[float, ...]:
    return (
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    )


def as_tuple(rect: dict[str, float]) -> tuple[float, ...]:
    return (rect["x0"], rect["y0"], rect["x1"], rect["y1"])


def test_outline_page_lists_goto_and_uri_links(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf, "outline")
    result = links_of(handle, 0)
    assert set(result) == {"revision", "links", "truncated"}
    assert result["truncated"] is False
    by_kind = {link["kind"]: link for link in result["links"]}
    goto = by_kind["goto"]
    assert goto["page"] == 3
    assert goto["top"] == pytest.approx(50)
    assert goto["uri"] == ""
    assert as_tuple(goto["rect"]) == pytest.approx((72, 100, 200, 120), abs=0.5)
    uri = by_kind["uri"]
    assert uri["uri"] == "https://example.org/"
    assert uri["page"] is None and uri["top"] is None
    assert as_tuple(uri["rect"]) == pytest.approx((72, 130, 200, 150), abs=0.5)


def test_page_without_links_is_empty(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf, "rotated_pages")
    assert links_of(handle, 0)["links"] == []


def test_rotated_page_rects_match_the_text_layer(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf, "links_rotated")
    text, boxes = text_boxes(handle, 0)
    links = links_of(handle, 0)["links"]
    assert len(links) == 3
    for anchor in ("Go to page 2", "Visit example.org", "Unnamed destination"):
        start = text.index(anchor)
        expected = union_of(boxes[start : start + len(anchor)])
        assert any(
            all(
                a == pytest.approx(e, abs=2.0)
                for a, e in zip(as_tuple(link["rect"]), expected, strict=True)
            )
            for link in links
        ), (anchor, expected, links)
    # Before the 90 degree turn the anchors sit near the left edge (x about 72); visible space
    # puts them near the right edge of the page, so x0 is far past the unrotated value.
    assert all(link["rect"]["x0"] > 600 for link in links)


def test_rotated_page_targets_and_kinds(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf, "links_rotated")
    first = links_of(handle, 0)["links"]
    (resolved,) = (link for link in first if link["kind"] == "goto")
    assert resolved["page"] == 1
    assert resolved["top"] == pytest.approx(50)
    assert [link["uri"] for link in first if link["kind"] == "uri"] == ["https://example.org/"]
    assert [link["kind"] for link in first if link["page"] is None].count("unsupported") == 1
    second = links_of(handle, 1)["links"]
    assert sorted((link["kind"], link["uri"]) for link in second) == [
        ("unsupported", ""),  # the Launch action: no file name leaves Python
        ("uri", "https://"),  # no host: the raw string is kept; the web judges it as malformed
        ("uri", "javascript:alert(1)"),  # the raw string; the web blocks it
    ]


def test_launch_target_never_leaves_python(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf, "links_rotated")
    reply, reply_json, _ = call_raw("session.links", {"handle": handle, "page": 1})
    ok(reply)
    assert "tool.exe" not in reply_json


def test_out_of_range_page_and_bad_handle_are_errors(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf, "links_rotated")
    err = error(call("session.links", {"handle": handle, "page": 2}))
    assert err["code"] == INVALID_ARGS
    assert err["details"] == {"path": "params.page", "pages": 2}
    assert error(call("session.links", {"handle": "0" * 32, "page": 0}))["code"] == NO_DOCUMENT


def without_trailer_id(data: bytes) -> bytes:
    """A save writes a new random second /ID each time; the rest of the bytes must match."""
    return re.sub(rb"/ID\s*\[[^\]]*\]", b"", data)


def test_listing_changes_no_document(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf, "links_rotated")
    before_bytes = call_raw("save.save_bytes", {"handle": handle, "mode": "copy"})[2][0]
    before = [links_of(handle, page)["revision"] for page in (0, 1)]
    for page in (0, 1):
        reply, _, _ = call_raw("session.links", {"handle": handle, "page": page})
        assert reply["events"] == []
    after = [links_of(handle, page)["revision"] for page in (0, 1)]
    after_bytes = call_raw("save.save_bytes", {"handle": handle, "mode": "copy"})[2][0]
    assert after == before
    assert without_trailer_id(after_bytes) == without_trailer_id(before_bytes)


def test_link_conversion_drops_degenerate_rects_and_limits_uris() -> None:
    good = Rect(10, 10, 50, 30)
    long_uri = "https://example.org/" + "a" * MAX_URI_CHARS
    entries, truncated = link_entries(
        [
            Link(rect=Rect(5, 5, 5, 30), kind=LinkKind.URI, uri="https://degenerate.example/"),
            Link(rect=good, kind=LinkKind.GOTO, dest=Destination(7, Point(0, 9))),
            Link(rect=good, kind=LinkKind.GOTO, dest=Destination(0, Point(1, float("nan")))),
            Link(rect=good, kind=LinkKind.URI, uri=long_uri),
            Link(rect=good, kind=LinkKind.GOTO_REMOTE, file="secret.pdf"),
            Link(rect=good, kind=LinkKind.NAMED, named="NextPage"),
        ],
        page_count=3,
    )
    assert truncated is False
    assert [(e.kind, e.page, e.top) for e in entries] == [
        ("goto", None, 9.0),  # page 7 is past the end of a 3-page document
        ("goto", 0, None),  # a NaN point gives no top
        ("unsupported", None, None),  # a URI over the limit
        ("unsupported", None, None),  # a remote file
        ("unsupported", None, None),  # a named action
    ]
    assert all(e.uri == "" for e in entries if e.kind != "uri")

    many = [Link(rect=good, kind=LinkKind.URI, uri="https://example.org/")] * (
        MAX_LINKS_PER_PAGE + 3
    )
    entries, truncated = link_entries(many, page_count=1)
    assert len(entries) == MAX_LINKS_PER_PAGE and truncated is True
