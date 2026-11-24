"""Write the web's shared vectors from the desktop's Python code.

Text (W5.4 S1): the browser ports ``services.text`` (PageTextIndex queries, TextSelection) and
``services.search`` matching to TypeScript; this script runs the Python code over fixed text layers
and records the answers in ``web/test/vectors/text.json``.

Fonts (W7.6 slice B): the Fonts tab's compact page ranges are the desktop's ``page_ranges``; the
answers are recorded in ``web/test/vectors/font-pages.json``.

Layout (W5.1a S1): ``core/layout.py`` (compute_layout, layout_bounds, page_at) answers for fixed
page sizes, zooms and scroll positions, recorded in ``web/test/vectors/layout.json``. The mounting
window has no desktop counterpart, so its reference is written out in
``_window_reference``. Each layer is the worker's ``text.layer`` shape, cut to
its first lines and rounded to 3 decimals before the index is built, so the JSON holds exactly the
numbers the Python side answered with. Floats are compared on the web to 1e-6; the rest exactly.

    uv run python scripts/make_web_vectors.py          # rewrite the vectors file
    uv run python scripts/make_web_vectors.py --check  # exit 1 when the file is out of date
"""

from __future__ import annotations

import json
import sys
from dataclasses import replace
from pathlib import Path
from typing import Any, cast

from pdfeditor.core.layout import (
    PAGE_GAP,
    LayoutMode,
    compute_layout,
    layout_bounds,
    page_at,
    rotated_size,
)
from pdfeditor.core.session import DocumentSession
from pdfeditor.model.color import Color
from pdfeditor.model.geometry import Point, Rect
from pdfeditor.model.text import Block, Char, FontFlags, Line, SearchOptions, Span, TextPage
from pdfeditor.services.pages import PageRangeError, parse_page_ranges
from pdfeditor.services.search import SearchQuery, compile_query, search_index
from pdfeditor.services.text import (
    LINE_SEP,
    PageTextIndex,
    TextIndexCache,
    TextPos,
    TextSelection,
    _is_word_char,
)
from pdfeditor.ui.dialogs.properties import page_ranges

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures" / "generated"
OUTPUT = ROOT / "web" / "test" / "vectors" / "text.json"
LAYOUT_OUTPUT = ROOT / "web" / "test" / "vectors" / "layout.json"
PAGE_RANGES_OUTPUT = ROOT / "web" / "test" / "vectors" / "page-ranges.json"
FONT_PAGES_OUTPUT = ROOT / "web" / "test" / "vectors" / "font-pages.json"
# 0-based page lists for the Fonts tab's range text (the engine sends them ascending and unique).
FONT_PAGE_CASES: list[tuple[int, ...]] = [
    (),
    (0,),
    (0, 1),
    (0, 1, 2, 6),
    (0, 2, 4),
    (5, 4, 3),
    (0, 1, 3, 4, 5, 9),
    (7, 8),
    (0, 2, 3, 5, 6, 7, 9, 11, 12),
    (10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20),
]
HIT_TOLERANCE = 4.0
# (typed text, page count) for the page-range rule (services.pages): every branch of its grammar,
# its separators, and the error kinds. The web's TypeScript port replays them (W6.3a).
PAGE_RANGE_CASES: list[tuple[str, int]] = [
    ("", 5),
    ("all", 5),
    ("ALL", 5),
    ("   ", 5),
    ("all", 0),
    ("1-3, 5", 5),
    ("5, 1-2", 5),
    ("2;2,2", 5),
    ("1,,2", 5),
    ("1,2,", 5),
    (",", 5),
    (" , ", 5),
    ("-4", 5),
    ("8-", 5),
    ("-", 5),
    ("-", 0),
    ("1 - 3", 5),
    (" 2 ", 5),
    ("\t2\t", 5),
    ("3-2", 5),
    ("5-5", 5),
    ("0", 5),
    ("0-2", 5),
    ("2-0", 5),
    ("9", 5),
    ("1-99", 5),
    ("6-", 5),
    ("1", 0),
    ("1", 1),
    ("-", 1),
    ("1-", 1),
    ("1-2-3", 5),
    ("1--3", 5),
    ("+3", 5),
    ("1_0", 5),
    ("٣", 5),
    ("1.5", 5),
    ("x", 5),
    ("1-x", 5),
    ("all,1", 5),
    ("1000000000000000000000001-1000000000000000000000000", 5),
    ("1000000000000000000000000-", 5),
    ("0000000000000000000000000002", 5),
]
# (layer name, fixture, page index, lines kept): the first lines keep the file small.
PAGE_LAYERS = [
    ("text_multipage_p0", "text_multipage", 0, 6),
    ("text_multipage_p1", "text_multipage", 1, 6),
    ("text_multipage_p2", "text_multipage", 2, 6),
    ("rotated_p1", "rotated_pages", 1, 6),  # /Rotate 90
    ("rotated_p4", "rotated_pages", 4, 6),  # landscape page with a crop box
    ("two_columns_p0", "two_columns", 0, 6),  # embedded font, gutters made of spaces
    ("cjk_p0", "cjk_text", 0, 6),
    ("scanned_p0", "scanned", 0, 6),  # no text layer: every query answers "nothing"
]
# Word-rule samples: ASCII, combining, superscript, Nl, CJK, Arabic-Indic digit, soft hyphen,
# zero-width space, an astral emoji (a surrogate pair in UTF-16) and a CJK ideograph.
SAMPLE_CHARS = [
    "a",
    "Z",
    "5",
    "_",
    " ",
    "-",
    chr(0x301),
    chr(0xB2),
    chr(0x216B),
    chr(0x4E2D),
    chr(0x660),
    chr(0xAD),
    chr(0x200B),
    chr(0x1F600),
    chr(0x4E00),
]


def _round_rect(r: Rect) -> Rect:
    return Rect(round(r.x0, 3), round(r.y0, 3), round(r.x1, 3), round(r.y1, 3))


def _cut(page: TextPage, limit: int) -> TextPage:
    """The first ``limit`` lines with chars, with every box rounded to 3 decimals."""
    blocks: list[Block] = []
    count = 0
    for block in page.blocks:
        if block.is_image:
            continue
        lines: list[Line] = []
        for line in block.lines:
            if count >= limit or not any(s.chars for s in line.spans):
                continue
            spans = tuple(
                replace(
                    s,
                    chars=tuple(replace(c, bbox=_round_rect(c.bbox)) for c in s.chars),
                )
                for s in line.spans
            )
            lines.append(replace(line, spans=spans, bbox=_round_rect(line.bbox)))
            count += 1
        if lines:
            blocks.append(replace(block, lines=tuple(lines)))
    return replace(page, blocks=tuple(blocks))


def _synthetic(rows: list[str]) -> TextPage:
    """A hand-built page (no fixture) so surrogate pairs and separators are pinned exactly."""
    lines = []
    for row, text in enumerate(rows):
        chars = tuple(
            Char(c, Rect(10 + i * 10, 10 + row * 14, 20 + i * 10, 22 + row * 14), Point(0, 0))
            for i, c in enumerate(text)
        )
        box = Rect(10, 10 + row * 14, 10 + len(text) * 10, 22 + row * 14)
        span = Span(text, box, "Helv", 10.0, Color(0, 0, 0), FontFlags(0), Point(0, 0), chars)
        lines.append(Line((span,), box))
    return TextPage(0, 200.0, 200.0, (Block(Rect(0, 0, 200, 200), tuple(lines)),))


def _layers() -> dict[str, PageTextIndex]:
    out: dict[str, PageTextIndex] = {}
    for name, fixture, page_no, limit in PAGE_LAYERS:
        session = DocumentSession.open(FIXTURES / f"{fixture}.pdf")
        try:
            with session.lock:
                raw = session.document.page(page_no).text_page(with_chars=True)
        finally:
            session.close()
        out[name] = PageTextIndex(_cut(raw, limit))
    out["synthetic"] = PageTextIndex(_synthetic(["a\U0001f600b", "c d"]))
    return out


def _layer_json(index: PageTextIndex) -> dict[str, Any]:
    boxes: list[float] = []
    for ch in index.chars:
        if ch.c == LINE_SEP or ch.bbox.is_empty:
            boxes += [0.0, 0.0, 0.0, 0.0]
        else:
            boxes += [ch.bbox.x0, ch.bbox.y0, ch.bbox.x1, ch.bbox.y1]
    return {
        "text": index.text,
        "line_rects": [_rect(r) for r in index.line_rects],
        "char_boxes": boxes,
        "line_numbers": [ch.line for ch in index.chars],
    }


def _rect(r: Rect) -> list[float]:
    return [r.x0, r.y0, r.x1, r.y1]


def _pt(p: Point) -> list[float]:
    return [p.x, p.y]


def _sample(n: int, count: int = 12) -> list[int]:
    """Evenly spread indexes, plus the last char, so line ends and page ends are covered."""
    if n == 0:
        return []
    step = max(1, n // count)
    return sorted(set(range(0, n, step)) | {n - 1})


def _probe_points(index: PageTextIndex) -> list[Point]:
    points: list[Point] = []
    for i in _sample(len(index)):
        ch = index.chars[i]
        if ch.c != LINE_SEP and not ch.bbox.is_empty:
            c = ch.bbox.center
            points.append(Point(round(c.x, 3), round(c.y, 3)))
    for r in index.line_rects:
        mid = round((r.y0 + r.y1) / 2, 3)
        points.append(Point(round(r.x0 - 2.0, 3), mid))  # just left of a line
        points.append(Point(round(r.x1 + 30.0, 3), mid))  # well right of it
    points += [Point(-100.0, -100.0), Point(1000.0, 1000.0)]
    return points


def _case(fn: str, args: dict[str, Any], expect: Any, layer: str | None = None) -> dict[str, Any]:
    case: dict[str, Any] = {"fn": fn, "args": args, "expect": expect}
    if layer is not None:
        case["layer"] = layer
    return case


def _index_cases(name: str, index: PageTextIndex) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    n = len(index)
    for p in _probe_points(index):
        for tol in (HIT_TOLERANCE, 0.0):
            cases.append(
                _case("hit_test", {"p": _pt(p), "tolerance": tol}, index.hit_test(p, tol), name)
            )
        cases.append(_case("nearest", {"p": _pt(p)}, index.nearest(p), name))
    for i in _sample(n):
        cases.append(_case("word_range", {"i": i}, list(index.word_range(i)), name))
        cases.append(_case("line_range", {"i": i}, list(index.line_range(i)), name))
    for start, end in [(0, n)] + [(i, min(n, i + 30)) for i in _sample(n, 4)]:
        args = {"start": start, "end": end}
        cases.append(_case("rects", args, [_rect(r) for r in index.rects(start, end)], name))
        cases.append(_case("extract", args, index.extract(start, end), name))
    return cases


class _Pages:
    """Stands in for the engine-backed cache: ``TextSelection`` only calls ``get``."""

    def __init__(self, indexes: list[PageTextIndex]) -> None:
        self._indexes = indexes

    def get(self, page: int) -> PageTextIndex:
        return self._indexes[page]


def _selection_case(
    names: list[str],
    indexes: dict[str, PageTextIndex],
    anchor: tuple[int, int],
    focus: tuple[int, int],
) -> dict[str, Any]:
    sel = TextSelection(TextPos(*anchor), TextPos(*focus))
    cache = cast(TextIndexCache, _Pages([indexes[n] for n in names]))
    rects = sel.rects(cache)
    return {
        "fn": "selection",
        "layers": names,
        "args": {"anchor": list(anchor), "focus": list(focus)},
        "expect": {
            "page_spans": [list(s) for s in sel.page_spans(cache)],
            "page_rects": {str(p): [_rect(r) for r in rs] for p, rs in rects.items()},
            "text": sel.text(cache),
        },
    }


def _selection_cases(indexes: dict[str, PageTextIndex]) -> list[dict[str, Any]]:
    tm = [indexes[f"text_multipage_p{i}"] for i in range(3)]
    n0, _, n2 = (len(x) for x in tm)
    t = ["text_multipage_p0", "text_multipage_p1", "text_multipage_p2"]
    cases = [
        _selection_case(t[:1], indexes, (0, min(10, n0)), (0, n0 // 2)),  # across lines
        _selection_case(t[:2], indexes, (0, max(0, n0 - 20)), (1, 40)),  # across two pages
        _selection_case(t, indexes, (0, n0 // 2), (2, n2 // 3)),  # across three pages
        _selection_case(t[:2], indexes, (1, 40), (0, max(0, n0 - 20))),  # reversed drag
        _selection_case(t[:2], indexes, (0, n0), (1, 0)),  # ends at the start of page 1
        _selection_case(t[:1], indexes, (0, 3), (0, 3)),  # empty
        _selection_case(["rotated_p1"], indexes, (0, 0), (0, len(indexes["rotated_p1"]))),
        _selection_case(["rotated_p4"], indexes, (0, 0), (0, len(indexes["rotated_p4"]))),
        _selection_case(
            ["two_columns_p0"], indexes, (0, 5), (0, len(indexes["two_columns_p0"]) - 3)
        ),
        _selection_case(["cjk_p0"], indexes, (0, 0), (0, len(indexes["cjk_p0"]))),
        _selection_case(["scanned_p0"], indexes, (0, 0), (0, len(indexes["scanned_p0"]))),
        _selection_case(["synthetic"], indexes, (0, 1), (0, 3)),  # after the emoji
        _selection_case(["synthetic"], indexes, (0, 0), (0, len(indexes["synthetic"]))),
    ]
    return cases


def _search_cases(indexes: dict[str, PageTextIndex]) -> list[dict[str, Any]]:
    names = ["text_multipage_p0", "text_multipage_p1"]
    pages = [indexes[n] for n in names]
    text0 = pages[0].text
    k = text0.index(LINE_SEP)
    across = f"{text0[:k].rstrip().split()[-1]} {text0[k + 1 :].lstrip().split()[0]}"
    queries: list[tuple[str, SearchOptions]] = [
        ("Page", SearchOptions()),
        ("page", SearchOptions(case_sensitive=True)),
        ("Page", SearchOptions(whole_word=True)),
        (across, SearchOptions()),  # a match across a line break
        (r"[A-Z][a-z]+ \d", SearchOptions(regex=True)),
        ("zzz-no-such-text", SearchOptions()),
    ]
    cases = []
    for text, options in queries:
        pattern = compile_query(SearchQuery(text, options))
        hits: list[dict[str, Any]] = []
        for page, index in enumerate(pages):
            # The rules of services.search.search_index, with the match offsets kept for the web.
            found = search_index(index, pattern)
            matches = [
                m
                for m in pattern.finditer(index.text)
                if m.end() > m.start() and index.rects(m.start(), m.end())
            ]
            assert [m.group(0) for m in matches] == [h.text for h in found]
            for m, h in zip(matches, found, strict=True):
                rect = _rect(h.rect)
                hits.append(
                    {"page": page, "start": m.start(), "end": m.end(), "text": h.text, "rect": rect}
                )
        args = {
            "query": text,
            "case_sensitive": options.case_sensitive,
            "whole_word": options.whole_word,
            "regex": options.regex,
        }
        cases.append({"fn": "search", "layers": names, "args": args, "expect": hits})
    return cases


def _word_cases() -> list[dict[str, Any]]:
    return [
        {"fn": "is_word_char", "args": {"c": c}, "expect": _is_word_char(c)} for c in SAMPLE_CHARS
    ]


# Visible-space page sizes in points (after /Rotate): letter, landscape, a small page and A4.
LAYOUT_SETS: dict[str, list[tuple[float, float]]] = {
    "mixed": [(612.0, 792.0), (792.0, 612.0), (300.0, 400.0), (612.0, 792.0), (595.0, 842.0)],
    "landscape": [(792.0, 612.0), (842.0, 595.0), (792.0, 612.0), (792.0, 612.0)],
    "single_page": [(612.0, 792.0)],
    "empty": [],
}
# Unrotated sizes with a /Rotate of 90: the view receives the rotated sizes (session.pages).
PRE_ROTATED_SET = ("pre_rotated_90", [(612.0, 792.0), (792.0, 612.0), (300.0, 400.0)], 90)
LAYOUT_MODES = {
    "continuous": LayoutMode.CONTINUOUS,
    "single": LayoutMode.SINGLE,
    "two_up": LayoutMode.TWO_UP,
    "two_up_cover": LayoutMode.TWO_UP_COVER,
}
LAYOUT_ZOOMS = [0.5, 1.0, 2.25]
VIEWPORTS_PX = [300.0, 800.0]
SCROLL_FRACTIONS = [0.0, 0.37, 0.999]
CSS_PX_PER_PT = 96 / 72


def _window_reference(
    boxes_px: list[tuple[float, float]], scroll: float, vh: float
) -> dict[str, int]:
    """The mounting window written out: pages that touch [scroll - vh, scroll + 2 vh].

    One viewport above and below the view, as W1.4 section 7 asks. Pages are in reading order, so
    the range runs from the first page that touches the window to the last one.
    """
    lo, hi = scroll - vh, scroll + 2 * vh
    hits = [i for i, (top, height) in enumerate(boxes_px) if top + height >= lo and top <= hi]
    if not hits:
        return {"first": 0, "end": 0}
    return {"first": hits[0], "end": hits[-1] + 1}


def _layout_cases() -> list[dict[str, Any]]:
    sets = [(name, sizes, 0) for name, sizes in LAYOUT_SETS.items()] + [PRE_ROTATED_SET]
    cases: list[dict[str, Any]] = []
    for set_name, raw, rotation in sets:
        visible = [rotated_size(w, h, rotation) for w, h in raw]
        shown = [list(s) for s in visible]
        for mode_name, mode in LAYOUT_MODES.items():
            # The desktop answer for the unrotated sizes with /Rotate must equal the answer for the
            # rotated sizes the web receives, or the view would rotate twice.
            rects = compute_layout(raw, mode, rotation)
            assert rects == compute_layout(visible, mode), (set_name, mode_name)
            bounds = layout_bounds(rects)
            for zoom in LAYOUT_ZOOMS:
                cases.append(
                    {
                        "fn": "layout",
                        "set": set_name,
                        "mode": mode_name,
                        "zoom": zoom,
                        "sizes": shown,
                        "expect": {
                            "boxes": [_rect(r) for r in rects],
                            "width": bounds.x1,
                            "height": bounds.y1,
                        },
                    }
                )
            for index, rect in enumerate(rects):
                # The placeholder is the page's own size, whatever the spread centres it on.
                cases.append(
                    {
                        "fn": "placeholder",
                        "set": set_name,
                        "mode": mode_name,
                        "zoom": 1.0,
                        "index": index,
                        "sizes": shown,
                        "expect": list(visible[index]),
                    }
                )
                # go_to_page's target: half a page gap above the page's top edge, not below 0.
                cases.append(
                    {
                        "fn": "scroll_top_for_page",
                        "set": set_name,
                        "mode": mode_name,
                        "zoom": 1.0,
                        "index": index,
                        "sizes": shown,
                        "expect_pt": max(0.0, rect.y0 - PAGE_GAP / 2),
                    }
                )
            if not rects:
                continue
            boxes_px = [(r.y0 * CSS_PX_PER_PT, r.height * CSS_PX_PER_PT) for r in rects]
            total_pt = bounds.y1
            for vh_px in VIEWPORTS_PX:
                vh_pt = vh_px / CSS_PX_PER_PT
                for frac in SCROLL_FRACTIONS:
                    scroll_pt = round(frac * max(0.0, total_pt - vh_pt), 3)
                    scroll_px = scroll_pt * CSS_PX_PER_PT
                    base = {
                        "set": set_name,
                        "mode": mode_name,
                        "zoom": 1.0,
                        "sizes": shown,
                        "scroll": scroll_px,
                        "viewport": vh_px,
                    }
                    cases.append(
                        {
                            "fn": "window",
                            **base,
                            "expect": _window_reference(boxes_px, scroll_px, vh_px),
                        }
                    )
                    cases.append(
                        {
                            "fn": "current_page",
                            **base,
                            # _update_current_page: the page at a third of the way down the view.
                            "expect": page_at(rects, scroll_pt + vh_pt / 3),
                        }
                    )
    return cases


def _layout_doc() -> dict[str, Any]:
    return {
        "_about": (
            "Generated by scripts/make_web_vectors.py from pdfeditor.core.layout. Do not edit by "
            "hand. Sizes and boxes are visible-space points; CSS px = points * zoom * 96/72."
        ),
        "generator": "scripts/make_web_vectors.py",
        "format": 1,
        "constants": {"PAGE_GAP_PT": PAGE_GAP, "CSS_PX_PER_PT": CSS_PX_PER_PT},
        "notes": [
            "window: no desktop counterpart; the reference is _window_reference.",
            "current_page: the desktop rule (page at a third of the view), not the centre.",
            "scroll_top_for_page: the desktop go_to_page target, half a gap above the page.",
        ],
        "cases": _layout_cases(),
    }


def _layout_render() -> str:
    doc = _layout_doc()
    lines = ["{"]
    keys = list(doc)
    for n, key in enumerate(keys):
        value = doc[key]
        if key == "cases":
            body = "[\n" + ",\n".join(_compact(v) for v in value) + "\n]"
        else:
            body = _compact(value)
        comma = "," if n < len(keys) - 1 else ""
        lines.append(f"{_compact(key)}: {body}{comma}")
    lines.append("}")
    return "\n".join(lines) + "\n"


def build() -> dict[str, Any]:
    indexes = _layers()
    cases: list[dict[str, Any]] = []
    for name, index in indexes.items():
        cases += _index_cases(name, index)
    cases += _selection_cases(indexes)
    cases += _search_cases(indexes)
    cases += _word_cases()
    return {
        "_about": (
            "Generated by scripts/make_web_vectors.py from pdfeditor.services.text and "
            "pdfeditor.services.search. Do not edit by hand."
        ),
        "generator": "scripts/make_web_vectors.py",
        "format": 1,
        "constants": {"LINE_SEP": LINE_SEP, "HIT_TOLERANCE": HIT_TOLERANCE},
        "layers": {name: _layer_json(index) for name, index in indexes.items()},
        "cases": cases,
    }


def _compact(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def render() -> str:
    """One layer or case per line, so a change shows up as a readable diff."""
    doc = build()
    lines = ["{"]
    keys = list(doc)
    for n, key in enumerate(keys):
        value = doc[key]
        if key == "layers":
            body = "{\n" + ",\n".join(f"{_compact(k)}: {_compact(v)}" for k, v in value.items())
            body += "\n}"
        elif isinstance(value, list):
            body = "[\n" + ",\n".join(_compact(v) for v in value) + "\n]"
        else:
            body = _compact(value)
        comma = "," if n < len(keys) - 1 else ""
        lines.append(f"{_compact(key)}: {body}{comma}")
    lines.append("}")
    return "\n".join(lines) + "\n"


def _page_range_doc() -> dict[str, Any]:
    cases: list[dict[str, Any]] = []
    for text, count in PAGE_RANGE_CASES:
        expect: dict[str, Any]
        try:
            expect = {"pages": parse_page_ranges(text, count)}
        except PageRangeError as exc:
            expect = {"error": {"kind": exc.kind, "item": exc.item}}
        cases.append({"text": text, "page_count": count, "expect": expect})
    return {
        "_about": (
            "Generated by scripts/make_web_vectors.py from pdfeditor.services.pages "
            "(parse_page_ranges, the page-range rule). Do not edit by hand."
        ),
        "generator": "scripts/make_web_vectors.py",
        "format": 1,
        "cases": cases,
    }


def _page_range_render() -> str:
    doc = _page_range_doc()
    lines = ["{"]
    keys = list(doc)
    for n, key in enumerate(keys):
        value = doc[key]
        body = (
            "[\n" + ",\n".join(_compact(v) for v in value) + "\n]"
            if key == "cases"
            else _compact(value)
        )
        comma = "," if n < len(keys) - 1 else ""
        lines.append(f"{_compact(key)}: {body}{comma}")
    lines.append("}")
    return "\n".join(lines) + "\n"


def _font_pages_render() -> str:
    cases = [{"pages": list(pages), "text": page_ranges(pages)} for pages in FONT_PAGE_CASES]
    doc: dict[str, Any] = {
        "_about": (
            "Generated by scripts/make_web_vectors.py from pdfeditor.ui.dialogs.properties "
            "(page_ranges, the Fonts tab's page text). Do not edit by hand."
        ),
        "generator": "scripts/make_web_vectors.py",
        "format": 1,
        "cases": cases,
    }
    lines = ["{"]
    keys = list(doc)
    for n, key in enumerate(keys):
        value = doc[key]
        if key == "cases":
            body = "[\n" + ",\n".join(_compact(v) for v in value) + "\n]"
        else:
            body = _compact(value)
        comma = "," if n < len(keys) - 1 else ""
        lines.append(f"{_compact(key)}: {body}{comma}")
    lines.append("}")
    return "\n".join(lines) + "\n"


def main(argv: list[str]) -> int:
    outputs = [
        (OUTPUT, render()),
        (LAYOUT_OUTPUT, _layout_render()),
        (PAGE_RANGES_OUTPUT, _page_range_render()),
        (FONT_PAGES_OUTPUT, _font_pages_render()),
    ]
    if "--check" in argv:
        stale = [p for p, text in outputs if not p.exists() or p.read_text("utf-8") != text]
        for path in stale:
            print(f"{path} is out of date: run scripts/make_web_vectors.py", file=sys.stderr)
        if stale:
            return 1
        print("web vectors are up to date")
        return 0
    for path, text in outputs:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")
        print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
