"""The web's shared text vectors (W5.4 S1) are current and cover the cases the web needs.

The generator needs the fixtures from ``scripts/make_fixtures.py``, so these run on the desktop
only (``desktop_only``); the web replays the committed JSON under Vitest.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import make_web_vectors  # noqa: E402

pytestmark = pytest.mark.desktop_only


@pytest.fixture(scope="module")
def vectors() -> dict[str, Any]:
    return json.loads(make_web_vectors.OUTPUT.read_text(encoding="utf-8"))


def _cases(vectors: dict[str, Any], fn: str) -> Iterator[dict[str, Any]]:
    return (c for c in vectors["cases"] if c["fn"] == fn)


def test_the_text_vectors_file_is_up_to_date(fixture_pdf: Callable[[str], Path]) -> None:
    fixture_pdf("text_multipage")  # the generator reads tests/fixtures/generated; ensure it exists
    assert make_web_vectors.main(["--check"]) == 0


def test_a_selection_across_lines_has_several_rects_on_one_page(vectors: dict[str, Any]) -> None:
    assert any(
        len(rects) >= 2
        for c in _cases(vectors, "selection")
        for rects in c["expect"]["page_rects"].values()
    )


def test_a_selection_across_pages_has_one_span_per_page(vectors: dict[str, Any]) -> None:
    spans = [c["expect"]["page_spans"] for c in _cases(vectors, "selection")]
    assert any(len(s) == 3 for s in spans), "expected a three-page selection"
    assert any(len(s) == 2 for s in spans), "expected a two-page selection"


def test_rotated_and_cropped_pages_are_covered(vectors: dict[str, Any]) -> None:
    used = {c["layer"] for c in vectors["cases"] if "layer" in c}
    assert {"rotated_p1", "rotated_p4"} <= used
    assert {"rotated_p1", "rotated_p4"} <= set(vectors["layers"])


def test_a_search_matches_across_a_line_break(vectors: dict[str, Any]) -> None:
    hits = [h for c in _cases(vectors, "search") for h in c["expect"]]
    assert any("\n" in h["text"] for h in hits)


def test_a_surrogate_pair_layer_counts_code_points(vectors: dict[str, Any]) -> None:
    text = vectors["layers"]["synthetic"]["text"]
    assert text == "a\U0001f600b\nc d"
    assert len(text) == 7  # code points, not UTF-16 units
