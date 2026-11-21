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


def _item_bounds(typed: str, page_count: int) -> tuple[int, int]:
    """The 1-based inclusive span of one item; raises PageRangeError when it does not fit.

    The numbers are read with ``int()`` and the range checks run first, as they always have, so
    every desktop message (``int()``'s own text, page 0, a reversed span, out of range) matches
    the old code. Only then is the ASCII-digit rule applied, which refuses ``+3``, ``1_0`` and
    non-ASCII digits that ``int()`` would accept.
    """
    text = typed.lower()  # the messages have always shown the item lower-cased
    if "-" in text:
        lo_s, _, hi_s = text.partition("-")
        lo = _as_int(lo_s, typed) if lo_s.strip() else 1
        hi = _as_int(hi_s, typed) if hi_s.strip() else page_count
        explicit_lo, explicit_hi = bool(lo_s.strip()), bool(hi_s.strip())
        pieces = [p.strip() for p in (lo_s, hi_s) if p.strip()]
    else:
        lo = hi = _as_int(text, typed)
        explicit_lo = explicit_hi = True
        pieces = [text.strip()]
    ascii_only = all(_DIGITS.fullmatch(p) for p in pieces)
    if lo < 1 or hi > page_count or lo > hi:
        # The message is main's for every such item. The kind is "invalid" when the item is wrong
        # whatever the page count (page 0, a negative end, a reversed span, an ASCII refusal) and
        # "out_of_range" only for a page above the count.
        wrong = (
            (explicit_lo and lo < 1)
            or (explicit_hi and hi < 1)
            or (explicit_lo and explicit_hi and lo > hi)
            or not ascii_only
        )
        kind: PageRangeKind = "invalid" if wrong else "out_of_range"
        raise PageRangeError(kind, typed, f"page range {text!r} is outside 1-{page_count}")
    for piece in pieces:
        if not _DIGITS.fullmatch(piece):
            # int() accepted it, so the text is the one int() gives for a token it rejects.
            raise PageRangeError(
                "invalid", typed, f"invalid literal for int() with base 10: {piece!r}"
            )
    return lo, hi


def _as_int(piece: str, typed: str) -> int:
    """``int(piece)``, with its ValueError turned into a PageRangeError that keeps the text."""
    try:
        return int(piece)
    except ValueError as exc:
        raise PageRangeError("invalid", typed, str(exc)) from None


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
