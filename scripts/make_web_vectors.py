"""Write the web's shared text vectors (W5.4 S1) from the desktop's text model.

The browser ports ``services.text`` (PageTextIndex queries, TextSelection) and ``services.search``
matching to TypeScript; this script runs the Python code over fixed text layers and records the
answers in ``web/test/vectors/text.json``. Each layer is the worker's ``text.layer`` shape, cut to
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

from pdfeditor.core.session import DocumentSession
from pdfeditor.model.color import Color
from pdfeditor.model.geometry import Point, Rect
from pdfeditor.model.text import Block, Char, FontFlags, Line, SearchOptions, Span, TextPage
from pdfeditor.services.search import SearchQuery, compile_query, search_index
from pdfeditor.services.text import (
    LINE_SEP,
    PageTextIndex,
    TextIndexCache,
    TextPos,
    TextSelection,
    _is_word_char,
)

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures" / "generated"
OUTPUT = ROOT / "web" / "test" / "vectors" / "text.json"
HIT_TOLERANCE = 4.0
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


def main(argv: list[str]) -> int:
    text = render()
    if "--check" in argv:
        current = OUTPUT.read_text(encoding="utf-8") if OUTPUT.exists() else ""
        if current != text:
            print(f"{OUTPUT} is out of date: run scripts/make_web_vectors.py", file=sys.stderr)
            return 1
        print("web text vectors are up to date")
        return 0
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(text, encoding="utf-8", newline="\n")
    print(f"wrote {OUTPUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
