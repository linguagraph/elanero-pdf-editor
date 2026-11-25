"""Rendering regression tests against reference PNGs in tests/golden/data.

Create or refresh references (on Windows, the reference platform) with:
    uv run pytest tests/golden --update-goldens
A missing reference fails until it has been generated and committed. Failing comparisons write
the actual image to tests/golden/_actual/ for inspection.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from pdfeditor.engine.base import ColorMode, Document, RenderRequest
from pdfeditor.engine.registry import get_engine
from pdfeditor.model.color import Color
from pdfeditor.model.geometry import Matrix
from pdfeditor.model.redaction import RedactOptions
from pdfeditor.services.redaction import MarkStyle, mark_for_area
from tests.golden.compare import Tolerance, compare, save_png

DATA = Path(__file__).parent / "data"
ACTUAL = Path(__file__).parent / "_actual"
UPDATE_HINT = "uv run pytest tests/golden --update-goldens"
REDACTED = "sensitive-redacted"  # the redaction case: fixture "sensitive", email filled in memory

CASES = [
    ("text_multipage", 0),
    ("images", 0),
    ("vector_art", 0),
    ("annotations", 0),
    ("annotations_form", 0),
    ("rotated_pages", 1),
    ("rotated_pages", 4),
    ("rotated_cropped", 1),
    ("rotated_cropped", 6),
    ("cjk_text", 0),
    ("layers", 0),
    (REDACTED, 0),
]

# Tolerances absorb anti-aliasing differences between MuPDF builds/platforms.
TOLERANCE = Tolerance(max_mean=1.5, max_bad_fraction=0.004)


def _redact_email(doc: Document) -> None:
    """Mark the email address and apply the mark in memory (no save, no temporary file)."""
    page = doc.page(0)
    style = MarkStyle(fill=Color(0, 0, 0))  # explicit: the reference depends on the fill colour
    quads = page.search("jane.example@example.com")
    assert quads, "the fixture's email text was not found: the redaction case would not redact"
    for quad in quads:
        page.add_annotation(mark_for_area(0, quad.rect, style))
    page.apply_redactions(None, RedactOptions())


def render(name: str, page: int, fixture_pdf) -> np.ndarray:
    fixture = "sensitive" if name == REDACTED else name
    doc = get_engine().open(fixture_pdf(fixture))
    try:
        if name == REDACTED:
            _redact_email(doc)
        result = doc.page(page).render(RenderRequest(matrix=Matrix.scale(1.0), color=ColorMode.RGB))
    finally:
        doc.close()
    arr = np.frombuffer(result.samples, dtype=np.uint8).reshape(result.height, result.stride)
    return arr[:, : result.width * 3].reshape(result.height, result.width, 3).copy()


def _ref_name(name: str, page: int) -> str:
    return f"{name}-p{page}.png"


@pytest.mark.parametrize(("name", "page"), CASES, ids=[f"{n}-p{p}" for n, p in CASES])
def test_render_matches_golden(name: str, page: int, fixture_pdf, request) -> None:
    actual = render(name, page, fixture_pdf)
    ref_path = DATA / _ref_name(name, page)
    if request.config.getoption("--update-goldens"):
        save_png(actual, ref_path)
        pytest.skip(f"wrote reference {ref_path.name}")
    if not ref_path.exists():
        pytest.fail(f"missing reference {ref_path.name}: generate it with `{UPDATE_HINT}`")
    problem = compare(actual, ref_path, TOLERANCE, ACTUAL)
    if problem:
        pytest.fail(problem)


def test_references_match_cases() -> None:
    """Every case has a reference PNG and every PNG belongs to a case (no stale files)."""
    expected = {_ref_name(n, p) for n, p in CASES}
    present = {path.name for path in DATA.glob("*.png")}
    orphans = sorted(present - expected)
    missing = sorted(expected - present)
    assert not orphans, f"reference PNGs with no golden case (delete them): {orphans}"
    assert not missing, f"cases with no reference PNG (generate with `{UPDATE_HINT}`): {missing}"
