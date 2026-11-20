"""The page-object call of W6.7a S1 (``content.objects``): the content objects of one page.

The list is the engine's ``content_objects()``, the same listing the desktop's Edit tool reads
(``DocumentView.page_objects``), so the web outlines the objects the desktop would select. The
call is read-only: it takes the session lock, issues no Command and sends no events. Its keys
are valid for the page revision the reply names; the actions ``content.transform`` and
``content.delete`` check that revision (``STALE_OBJECT``) before they change anything.
"""

from __future__ import annotations

import logging

from pdfeditor.model.geometry import Rect
from pdfeditor.model.objects import PageObject, TextStyle
from pdfeditor.webapi import dto
from pdfeditor.webapi.errors import INVALID_ARGS, RpcFailure
from pdfeditor.webapi.registry import REGISTRY

log = logging.getLogger(__name__)

# The most objects one reply holds (W6.7a decision D2). When the page has more, the reply says so
# with ``truncated``; the outlines of the objects it does hold are still usable.
MAX_PAGE_OBJECTS = 5000


def list_objects(params: dto.PageParams) -> dto.ContentObjectsResult:
    session = REGISTRY.get(params.handle)
    with session.lock:
        count = session.document.page_count
        if not 0 <= params.page < count:
            raise RpcFailure(
                INVALID_ARGS,
                "params.page: the page is out of range",
                {"path": "params.page", "pages": count},
            )
        page = session.document.page(params.page)
        revision = page.revision
        found: list[PageObject] = []
        # Without content_edit the desktop lists nothing, so the web does the same (W6.7a S1).
        if session.engine.capabilities.content_edit:
            try:
                found = page.content_objects()
            except Exception:  # malformed content: nothing editable on this page, as on the desktop
                log.exception("can't list content objects on page %d", params.page)
    # The DTOs are built from plain model values, so the lock is not needed past this point.
    return dto.ContentObjectsResult(
        revision=revision,
        objects=tuple(_object_dto(o) for o in found[:MAX_PAGE_OBJECTS]),
        truncated=len(found) > MAX_PAGE_OBJECTS,
    )


def _object_dto(obj: PageObject) -> dto.PageObjectDto:
    return dto.PageObjectDto(
        type=obj.type,
        key=obj.key,
        bbox=_rect(obj.bbox),
        text=obj.text,
        style=None if obj.style is None else _style_dto(obj.style),
        editable=obj.editable,
        reason=obj.reason,
        image_size=obj.image_size,
        stroke=obj.stroke,
        fill=obj.fill,
    )


def _style_dto(style: TextStyle) -> dto.TextStyleDto:
    color = style.color
    return dto.TextStyleDto(
        font=style.font,
        size=style.size,
        color=dto.ColorDto(color.r, color.g, color.b, color.a),
        bold=style.bold,
        italic=style.italic,
        align=style.align,
        line_height=style.line_height,
        char_spacing=style.char_spacing,
        word_spacing=style.word_spacing,
    )


def _rect(r: Rect) -> dto.RectDto:
    return dto.RectDto(r.x0, r.y0, r.x1, r.y1)
