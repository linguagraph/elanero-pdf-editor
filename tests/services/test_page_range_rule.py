"""The page-range rule (services.pages) and the merge check it feeds (W6.3a).

The web's TypeScript port replays the same cases from web/test/vectors/page-ranges.json; these
tests pin the desktop side: the error kinds, the item as typed, and the ASCII-only numbers.
"""

from __future__ import annotations

import pytest

from pdfeditor.engine.registry import get_engine
from pdfeditor.services.assembly import MergeSource, SourcePagesError, merge
from pdfeditor.services.pages import PageRangeError, parse_page_ranges

ENGINE = get_engine()


@pytest.mark.parametrize(
    ("spec", "kind", "item"),
    [
        ("0", "invalid", "0"),
        ("3-2", "invalid", "3-2"),
        ("1-2-3", "invalid", "1-2-3"),
        ("1--3", "invalid", "1--3"),
        ("+3", "invalid", "+3"),
        ("1_0", "invalid", "1_0"),
        ("٣", "invalid", "٣"),
        ("x", "invalid", "x"),
        ("6", "out_of_range", "6"),
        ("8-", "out_of_range", "8-"),
        (",", "empty", ""),
    ],
)
def test_each_error_kind_names_the_item(spec: str, kind: str, item: str) -> None:
    with pytest.raises(PageRangeError) as info:
        parse_page_ranges(spec, 5)
    assert info.value.kind == kind
    assert info.value.item == item
    assert isinstance(info.value, ValueError)


def test_the_item_keeps_its_case_and_the_message_keeps_the_old_text() -> None:
    with pytest.raises(PageRangeError) as info:
        parse_page_ranges("1, Ab", 5)
    assert info.value.item == "Ab"
    with pytest.raises(PageRangeError) as info:
        parse_page_ranges("3-2", 5)
    assert str(info.value) == "page range '3-2' is outside 1-5"


@pytest.mark.parametrize(
    ("spec", "message"),
    [
        # Malformed items keep the text int() gave on main, lower-cased like the item.
        ("x", "invalid literal for int() with base 10: 'x'"),
        ("X", "invalid literal for int() with base 10: 'x'"),
        ("1-x", "invalid literal for int() with base 10: 'x'"),
        ("X-2", "invalid literal for int() with base 10: 'x'"),
        # The ASCII-only refusals reuse the same text, since int() would have taken them.
        ("+3", "invalid literal for int() with base 10: '+3'"),
        ("٣", "invalid literal for int() with base 10: '٣'"),
        # Range messages are main's, including int()'s 10 for "1_0" and the negative end of "1--3".
        ("1_0", "page range '1_0' is outside 1-5"),
        ("0", "page range '0' is outside 1-5"),
        ("3-2", "page range '3-2' is outside 1-5"),
        ("1--3", "page range '1--3' is outside 1-5"),
        ("6", "page range '6' is outside 1-5"),
        ("8-", "page range '8-' is outside 1-5"),
    ],
)
def test_desktop_messages_match_the_old_text(spec: str, message: str) -> None:
    with pytest.raises(PageRangeError) as info:
        parse_page_ranges(spec, 5)
    assert str(info.value) == message


def test_all_is_case_blind_and_blank_items_are_skipped() -> None:
    assert parse_page_ranges("ALL", 3) == [0, 1, 2]
    assert parse_page_ranges(" 1 ;; 3 ,", 3) == [0, 2]


def test_a_merge_source_with_no_pages_or_a_page_outside_raises_source_pages_error(
    fixture_pdf,
) -> None:
    pdf = fixture_pdf("text_multipage")
    for pages in ([], [99]):
        with pytest.raises(SourcePagesError) as info:
            merge(ENGINE, [MergeSource(pdf), MergeSource(pdf, pages=pages)])
        assert info.value.index == 1
        assert info.value.page_count >= 1
