"""``core.layout.tile_grid`` against the grid the desktop used before it moved out of ``tiles.py``.

The reference below is the old ``tile_specs`` arithmetic, copied verbatim, so the move is checked
against what shipped. The grid must match at 512 px (desktop) and 1024 px (web).
"""

from __future__ import annotations

import itertools

import pytest

from pdfeditor.core.layout import TileCell, rotated_size, tile_device_rect, tile_grid
from pdfeditor.model.geometry import Rect


def _old_grid(
    page_rect: Rect, rotation: int, s_milli: int, exposed: Rect, tile_px: int
) -> list[tuple[int, int, Rect]]:
    s = s_milli / 1000
    w, h = rotated_size(page_rect.width, page_rect.height, rotation)
    full_px = Rect(0, 0, w * s, h * s)
    step = tile_px / s
    x_first = max(0, int(exposed.x0 // step))
    y_first = max(0, int(exposed.y0 // step))
    x_last = int(min(exposed.x1, w - 1e-6) // step)
    y_last = int(min(exposed.y1, h - 1e-6) // step)
    out: list[tuple[int, int, Rect]] = []
    for ty in range(y_first, y_last + 1):
        for tx in range(x_first, x_last + 1):
            px = Rect(tx * tile_px, ty * tile_px, (tx + 1) * tile_px, (ty + 1) * tile_px)
            px = px.intersection(full_px)
            if px.is_empty:
                continue
            out.append((tx, ty, px))
    return out


PAGE_SIZES = [(612.0, 792.0), (595.3, 841.9), (1190.0, 36.0), (3.0, 5000.0), (512.0, 512.0)]
SCALES_MILLI = [125, 1000, 1333, 2500, 4000, 16000]
EXPOSED = [
    None,  # the whole page
    Rect(0, 0, 100, 100),
    Rect(300.5, 10.25, 700.75, 90.0),
    Rect(-5, -5, 40, 2000),
]


def _exposed_for(page_rect: Rect, rotation: int, choice: Rect | None) -> Rect:
    if choice is not None:
        return choice
    w, h = rotated_size(page_rect.width, page_rect.height, rotation)
    return Rect(0, 0, w, h)


@pytest.mark.parametrize("tile_px", [512, 1024])
@pytest.mark.parametrize(
    ("size", "rotation", "scale_milli", "exposed"),
    list(itertools.product(PAGE_SIZES, [0, 90, 180, 270], SCALES_MILLI, EXPOSED)),
)
def test_tile_grid_matches_the_previous_desktop_grid(
    size: tuple[float, float],
    rotation: int,
    scale_milli: int,
    exposed: Rect | None,
    tile_px: int,
) -> None:
    page_rect = Rect(0, 0, *size)
    area = _exposed_for(page_rect, rotation, exposed)
    expected = _old_grid(page_rect, rotation, scale_milli, area, tile_px)
    got = tile_grid(page_rect, rotation, scale_milli, area, tile_px)
    assert [(c.tx, c.ty, c.device_rect) for c in got] == expected
    assert all(isinstance(c, TileCell) for c in got)


def test_frozen_grid_for_a_letter_page_at_512() -> None:
    cells = tile_grid(Rect(0, 0, 612, 792), 0, 1000, Rect(0, 0, 612, 792), 512)
    assert [(c.tx, c.ty, c.device_rect) for c in cells] == [
        (0, 0, Rect(0, 0, 512, 512)),
        (1, 0, Rect(512, 0, 612, 512)),
        (0, 1, Rect(0, 512, 512, 792)),
        (1, 1, Rect(512, 512, 612, 792)),
    ]


@pytest.mark.parametrize("tile_px", [512, 1024])
def test_page_at_or_under_the_tile_size_is_one_tile(tile_px: int) -> None:
    for side in (1, tile_px // 2, tile_px - 1, tile_px):
        page_rect = Rect(0, 0, side, side)
        cells = tile_grid(page_rect, 0, 1000, Rect(0, 0, side, side), tile_px)
        assert len(cells) == 1
        assert (cells[0].tx, cells[0].ty) == (0, 0)
        assert cells[0].device_rect == Rect(0, 0, side, side)


def test_page_at_or_under_the_tile_size_is_one_tile_when_scaled() -> None:
    # 600 pt at 1.5x is 900 device px: one 1024 px tile, but two 512 px tiles.
    page_rect = Rect(0, 0, 600, 600)
    assert len(tile_grid(page_rect, 0, 1500, Rect(0, 0, 600, 600), 1024)) == 1
    assert len(tile_grid(page_rect, 0, 1500, Rect(0, 0, 600, 600), 512)) == 4


@pytest.mark.parametrize(("tx", "ty"), [(0, 0), (1, 0), (0, 1), (2, 3)])
def test_tile_device_rect_matches_the_web_tile_clip(tx: int, ty: int) -> None:
    # The web's render.tile clipped the tile at the page image's edge with min(); the shared
    # helper must give the same rectangle at 1024 px.
    page_w, page_h = 1500, 2100
    x0, y0 = tx * 1024, ty * 1024
    expected = (x0, y0, min(x0 + 1024, page_w), min(y0 + 1024, page_h))
    got = tile_device_rect(tx, ty, 1024, page_w, page_h)
    assert (got.x0, got.y0, got.x1, got.y1) == expected
