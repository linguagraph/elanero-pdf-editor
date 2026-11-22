"""The font calls of the web build (W6.9).

``fonts.validate`` checks an uploaded font file and stores nothing (slice 1). ``fonts.add``,
``fonts.list`` and ``fonts.remove`` keep the uploaded fonts in the worker's store (slice 2, see
:mod:`pdfeditor.webapi.fontstore`). None touches a document, so none takes a handle or an engine
lock. A file that can't be used is a stable error code with a ``reason``.
"""

from __future__ import annotations

import re

from pdfeditor.services.fonts import FontFace
from pdfeditor.webapi import dto, fontstore, limits
from pdfeditor.webapi.errors import FILE_TOO_LARGE, INVALID_ARGS, RpcFailure

MAX_NAME_CHARS = 255
_FONT_ID = re.compile(r"[0-9a-f]{64}")


def _check_name(name: str) -> None:
    if not 1 <= len(name) <= MAX_NAME_CHARS:
        raise RpcFailure(
            INVALID_ARGS,
            f"params.name: 1 to {MAX_NAME_CHARS} characters",
            {"path": "params.name"},
        )


def _check_size(data: bytes) -> None:
    # Checked before anything reads the bytes.
    size = len(data)
    if size > limits.MAX_FONT_BYTES:
        raise RpcFailure(
            FILE_TOO_LARGE,
            "the font file is too large",
            {"max_bytes": limits.MAX_FONT_BYTES, "size": size},
        )


def _face_dtos(faces: tuple[FontFace, ...] | list[FontFace]) -> tuple[dto.FontFaceDto, ...]:
    return tuple(
        dto.FontFaceDto(
            index=face.index,
            family=face.family,
            style=face.style,
            weight=face.weight,
            italic=face.italic,
            scripts=tuple(sorted(face.scripts)),
            variable=face.variable,
        )
        for face in faces
    )


def _refused_dtos(faces: tuple[FontFace, ...] | list[FontFace]) -> tuple[dto.RefusedFaceDto, ...]:
    return tuple(
        dto.RefusedFaceDto(
            index=face.index, family=face.family, style=face.style, reason=face.reason
        )
        for face in faces
    )


def _uploaded(font: fontstore.StoredFont) -> dto.UploadedFontDto:
    return dto.UploadedFontDto(
        id=font.id,
        name=font.name,
        format=font.format,
        size=font.size,
        path=font.path,
        faces=_face_dtos(font.faces),
        refused=_refused_dtos(font.refused),
    )


def validate(params: dto.FontValidateParams) -> dto.FontValidateResult:
    """Read an uploaded TTF, OTF, TTC or OTC file and say what it holds, read-only.

    The size bound is checked before any parsing. WOFF and WOFF2 are refused: the web build has
    no Brotli, and the user has the TTF or OTF file in nearly every case. A collection whose
    faces are all refused by their licence is ``FONT_NOT_EMBEDDABLE``; one with some usable
    embeddable faces is accepted, and its refused faces are listed.
    """
    _check_name(params.name)
    _check_size(params.data)
    fmt, faces, refused = fontstore.read_font(params.data, params.name)
    return dto.FontValidateResult(
        format=fmt, faces=_face_dtos(faces), refused=_refused_dtos(refused)
    )


def add(params: dto.FontAddParams) -> dto.FontAddResult:
    """Store an uploaded font in the worker, so text can be set with it (W6.9 slice 2).

    The same bytes again do nothing and reply ``added: false``. A full store (too many fonts, or
    too many bytes) is ``FONT_STORAGE_FULL``, checked before the file is parsed.
    """
    _check_name(params.name)
    _check_size(params.data)
    font, added = fontstore.store().add(params.name, params.data)
    store = fontstore.store()
    return dto.FontAddResult(
        font=_uploaded(font),
        added=added,
        used_bytes=store.used_bytes,
        max_bytes=limits.MAX_FONT_STORE_BYTES,
    )


def listed(params: dto.Empty) -> dto.FontListResult:
    """The fonts stored in this worker, in the order they were added. A new worker lists none."""
    store = fontstore.store()
    return dto.FontListResult(
        fonts=tuple(_uploaded(font) for font in store.fonts()),
        used_bytes=store.used_bytes,
        max_bytes=limits.MAX_FONT_STORE_BYTES,
    )


def remove(params: dto.FontRemoveParams) -> dto.Empty:
    """Delete an uploaded font. An id that isn't stored is a no-op (a list can be stale)."""
    if _FONT_ID.fullmatch(params.id) is None:
        raise RpcFailure(
            INVALID_ARGS, "params.id: 64 lowercase hex characters", {"path": "params.id"}
        )
    fontstore.store().remove(params.id)
    return dto.Empty()
