"""Page-range parsing shared by print, export, split, extract and Combine (the page-range rule)."""

from __future__ import annotations

import re
from typing import Literal

PageRangeKind = Literal["invalid", "out_of_range", "empty"]

_DIGITS = re.compile(r"[0-9]+")  # ASCII only: int() would also take "+3", "1_0" and "٣"


class PageRangeError(ValueError):
    """A range the user typed does not fit the rule.

    ``kind`` is ``"invalid"`` (malformed, page 0 or a reversed span: wrong whatever the page
    count), ``"out_of_range"`` (a page above the count) or ``"empty"`` (no page chosen). ``item``
    is the item as typed, in its own case; empty for ``"empty"``. The message is the English text
    the desktop dialogs show.
    """

    def __init__(self, kind: PageRangeKind, item: str, message: str) -> None:
        super().__init__(message)
        self.kind: PageRangeKind = kind
        self.item = item


def parse_page_ranges(spec: str, page_count: int) -> list[int]:
    """Parse ``"1-3, 5, 8-"`` (1-based, inclusive) into sorted unique 0-based indices.

    ``"-4"`` means pages 1 to 4, ``"8-"`` means page 8 to the end, and ``"all"`` or an empty
    string means every page. Items are separated by ``,`` or ``;``; blank items are skipped.
    Raises PageRangeError for malformed or out-of-range input.
    """
    text = spec.strip()
    if text == "" or text.lower() == "all":
        return list(range(page_count))
    pages: set[int] = set()
    for raw in re.split(r"[,;]", text):
        item = raw.strip()
        if not item:
            continue
        lo, hi = _item_bounds(item, page_count)
        pages.update(range(lo - 1, hi))
    if not pages:
        raise PageRangeError("empty", "", "no pages selected")
    return sorted(pages)


def _item_bounds(item: str, page_count: int) -> tuple[int, int]:
    """The 1-based inclusive span of one item; raises PageRangeError when it does not fit."""
    if "-" in item:
        lo_s, _, hi_s = item.partition("-")
        lo_s, hi_s = lo_s.strip(), hi_s.strip()
        if (lo_s and not _DIGITS.fullmatch(lo_s)) or (hi_s and not _DIGITS.fullmatch(hi_s)):
            raise _malformed(item)
        lo = int(lo_s) if lo_s else 1
        hi = int(hi_s) if hi_s else page_count
        explicit_lo, explicit_hi = bool(lo_s), bool(hi_s)
    else:
        if not _DIGITS.fullmatch(item):
            raise _malformed(item)
        lo = hi = int(item)
        explicit_lo = explicit_hi = True
    if (
        (explicit_lo and lo == 0)
        or (explicit_hi and hi == 0)
        or (explicit_lo and explicit_hi and lo > hi)
    ):
        # Page 0 and reversed spans are wrong whatever the page count; the text is the old one.
        raise PageRangeError(
            "invalid", item, f"page range {item.lower()!r} is outside 1-{page_count}"
        )
    if lo > page_count or hi > page_count:
        raise PageRangeError(
            "out_of_range", item, f"page range {item.lower()!r} is outside 1-{page_count}"
        )
    return lo, hi


def _malformed(item: str) -> PageRangeError:
    return PageRangeError("invalid", item, f"page range {item.lower()!r} is not a valid range")


def format_page_ranges(indices: list[int]) -> str:
    """Inverse of :func:`parse_page_ranges` for display: ``[0,1,2,4]`` -> ``"1-3, 5"``."""
    out: list[str] = []
    run: list[int] = []
    for i in sorted(set(indices)):
        if run and i == run[-1] + 1:
            run.append(i)
            continue
        if run:
            out.append(_fmt(run))
        run = [i]
    if run:
        out.append(_fmt(run))
    return ", ".join(out)


def _fmt(run: list[int]) -> str:
    return str(run[0] + 1) if len(run) == 1 else f"{run[0] + 1}-{run[-1] + 1}"


def move_order(count: int, rows: list[int], before: int) -> tuple[list[int], list[int]]:
    """Move ``rows`` (kept in their order) so they sit before index ``before`` of the original
    numbering. Returns the new order (old indices, new position -> old index) and the moved
    rows' new positions."""
    moving = sorted(set(rows))
    rest = [i for i in range(count) if i not in moving]
    insert_at = sum(1 for i in rest if i < before)
    order = rest[:insert_at] + moving + rest[insert_at:]
    return order, list(range(insert_at, insert_at + len(moving)))
