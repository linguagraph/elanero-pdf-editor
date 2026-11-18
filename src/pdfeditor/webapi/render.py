"""The render call of W3.3 (W1.4 section 13, ``render.page``): one page at a device scale to RGBA.

The pixels travel as a ``$bin`` buffer (W1.2 section 5), so they are transferred to the browser
without a copy. The scale and rotation follow the viewer's own maths (``core.layout.view_matrix``),
so a page drawn here matches the desktop's page at the same zoom. A stale revision returns no
pixels, and the caller asks again (W1.4 section 5). Nothing here imports PyMuPDF.
"""

from __future__ import annotations

import math

from pdfeditor.core.layout import rotated_size, view_matrix
from pdfeditor.engine.base import ColorMode, Document, RenderRequest, RenderResult
from pdfeditor.webapi import dto, limits
from pdfeditor.webapi.errors import INVALID_ARGS, RENDER_TOO_LARGE, RpcFailure
from pdfeditor.webapi.registry import REGISTRY

ROTATIONS = (0, 90, 180, 270)
FORMAT_RGBA = "rgba"


def render_page(params: dto.RenderPageParams) -> dto.PageImage:
    if params.page < 0:
        raise RpcFailure(INVALID_ARGS, "params.page: must not be negative", {"path": "params.page"})
    if params.scale_milli < 1:
        raise RpcFailure(
            INVALID_ARGS, "params.scale_milli: must be positive", {"path": "params.scale_milli"}
        )
    if params.scale_milli > limits.MAX_RENDER_SCALE_MILLI:
        raise RpcFailure(
            RENDER_TOO_LARGE,
            "the requested scale is above the limit",
            {"max_scale_milli": limits.MAX_RENDER_SCALE_MILLI, "scale_milli": params.scale_milli},
        )
    if params.rotation not in ROTATIONS:
        raise RpcFailure(
            INVALID_ARGS, "params.rotation: must be 0, 90, 180 or 270", {"path": "params.rotation"}
        )
    session = REGISTRY.get(params.handle)
    with session.lock:
        return _render_locked(session.document, params)


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
