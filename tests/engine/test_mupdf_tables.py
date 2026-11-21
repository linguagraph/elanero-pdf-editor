"""Table cell text and boxes on rotated pages (backend test: uses PyMuPDF directly to rotate).

MuPDF's table finder misreads an upright-only grid on a /Rotate 90 or 270 page, and reads 180
backwards, so the finder runs on an upright copy and the cell text is read in unrotated space.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pymupdf
import pytest

from pdfeditor.engine.registry import get_engine

EXPECTED = [
    ["Region", "Units", "Revenue"],
    ["North", "120", "1,440.00"],
    ["South", "95", "1,140.50"],
    ["West", "210", "2,520.75"],
]


def _rotated_report(fixture_pdf, tmp_path: Path, rotation: int) -> Path:
    path = tmp_path / f"report-{rotation}.pdf"
    if rotation == 0:
        shutil.copy2(fixture_pdf("report"), path)
        return path
    doc = pymupdf.open(fixture_pdf("report"))
    doc[0].set_rotation(rotation)
    doc.save(path)
    doc.close()
    return path


def _tables(path: Path):
    doc = get_engine("mupdf").open(path)
    try:
        return doc.page(0).find_tables()
    finally:
        doc.close()


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_cell_text_matches_the_table_on_every_rotation(
    fixture_pdf, tmp_path, rotation: int
) -> None:
    tables = _tables(_rotated_report(fixture_pdf, tmp_path, rotation))
    assert len(tables) == 1
    assert [list(row) for row in tables[0].rows] == EXPECTED


def test_cell_text_does_not_leak_across_borders(fixture_pdf, tmp_path) -> None:
    """Glyphs that overhang a cell border must not be read into the neighbouring cell: each row
    is exactly its own three values, and no cell holds more text than the longest expected
    value (a leaked neighbour would make a cell longer)."""
    (table,) = _tables(_rotated_report(fixture_pdf, tmp_path, 0))
    for row, expected in zip(table.rows, EXPECTED, strict=True):
        assert list(row) == expected
        assert all(cell.count("\n") == 0 for cell in row)
    longest = max(len(value) for row in EXPECTED for value in row)
    assert all(len(cell) <= longest for row in table.rows for cell in row)


def test_rotated_table_box_is_the_visible_box(fixture_pdf, tmp_path) -> None:
    """On a 90 page the visible box is the upright box turned: width and height swap, and it
    lies inside the visible page."""
    (upright,) = _tables(_rotated_report(fixture_pdf, tmp_path, 0))
    (turned,) = _tables(_rotated_report(fixture_pdf, tmp_path, 90))
    up, vis = upright.bbox, turned.bbox
    assert vis.width == pytest.approx(up.height, abs=0.5)
    assert vis.height == pytest.approx(up.width, abs=0.5)
    page = pymupdf.open(_rotated_report(fixture_pdf, tmp_path, 90))[0].rect
    assert page.contains(pymupdf.Rect(vis.x0, vis.y0, vis.x1, vis.y1))
