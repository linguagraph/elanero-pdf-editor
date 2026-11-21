"""The render calls of W3.3 (W1.4 section 13): ``render.page``, one page at a device scale to RGBA,
and ``render.tile``, one 1024-device-pixel tile of that page's grid (W1.4 section 4).

The pixels travel as a ``$bin`` buffer (W1.2 section 5), so they are transferred to the browser
without a copy. The scale and rotation follow the viewer's own maths (``core.layout.view_matrix``),
so a page drawn here matches the desktop's page at the same zoom. A stale revision returns no
pixels, and the caller asks again (W1.4 section 5). Nothing here imports PyMuPDF.
"""

from __future__ import annotations

import math

from pdfeditor.core.layout import rotated_size, tile_device_rect, view_matrix
from pdfeditor.engine.base import ColorMode, Document, RenderRequest, RenderResult
from pdfeditor.model.geometry import Rect
from pdfeditor.webapi import dto, limits
from pdfeditor.webapi.errors import INVALID_ARGS, RENDER_TOO_LARGE, RpcFailure
from pdfeditor.webapi.registry import REGISTRY

ROTATIONS = (0, 90, 180, 270)
FORMAT_RGBA = "rgba"
TILE_PX = 1024  # W1.4 section 4: viewing tiles are 1024 x 1024 device pixels


def render_page(params: dto.RenderPageParams) -> dto.PageImage:
    _check_page_and_view(params.page, params.scale_milli, params.rotation)
    session = REGISTRY.get(params.handle)
    with session.lock:
        return _render_locked(session.document, params)


def render_tile(params: dto.RenderTileParams) -> dto.PageImage:
    _check_page_and_view(params.page, params.scale_milli, params.rotation)
    if params.tile_px != TILE_PX:
        raise RpcFailure(
            INVALID_ARGS, f"params.tile_px: must be {TILE_PX}", {"path": "params.tile_px"}
        )
    if params.tile_x < 0:
        raise RpcFailure(
            INVALID_ARGS, "params.tile_x: must not be negative", {"path": "params.tile_x"}
        )
    if params.tile_y < 0:
        raise RpcFailure(
            INVALID_ARGS, "params.tile_y: must not be negative", {"path": "params.tile_y"}
        )
    session = REGISTRY.get(params.handle)
    with session.lock:
        return _render_tile_locked(session.document, params)


def _check_page_and_view(page: int, scale_milli: int, rotation: int) -> None:
    """The arguments shared by both render calls; the same errors and paths as before."""
    if page < 0:
        raise RpcFailure(INVALID_ARGS, "params.page: must not be negative", {"path": "params.page"})
    if scale_milli < 1:
        raise RpcFailure(
            INVALID_ARGS, "params.scale_milli: must be positive", {"path": "params.scale_milli"}
        )
    if scale_milli > limits.MAX_RENDER_SCALE_MILLI:
        raise RpcFailure(
            RENDER_TOO_LARGE,
            "the requested scale is above the limit",
            {"max_scale_milli": limits.MAX_RENDER_SCALE_MILLI, "scale_milli": scale_milli},
        )
    if rotation not in ROTATIONS:
        raise RpcFailure(
            INVALID_ARGS, "params.rotation: must be 0, 90, 180 or 270", {"path": "params.rotation"}
        )


def _render_locked(document: Document, params: dto.RenderPageParams) -> dto.PageImage:
    # Every engine object (the page, the render result) is created and dropped in this call,
    # inside the caller's session lock.
    if params.page >= document.page_count:
        raise RpcFailure(INVALID_ARGS, "params.page: no such page", {"path": "params.page"})
    page = document.page(params.page)
    if page.revision != params.revision:
        return dto.PageImage(
            width=0, height=0, revision=page.revision, format=FORMAT_RGBA, pixels=b""
        )
    scale = params.scale_milli / 1000
    width, height = rotated_size(page.rect.width, page.rect.height, params.rotation)
    pixel_count = math.ceil(width * scale) * math.ceil(height * scale)
    if pixel_count > limits.MAX_RENDER_PIXELS:
        raise RpcFailure(
            RENDER_TOO_LARGE,
            "the page is too large to render at this scale",
            {"max_pixels": limits.MAX_RENDER_PIXELS, "pixels": pixel_count},
        )
    result = page.render(
        RenderRequest(
            matrix=view_matrix(page.rect, params.rotation, scale),
            color=ColorMode.RGBA,
            annotations=params.annotations,
        )
    )
    return dto.PageImage(
        width=result.width,
        height=result.height,
        revision=page.revision,
        format=FORMAT_RGBA,
        pixels=_packed_rgba(result),
    )


def _render_tile_locked(document: Document, params: dto.RenderTileParams) -> dto.PageImage:
    if params.page >= document.page_count:
        raise RpcFailure(INVALID_ARGS, "params.page: no such page", {"path": "params.page"})
    page = document.page(params.page)
    if page.revision != params.revision:
        return dto.PageImage(
            width=0, height=0, revision=page.revision, format=FORMAT_RGBA, pixels=b""
        )
    scale = params.scale_milli / 1000
    width, height = rotated_size(page.rect.width, page.rect.height, params.rotation)
    # The page image's device size, as render.page reports it (MuPDF rounds the page outwards).
    page_px_w = math.ceil(width * scale)
    page_px_h = math.ceil(height * scale)
    if params.tile_x * TILE_PX >= page_px_w:
        raise RpcFailure(INVALID_ARGS, "params.tile_x: outside the page", {"path": "params.tile_x"})
    if params.tile_y * TILE_PX >= page_px_h:
        raise RpcFailure(INVALID_ARGS, "params.tile_y: outside the page", {"path": "params.tile_y"})
    clipped = tile_device_rect(params.tile_x, params.tile_y, TILE_PX, page_px_w, page_px_h)
    x0, y0, x1, y1 = (int(v) for v in (clipped.x0, clipped.y0, clipped.x1, clipped.y1))
    tile_w = x1 - x0
    tile_h = y1 - y0
    if tile_w * tile_h > limits.MAX_TILE_PIXELS:
        raise RpcFailure(
            RENDER_TOO_LARGE,
            "the tile is too large to render",
            {"max_pixels": limits.MAX_TILE_PIXELS, "pixels": tile_w * tile_h},
        )
    matrix = view_matrix(page.rect, params.rotation, scale)
    # The clip is the tile's device rectangle mapped back to page space. MuPDF draws only that
    # part of the page with the same matrix as render.page, so the pixels line up with it.
    clip = Rect(x0, y0, x1, y1).transform(matrix.inverted())
    result = page.render(
        RenderRequest(
            matrix=matrix, clip=clip, color=ColorMode.RGBA, annotations=params.annotations
        )
    )
    # MuPDF may round the clip out by a pixel at a tile edge; the reply is exactly the tile.
    pixels = _fit_rgba(_packed_rgba(result), result.width, result.height, tile_w, tile_h)
    return dto.PageImage(
        width=tile_w, height=tile_h, revision=page.revision, format=FORMAT_RGBA, pixels=pixels
    )


def _fit_rgba(packed: bytes, src_w: int, src_h: int, width: int, height: int) -> bytes:
    """``packed`` (``src_w`` x ``src_h``, four bytes a pixel) cut or padded to ``width`` x
    ``height``.

    Only a pixel of rounding at a tile edge changes the size; any extra pixel is transparent.
    """
    if (src_w, src_h) == (width, height):
        return packed
    src_row = src_w * 4
    row = width * 4
    keep = min(src_w, width) * 4
    out = bytearray(row * height)
    for y in range(min(src_h, height)):
        out[y * row : y * row + keep] = packed[y * src_row : y * src_row + keep]
    return bytes(out)


def _packed_rgba(result: RenderResult) -> bytes:
    """The samples without any stride padding: ``width * 4`` bytes per row, top row first."""
    if result.color is not ColorMode.RGBA:
        raise AssertionError("the web render asks for RGBA only")
    row = result.width * 4
    if result.stride == row:
        return result.samples
    return b"".join(
        result.samples[y * result.stride : y * result.stride + row] for y in range(result.height)
    )
