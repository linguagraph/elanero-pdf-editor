"""The font calls of the web build (W6.9 slice 1): ``fonts.validate`` checks an uploaded font
file and stores nothing. It touches no document, so it takes no handle and no engine lock.

The checks are :func:`pdfeditor.services.fonts.validate_font_bytes`, which the storage slice will
reuse when it adds a font. A file that can't be used is a stable error code with a ``reason``.
"""

from __future__ import annotations

from pdfeditor.services.fonts import FontRejected, validate_font_bytes
from pdfeditor.webapi import dto, limits
from pdfeditor.webapi.errors import (
    FILE_TOO_LARGE,
    FONT_NOT_EMBEDDABLE,
    INVALID_ARGS,
    INVALID_FONT,
    NOT_SUPPORTED,
    RpcFailure,
)

MAX_NAME_CHARS = 255


def validate(params: dto.FontValidateParams) -> dto.FontValidateResult:
    """Read an uploaded TTF, OTF, TTC or OTC file and say what it holds, read-only.

    The size bound is checked before any parsing. WOFF and WOFF2 are refused: the web build has
    no Brotli, and the user has the TTF or OTF file in nearly every case. A collection whose
    faces are all refused by their licence is ``FONT_NOT_EMBEDDABLE``; one with some usable
    embeddable faces is accepted, and its refused faces are listed.
    """
    if not 1 <= len(params.name) <= MAX_NAME_CHARS:
        raise RpcFailure(
            INVALID_ARGS,
            f"params.name: 1 to {MAX_NAME_CHARS} characters",
            {"path": "params.name"},
        )
    size = len(params.data)  # checked before anything reads the bytes
    if size > limits.MAX_FONT_BYTES:
        raise RpcFailure(
            FILE_TOO_LARGE,
            "the font file is too large",
            {"max_bytes": limits.MAX_FONT_BYTES, "size": size},
        )
    try:
        fmt, faces, refused = validate_font_bytes(params.data, params.name)
    except ImportError as exc:  # fontTools is not loaded in this worker yet
        raise RpcFailure(NOT_SUPPORTED, "the font reader is not loaded") from exc
    except FontRejected as exc:
        if exc.kind == "not_embeddable":
            raise RpcFailure(
                FONT_NOT_EMBEDDABLE,
                "the font's licence does not allow embedding",
                {"reason": exc.reason, "faces": len(exc.refused)},
            ) from None
        raise RpcFailure(
            INVALID_FONT, "this is not a usable font file", {"reason": exc.reason}
        ) from None
    return dto.FontValidateResult(
        format=fmt,
        faces=tuple(
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
        ),
        refused=tuple(
            dto.RefusedFaceDto(
                index=face.index, family=face.family, style=face.style, reason=face.reason
            )
            for face in refused
        ),
    )
