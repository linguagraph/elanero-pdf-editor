"""The guard on ``FILE`` font references in action arguments (W6.9 slice 2, design section 6).

A ``FILE`` font ref names a path that the engine reads as a font. Without this guard a request
could name any file in the worker's in-memory file system. An argument is accepted only when each
``FILE`` ref names a face of an uploaded font: a path of the form ``/fonts/<sha256>.<ext>`` that
the font store's catalogue holds. ``STANDARD`` and ``DOCUMENT`` refs are not touched.

Long-running jobs run in a worker that holds no uploaded fonts, so :func:`check_no_file_refs`
refuses any ``FILE`` ref in a job's arguments.
"""

from __future__ import annotations

import dataclasses
import re
from collections.abc import Callable, Mapping
from typing import Any

from pdfeditor.model.fonts import FontRef, FontRefKind
from pdfeditor.webapi import fontstore
from pdfeditor.webapi.errors import INVALID_ARGS, NOT_SUPPORTED, RpcFailure

# The one folder an uploaded font lives in, and the file name the store gives it (the content
# hash, then the format's extension). Matched whole, so ``..`` segments and other folders fail.
UPLOAD_PATH = re.compile(r"/fonts/[0-9a-f]{64}\.(ttf|otf|ttc)")


def face_in_catalogue(path: str, index: int) -> bool:
    """Whether the catalogue of the worker's font store holds a usable face ``index`` of the file
    at ``path``. A face the catalogue no longer reads is refused, even if the manifest lists it."""
    return fontstore.store().has_face(path, index)


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


def _refuse_file_ref(ref: FontRef, path: str) -> None:
    if ref.kind is FontRefKind.FILE:
        raise RpcFailure(NOT_SUPPORTED, "uploaded fonts can't be used here yet", {"path": path})


def _walk(value: object, path: str, check: Callable[[FontRef, str], None]) -> None:
    """Call ``check`` on each font ref in ``value``, depth first, with the path it sits at."""
    if isinstance(value, FontRef):
        check(value, path)
        return
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        for field in dataclasses.fields(value):
            _walk(getattr(value, field.name), f"{path}.{field.name}", check)
        return
    if isinstance(value, tuple | list | frozenset):
        for i, item in enumerate(value):
            _walk(item, f"{path}[{i}]", check)
        return
    if isinstance(value, Mapping):
        mapping: Mapping[Any, Any] = value
        for key, item in mapping.items():
            _walk(item, f"{path}[{key!r}]", check)


def check_font_refs(value: object, path: str) -> None:
    """Raise ``INVALID_ARGS`` for the first ``FILE`` font ref in ``value`` that is not an uploaded
    face. ``value`` is a converted argument; ``path`` names it in the error details, the way
    :func:`pdfeditor.webapi.dto.from_json` does (``args.style.font_ref``)."""
    _walk(value, path, _check_ref)


def check_no_file_refs(value: object, path: str) -> None:
    """Raise ``NOT_SUPPORTED`` for the first ``FILE`` font ref in a job's converted arguments.
    The job worker holds no uploaded fonts, so a job can't typeset with one (design section 7)."""
    _walk(value, path, _refuse_file_ref)
