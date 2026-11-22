"""The guard on ``FILE`` font references in action arguments (W6.9 slice 2, design section 6).

A ``FILE`` font ref names a path that the engine reads as a font. Without this guard a request
could name any file in the worker's in-memory file system. An argument is accepted only when each
``FILE`` ref names a face of an uploaded font: a path of the form ``/fonts/<sha256>.<ext>`` that
the font catalogue holds. ``STANDARD`` and ``DOCUMENT`` refs are not touched.

Until the upload storage exists no face is in the catalogue, so every ``FILE`` ref is refused.
The storage PR replaces :func:`face_in_catalogue` with a lookup on its catalogue.
"""

from __future__ import annotations

import dataclasses
import re
from collections.abc import Mapping
from typing import Any

from pdfeditor.model.fonts import FontRef, FontRefKind
from pdfeditor.webapi.errors import INVALID_ARGS, RpcFailure

# The one folder an uploaded font lives in, and the file name the store gives it (the content
# hash, then the format's extension). Matched whole, so ``..`` segments and other folders fail.
UPLOAD_PATH = re.compile(r"/fonts/[0-9a-f]{64}\.(ttf|otf|ttc)")


def face_in_catalogue(path: str, index: int) -> bool:
    """Whether the font catalogue holds a usable face ``index`` of the file at ``path``.

    Always ``False`` until the upload storage lands; tests replace it to exercise the accepted
    forms.
    """
    return False


def _refused(path: str) -> RpcFailure:
    # The message names the field and the rule, never the font's path or the bytes.
    return RpcFailure(
        INVALID_ARGS,
        f"{path}: the font is not an uploaded font, or it was removed",
        {"path": path},
    )


def _check_ref(ref: FontRef, path: str) -> None:
    if ref.kind is not FontRefKind.FILE:
        return
    if UPLOAD_PATH.fullmatch(ref.path) is None:
        raise _refused(path)
    if not face_in_catalogue(ref.path, ref.index):
        raise _refused(path)


def check_font_refs(value: object, path: str) -> None:
    """Raise ``INVALID_ARGS`` for the first ``FILE`` font ref in ``value`` that is not an uploaded
    face. ``value`` is a converted argument; ``path`` names it in the error details, the way
    :func:`pdfeditor.webapi.dto.from_json` does (``args.style.font_ref``)."""
    if isinstance(value, FontRef):
        _check_ref(value, path)
        return
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        for field in dataclasses.fields(value):
            check_font_refs(getattr(value, field.name), f"{path}.{field.name}")
        return
    if isinstance(value, tuple | list | frozenset):
        for i, item in enumerate(value):
            check_font_refs(item, f"{path}[{i}]")
        return
    if isinstance(value, Mapping):
        mapping: Mapping[Any, Any] = value
        for key, item in mapping.items():
            check_font_refs(item, f"{path}[{key!r}]")
