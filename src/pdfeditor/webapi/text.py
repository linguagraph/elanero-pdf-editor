"""The text calls of W3.4: the text layer, selection to text, and search (W1.4 section 13).


Searching and selecting reuse the desktop's services (``services.search`` for the regex rules,
``services.text`` for the character index and the selection model), so the web and the desktop
find the same hits and copy the same text. Both are chunked (W1.2 section 9): a call does at most
``limits.TEXT_PAGES_PER_SLICE`` pages, or stops once ``budget_ms`` has passed (always after a
whole page), and returns a cursor for the next slice. A cursor is stateless and records the
document's page count, so one from before a change of page count fails with ``STALE_CURSOR``.

Every engine access holds the session lock for the part of the slice that touches it. The index
and the selection are plain Python built from the engine's ``TextPage``, so no engine object
leaves this module.
"""

from __future__ import annotations

import re
import sys
import time
from array import array
from typing import Any, NoReturn

from pdfeditor.core.session import DocumentSession
from pdfeditor.model.geometry import Quad, Rect
from pdfeditor.model.text import SearchHit, SearchOptions
from pdfeditor.services.search import SearchQuery, compile_query, search_index
from pdfeditor.services.text import LINE_SEP, PageTextIndex, TextIndexCache, TextPos, TextSelection
from pdfeditor.webapi import dto, limits
from pdfeditor.webapi.errors import INVALID_ARGS, STALE_CURSOR, RpcFailure
from pdfeditor.webapi.registry import REGISTRY

_SEARCH_CURSOR = re.compile(r"v(\d+):s(\d+):o(\d+)")
_EXTRACT_CURSOR = re.compile(r"v(\d+):p(\d+)")


def text_layer(params: dto.PageParams) -> dto.TextLayerResult:
    session = REGISTRY.get(params.handle)
    with session.lock:
        _check_page(session, params.page, "params.page")
        page = session.document.page(params.page)
        revision = page.revision
        index = PageTextIndex(page.text_page(with_chars=True))
    boxes: array[float] = array("f")
    numbers: array[int] = array("I")
    for ch in index.chars:
        if ch.c == LINE_SEP or ch.bbox.is_empty:
            boxes.extend((0.0, 0.0, 0.0, 0.0))
        else:
            boxes.extend((ch.bbox.x0, ch.bbox.y0, ch.bbox.x1, ch.bbox.y1))
        numbers.append(ch.line)
    return dto.TextLayerResult(
        revision=revision,
        text=index.text,
        line_rects=tuple(_rect(r) for r in index.line_rects),
        chars=_little_endian(boxes).tobytes() + _little_endian(numbers).tobytes(),
    )


def extract(params: dto.ExtractParams) -> dto.ExtractResult:
    """The text of a selection, one slice of pages at a time.

    Each page's piece comes from :class:`TextSelection` (the desktop's copy rule); the pieces
    are joined with ``LINE_SEP`` as :meth:`TextSelection.text` joins them. A caller joins the
    non-empty slice texts with ``LINE_SEP``; an empty slice adds nothing.
    """
    session = REGISTRY.get(params.handle)
    budget = _budget(params.budget_ms)
    began = time.monotonic()
    cache = TextIndexCache(session)
    with session.lock:
        count = session.document.page_count
        start = _text_pos(session, cache, params.start, "params.start")
        end = _text_pos(session, cache, params.end, "params.end")
        lo, hi = min(start, end), max(start, end)
        page = lo.page
        if params.cursor is not None:
            page = _parse_extract_cursor(params.cursor, count)
            if not lo.page <= page <= hi.page:
                _bad("params.cursor", "the cursor is outside the selection")
        pieces: list[str] = []
        pages = 0
        while page <= hi.page:
            first = lo.index if page == lo.page else 0
            last = hi.index if page == hi.page else len(cache.get(page))
            piece = TextSelection(TextPos(page, first), TextPos(page, last)).text(cache)
            if piece:
                pieces.append(piece)
            page += 1
            pages += 1
            if pages >= limits.TEXT_PAGES_PER_SLICE:
                break
            if (time.monotonic() - began) * 1000 >= budget:
                break
    done = page > hi.page
    return dto.ExtractResult(
        text=LINE_SEP.join(pieces),
        cursor=None if done else _extract_cursor(count, page),
        pages_done=page - lo.page,
        total=hi.page - lo.page + 1,
        done=done,
    )


def search(params: dto.SearchParams) -> dto.SearchResult:
    session = REGISTRY.get(params.handle)
    budget = _budget(params.budget_ms)
    pattern = _pattern(params)
    with session.lock:
        count = session.document.page_count
    if params.cursor is None:
        _check_start(params.start_page, count)
        start, offset = params.start_page, 0
    else:
        cursor_count, start, offset = _parse_search_cursor(params.cursor)
        if cursor_count != count:
            raise RpcFailure(STALE_CURSOR, "the document changed since the search started")
        if start != params.start_page:
            _bad("params.start_page", "the start page does not match the cursor")
        if offset > count:
            _bad("params.cursor", "the cursor is malformed")
    cache = TextIndexCache(session)
    hits: list[dto.SearchHitDto] = []
    began = time.monotonic()
    pages = 0
    while offset < count:
        page = (start + offset) % count
        with session.lock:
            index = cache.get(page)
        hits.extend(_hit(hit) for hit in search_index(index, pattern))
        offset += 1
        pages += 1
        if pages >= limits.TEXT_PAGES_PER_SLICE or len(hits) >= limits.MAX_HITS_PER_REPLY:
            break
        if (time.monotonic() - began) * 1000 >= budget:
            break
    done = offset >= count
    return dto.SearchResult(
        hits=tuple(hits),
        cursor=None if done else _search_cursor(count, start, offset),
        pages_done=offset,
        total=count,
        done=done,
    )


def _pattern(params: dto.SearchParams) -> re.Pattern[str]:
    if len(params.query) > limits.MAX_QUERY_CHARS:
        raise RpcFailure(
            INVALID_ARGS,
            "params.query: the search text is too long",
            {"path": "params.query", "max_chars": limits.MAX_QUERY_CHARS},
        )
    options = SearchOptions(
        case_sensitive=params.options.case_sensitive,
        whole_word=params.options.whole_word,
        regex=params.options.regex,
    )
    try:
        return compile_query(SearchQuery(params.query, options))
    except ValueError as exc:  # an empty search, or a regular expression that doesn't compile
        _bad("params.query", str(exc))


def _hit(hit: SearchHit) -> dto.SearchHitDto:
    return dto.SearchHitDto(
        page=hit.page_index,
        text=hit.text,
        context=hit.context,
        quads=tuple(_quad(q) for q in hit.quads),
    )


def _quad(q: Quad) -> dto.QuadDto:
    return dto.QuadDto(
        ul=dto.PointDto(q.ul.x, q.ul.y),
        ur=dto.PointDto(q.ur.x, q.ur.y),
        ll=dto.PointDto(q.ll.x, q.ll.y),
        lr=dto.PointDto(q.lr.x, q.lr.y),
    )


def _rect(r: Rect) -> dto.RectDto:
    return dto.RectDto(r.x0, r.y0, r.x1, r.y1)


def _text_pos(
    session: DocumentSession, cache: TextIndexCache, pos: dto.TextPosition, path: str
) -> TextPos:
    _check_page(session, pos.page, f"{path}.page")
    if pos.index < 0:
        _bad(f"{path}.index", "the index is negative")
    if pos.index > len(cache.get(pos.page)):
        _bad(f"{path}.index", "the index is past the end of the page's text")
    return TextPos(pos.page, pos.index)


def _check_page(session: DocumentSession, page: int, path: str) -> None:
    count = session.document.page_count
    if not 0 <= page < count:
        raise RpcFailure(
            INVALID_ARGS,
            f"{path}: the page is out of range",
            {"path": path, "pages": count},
        )


def _check_start(start: int, count: int) -> None:
    if not 0 <= start < max(count, 1):
        _bad("params.start_page", "the start page is out of range")


def _budget(budget_ms: int) -> int:
    if not limits.MIN_BUDGET_MS <= budget_ms <= limits.MAX_BUDGET_MS:
        raise RpcFailure(
            INVALID_ARGS,
            "params.budget_ms: the budget is out of range",
            {"path": "params.budget_ms", "min": limits.MIN_BUDGET_MS, "max": limits.MAX_BUDGET_MS},
        )
    return budget_ms


def _parse_search_cursor(cursor: str) -> tuple[int, int, int]:
    match = _SEARCH_CURSOR.fullmatch(cursor)
    if match is None:
        _bad("params.cursor", "the cursor is malformed")
    cursor_count, start, offset = (int(g) for g in match.groups())
    return cursor_count, start, offset


def _parse_extract_cursor(cursor: str, count: int) -> int:
    match = _EXTRACT_CURSOR.fullmatch(cursor)
    if match is None:
        _bad("params.cursor", "the cursor is malformed")
    cursor_count, page = (int(g) for g in match.groups())
    if cursor_count != count:
        raise RpcFailure(STALE_CURSOR, "the document changed since the copy started")
    return page


def _search_cursor(count: int, start: int, offset: int) -> str:
    return f"v{count}:s{start}:o{offset}"


def _extract_cursor(count: int, page: int) -> str:
    return f"v{count}:p{page}"


def _little_endian(values: array[Any]) -> array[Any]:
    # Typed arrays in the browser are little-endian; the bytes travel unchanged to them.
    if sys.byteorder == "big":
        values.byteswap()
    return values


def _bad(path: str, reason: str) -> NoReturn:
    # The message names the field and the rule, never the text that was searched or selected.
    raise RpcFailure(INVALID_ARGS, f"{path}: {reason}", {"path": path})
