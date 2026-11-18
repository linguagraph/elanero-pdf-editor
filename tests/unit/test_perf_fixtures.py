"""The W0.2 performance fixtures have the shape the measurements assume (web/spike/perf).

Checked with pikepdf (independent of PyMuPDF): the page count of each size, and that page 1 has
one photo-like JPEG and text set in two fonts, one of them an embedded TrueType program.

The fixture_pdf fixture asserts the file exists, so a missing fixture fails the test rather than
skipping it (a skipped check would pass vacuously).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.hostcheck import record

SIZES = {"perf_mixed_10": 10, "perf_mixed_200": 200, "perf_mixed_1000": 1000}


@pytest.mark.parametrize("name", list(SIZES), ids=list(SIZES))
def test_perf_fixture_page_count(name: str, fixture_pdf) -> None:
    path: Path = fixture_pdf(name)
    record("page_count_pikepdf", path, pages=SIZES[name])


def test_perf_page_one_has_one_jpeg_and_two_fonts(fixture_pdf) -> None:
    record("perf_page_one_pikepdf", fixture_pdf("perf_mixed_10"))
