"""Tile/thumbnail request math shared by the page view and the thumbnails panel."""

from __future__ import annotations

from dataclasses import dataclass

from PySide6.QtGui import QImage

from pdfeditor.core.layout import rotated_size, tile_grid, view_matrix
from pdfeditor.core.render_cache import THUMBNAIL_TILE, TileKey, quantize_scale
from pdfeditor.core.session import DocumentSession
from pdfeditor.model.geometry import Matrix, Rect
from pdfeditor.ui.view.renderer import PRIORITY_THUMBNAIL, PRIORITY_VISIBLE, TileRenderer

TILE_PX = 512  # tile edge in device pixels
THUMBNAIL_WIDTH_PX = 160


@dataclass(frozen=True, slots=True)
class TileSpec:
    key: TileKey
    matrix: Matrix
    clip: Rect
    target: Rect  # where the tile goes, in item (rotated page, point) coordinates


def page_revision(session: DocumentSession, index: int) -> int:
    return session.document.page(index).revision


def tile_specs(
    session: DocumentSession,
    index: int,
    page_rect: Rect,
    rotation: int,
    scale: float,
    exposed: Rect,
    variant: str = "",
) -> list[TileSpec]:
    """Tiles at device ``scale`` needed to cover ``exposed`` (item coordinates)."""
    s_milli = quantize_scale(scale)
    s = s_milli / 1000
    matrix = view_matrix(page_rect, rotation, s)
    inverse = matrix.inverted()
    rev = page_revision(session, index)
    out: list[TileSpec] = []
    for cell in tile_grid(page_rect, rotation, s_milli, exposed, TILE_PX):
        key = TileKey(session.id, index, rev, s_milli, rotation, cell.tx, cell.ty, variant)
        px = cell.device_rect
        target = Rect(px.x0 / s, px.y0 / s, px.x1 / s, px.y1 / s)
        out.append(TileSpec(key, matrix, px.transform(inverse), target))
    return out


def request_tile(renderer: TileRenderer, spec: TileSpec) -> QImage | None:
    image = renderer.cache.get(spec.key)
    if image is None:
        renderer.request(spec.key, spec.matrix, spec.clip, PRIORITY_VISIBLE)
    return image


def thumbnail(
    renderer: TileRenderer,
    session: DocumentSession,
    index: int,
    page_rect: Rect,
    rotation: int,
    variant: str = "",
    width_px: int = THUMBNAIL_WIDTH_PX,
) -> QImage | None:
    """Cached whole-page low-resolution image, requested in the background when missing."""
    w, _ = rotated_size(page_rect.width, page_rect.height, rotation)
    s_milli = quantize_scale(width_px / max(w, 1.0))
    key = TileKey(
        session.id,
        index,
        page_revision(session, index),
        s_milli,
        rotation,
        THUMBNAIL_TILE,
        0,
        variant,
    )
    image = renderer.cache.get(key)
    if image is None:
        matrix = view_matrix(page_rect, rotation, s_milli / 1000)
        renderer.request(key, matrix, None, PRIORITY_THUMBNAIL)
    return image
