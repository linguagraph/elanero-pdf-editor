"""The page-object call of W6.7a S1 (``content.objects``): the content objects of one page.

The list is the engine's ``content_objects()``, the same listing the desktop's Edit tool reads
(``DocumentView.page_objects``), so the web outlines the objects the desktop would select. The
call is read-only: it takes the session lock, issues no Command and sends no events. Its keys
are valid for the page revision the reply names; the actions ``content.transform`` and
``content.delete`` check that revision (``STALE_OBJECT``) before they change anything.
"""

from __future__ import annotations

import logging

from pdfeditor.actions.content import INLINE_IMAGE_MESSAGE
from pdfeditor.model.geometry import Rect
from pdfeditor.model.objects import ObjectType, PageObject, TextStyle, family_of
from pdfeditor.services.export.images import browser_image
from pdfeditor.services.font_preview import preview_font_program
from pdfeditor.webapi import dto, limits
from pdfeditor.webapi.errors import FILE_TOO_LARGE, INVALID_ARGS, REFUSED, STALE_OBJECT, RpcFailure
from pdfeditor.webapi.registry import REGISTRY

log = logging.getLogger(__name__)

# The most objects one reply holds (W6.7a decision D2). When the page has more, the reply says so
# with ``truncated``; the outlines of the objects it does hold are still usable.
MAX_PAGE_OBJECTS = 5000

# Pages whose malformed content was already logged, as (handle, page, revision). The web polls
# this call, so a page that stays malformed would otherwise log a traceback on every poll. The set
# is cleared once it grows past the bound: a page then logs once more, which keeps memory bounded.
_LOGGED_MALFORMED_MAX = 256
_logged_malformed: set[tuple[str, int, int]] = set()


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
                _log_malformed(params.handle, params.page, revision)
    # The DTOs are built from plain model values, so the lock is not needed past this point.
    return dto.ContentObjectsResult(
        revision=revision,
        objects=tuple(_object_dto(o) for o in found[:MAX_PAGE_OBJECTS]),
        truncated=len(found) > MAX_PAGE_OBJECTS,
    )


# The longest font name the preview call takes; a PDF font name is far shorter.
MAX_FONT_NAME = 256
# The largest program the preview call returns (W6.8a); a bigger one is reported as not found.
MAX_PREVIEW_BYTES = 16 * 1024 * 1024

_PREVIEW_FAMILIES = {
    "sans": dto.PreviewFamily.SANS,
    "serif": dto.PreviewFamily.SERIF,
    "mono": dto.PreviewFamily.MONOSPACE,
}


def preview_font(params: dto.PreviewFontParams) -> dto.PreviewFontResult:
    """The embedded font program behind a text's font name, for the text editor's preview
    (W6.8a). Read-only: it issues no Command, so the document and its undo history are unchanged.

    The program is returned only when it has a character map (a subset MuPDF wrote on save has
    none, and the preview then falls back to ``family``). That is the whole check: the call takes
    no text, so it does not test that the program has glyphs for any particular edit. The bytes
    are the embedded program as the PDF stores it. An unknown name, a base-14 font that isn't
    embedded, or a program fontTools can't read is "not found", not an error.
    """
    if len(params.font_name) > MAX_FONT_NAME:
        raise RpcFailure(
            INVALID_ARGS,
            f"params.font_name: at most {MAX_FONT_NAME} characters",
            {"path": "params.font_name"},
        )
    session = REGISTRY.get(params.handle)
    with session.lock:
        count = session.document.page_count
        if not 0 <= params.page < count:
            raise RpcFailure(
                INVALID_ARGS,
                "params.page: the page is out of range",
                {"path": "params.page", "pages": count},
            )
        program = session.document.page(params.page).font_program(params.font_name)
    family = _PREVIEW_FAMILIES[family_of(params.font_name)]
    usable = None if program is None else preview_font_program(program)
    if usable is None or len(usable) > MAX_PREVIEW_BYTES:
        return dto.PreviewFontResult(found=False, family=family, program=None)
    return dto.PreviewFontResult(found=True, family=family, program=usable)


# The media type of each format the export returns. Any other stored format is sent as bytes.
_MIME = {"png": "image/png", "jpeg": "image/jpeg"}


def export_image(params: dto.ImageParams) -> dto.ImageDataResult:
    """One picture's file, for the Edit tab's Export Image (W6.7b slice 2b). Read-only: it issues no
    Command, sets no dirty flag and changes no page revision, so the undo history is unchanged.

    The key must still name an image on the page at the revision it was listed at (STALE_OBJECT).
    An inline picture (BI ... EI) has no file of its own, so it is REFUSED. The size is checked
    from the listing before any bytes are read, and then on the bytes, as attachments.get does.
    """
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
        if page.revision != params.revision:
            raise RpcFailure(STALE_OBJECT, "the page changed after the image was selected")
        listed = next(
            (o for o in page.content_objects() if o.key == params.key),
            None,
        )
        if listed is None or listed.type is not ObjectType.IMAGE:
            raise RpcFailure(STALE_OBJECT, "the image is no longer on the page")
        width, height = listed.image_size
        pixels = width * height
        if pixels > limits.MAX_RENDER_PIXELS:
            raise RpcFailure(
                FILE_TOO_LARGE,
                "the image is too large to export in the browser",
                {"max_pixels": limits.MAX_RENDER_PIXELS, "pixels": pixels},
            )
        if page.is_inline_image(params.key):
            raise RpcFailure(REFUSED, INLINE_IMAGE_MESSAGE, {"reason": "inline_image"})
        data, ext = page.image_data(params.key)
    # The raw bytes are checked before Pillow decodes them. A picture of unknown size (0 x 0)
    # passes the pixel ceiling above, so the byte cap is the only bound on a JPEG 2000 decode.
    if len(data) > limits.MAX_JOB_BYTES:
        raise RpcFailure(
            FILE_TOO_LARGE,
            "the image is too large for the browser",
            {"max_bytes": limits.MAX_JOB_BYTES, "size": len(data)},
        )
    # Pillow decodes JPEG 2000 only; the bytes are already copied out, so no engine lock is needed.
    data, ext = browser_image(data, ext)
    if len(data) > limits.MAX_JOB_BYTES:
        raise RpcFailure(
            FILE_TOO_LARGE,
            "the image is too large for the browser",
            {"max_bytes": limits.MAX_JOB_BYTES, "size": len(data)},
        )
    return dto.ImageDataResult(
        ext=ext,
        mime=_MIME.get(ext, "application/octet-stream"),
        width=width,
        height=height,
        data=data,
    )


def _log_malformed(handle: str, page: int, revision: int) -> None:
    key = (handle, page, revision)
    if key in _logged_malformed:
        return
    if len(_logged_malformed) >= _LOGGED_MALFORMED_MAX:
        _logged_malformed.clear()
    _logged_malformed.add(key)
    log.warning("can't list content objects on page %d (malformed content)", page, exc_info=True)


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
