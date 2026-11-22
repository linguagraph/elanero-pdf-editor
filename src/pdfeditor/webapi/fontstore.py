"""The engine worker's store of uploaded fonts (W6.9 slice 2, design sections 2 to 5).

A font the user adds is written to the worker's in-memory file system under ``/fonts/``, named by
the hash of its bytes, so a file is never named after the user's file name and a re-upload of the
same bytes is a no-op. The manifest in memory holds each font's name, format and refused faces,
read once by the same validator ``fonts.validate`` uses. The usable faces are the catalogue's
(:class:`pdfeditor.services.fonts.FontCatalog`, read with :func:`read_upload_faces`), and a ``FILE``
font ref is accepted only for a face the catalogue holds (:mod:`pdfeditor.webapi.fontrefs`).

The store is per engine worker and starts empty: nothing here survives a restart. Persistence
(OPFS) is the front end's, from slice 3.
"""

from __future__ import annotations

import hashlib
import logging
import os
from dataclasses import dataclass, replace
from pathlib import Path, PurePosixPath

from pdfeditor.model.fonts import FontRef
from pdfeditor.services.fonts import (
    FontCatalog,
    FontFace,
    FontRejected,
    read_upload_faces,
    validate_font_bytes,
)
from pdfeditor.webapi import limits
from pdfeditor.webapi.errors import (
    FONT_NOT_EMBEDDABLE,
    FONT_STORAGE_FULL,
    INVALID_FONT,
    NOT_SUPPORTED,
    RpcFailure,
)

logger = logging.getLogger(__name__)

# The MEMFS folder of the uploaded fonts. Served paths are "/fonts/<id>.<ext>"; the files live in
# the store's root, which is this folder in the worker and a temporary folder in the tests.
UPLOAD_DIR = PurePosixPath("/fonts")
# The catalogue's cache file, in the upload folder. Its name is not a font's, so no scan reads it.
CATALOG_CACHE = "catalog.json"
# The extension follows the format, never the user's name: an OTC is read by the TTC code.
_EXTENSION = {"truetype": "ttf", "opentype": "otf", "collection": "ttc"}


@dataclass(frozen=True, slots=True)
class StoredFont:
    id: str  # sha256 of the bytes
    name: str  # the file name of the first add of these bytes, for display only
    format: str  # "truetype", "opentype" or "collection"
    size: int
    path: str  # the served path, "/fonts/<id>.<ext>": what a FontRef names
    faces: tuple[FontFace, ...]  # the catalogue's usable faces of this file, in the file's order
    refused: tuple[FontFace, ...]  # the usable faces the licence refuses (collections only)


def read_font(data: bytes, label: str) -> tuple[str, list[FontFace], list[FontFace]]:
    """:func:`validate_font_bytes` with its stable error codes. Shared by ``fonts.validate`` and
    ``fonts.add``, so a file is accepted or refused the same way in both."""
    try:
        return validate_font_bytes(data, label)
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


class FontStore:
    """The uploaded fonts of one engine worker, written to the folder ``root``."""

    def __init__(self, root: Path) -> None:
        # Nothing touches the disk here: the folder is made by the first add, so a test that
        # never adds a font leaves no folder behind. The catalogue's cache sits in the folder
        # too (it is not a font file, so the scan skips it).
        self._root = root
        self._fonts: dict[str, StoredFont] = {}
        self._catalog = FontCatalog(
            folders=[root], cache_path=root / CATALOG_CACHE, reader=read_upload_faces
        )

    @property
    def used_bytes(self) -> int:
        return sum(font.size for font in self._fonts.values())

    def fonts(self) -> list[StoredFont]:
        """The stored fonts in the order they were added, with the catalogue's faces."""
        return [replace(font, faces=self._faces_of(font.path)) for font in self._fonts.values()]

    def has_face(self, served: str, index: int) -> bool:
        """Whether the catalogue holds the usable face ``index`` of the file at ``served``."""
        return self._catalog.face_for(FontRef.file(self._disk_str(served), index)) is not None

    def _faces_of(self, served: str) -> tuple[FontFace, ...]:
        disk = self._disk_str(served)
        return tuple(face for face in self._catalog.faces() if face.path == disk)

    def add(self, name: str, data: bytes) -> tuple[StoredFont, bool]:
        """Store ``data``; returns ``(font, added)``. The same bytes again give ``(stored font,
        False)`` with nothing parsed or written. Quotas are checked before parsing; the file is
        validated before it is written."""
        font_id = hashlib.sha256(data).hexdigest()
        stored = self._fonts.get(font_id)
        if stored is not None:
            return stored, False
        size = len(data)
        if len(self._fonts) >= limits.MAX_UPLOADED_FONTS:
            raise _full("count", size)
        if self.used_bytes + size > limits.MAX_FONT_STORE_BYTES:
            raise _full("bytes", size)

        fmt, _faces, refused = read_font(data, name)
        served = str(UPLOAD_DIR / f"{font_id}.{_EXTENSION[fmt]}")
        disk = self._disk(served)
        temp = self._root / f"{font_id}.tmp"
        try:
            self._root.mkdir(parents=True, exist_ok=True)
            temp.write_bytes(data)
            os.replace(temp, disk)
        except OSError:
            _remove(temp)
            raise _full("memory", size) from None

        # The catalogue reads the new file with the same rules as the validator. A file it
        # holds no face of is taken back out: nothing is listed or usable for it.
        self._catalog.scan()
        faces = self._faces_of(served)
        if not faces:
            _remove(disk)
            self._catalog.scan()
            raise RpcFailure(
                INVALID_FONT, "this is not a usable font file", {"reason": "unreadable"}
            )

        font = StoredFont(font_id, name, fmt, size, served, faces, tuple(refused))
        self._fonts[font_id] = font
        return font, True

    def remove(self, font_id: str) -> None:
        """Delete the font with ``font_id``. An id that isn't stored is a no-op."""
        font = self._fonts.get(font_id)
        if font is None:
            return
        try:
            self._disk(font.path).unlink(missing_ok=True)
        except OSError:
            # The file is still there, so the font stays listed and usable: nothing changed.
            raise RpcFailure(
                FONT_STORAGE_FULL, "the font could not be removed", {"limit": "memory"}
            ) from None
        del self._fonts[font_id]
        self._catalog.scan()  # drops the file's faces; the cache still holds the others

    def _disk(self, served: str) -> Path:
        # The served name's last part only: the guard has already matched the whole path.
        return self._root / PurePosixPath(served).name

    def _disk_str(self, served: str) -> str:
        # The catalogue keys its faces by the disk path it scanned, so a served path maps to it.
        return str(self._disk(served))


def _full(limit: str, size: int) -> RpcFailure:
    return RpcFailure(
        FONT_STORAGE_FULL,
        "there is no room for more fonts",
        {
            "limit": limit,
            "max_fonts": limits.MAX_UPLOADED_FONTS,
            "max_bytes": limits.MAX_FONT_STORE_BYTES,
            "size": size,
        },
    )


def _remove(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        logger.debug("couldn't remove %s", path, exc_info=True)


_STORE: FontStore | None = None


def store() -> FontStore:
    """The worker's store, made on first use."""
    global _STORE
    if _STORE is None:
        _STORE = FontStore(Path(str(UPLOAD_DIR)))
    return _STORE


def use_root(root: Path | None) -> None:
    """Tests: a fresh store over ``root``; ``None`` makes the next :func:`store` a new one."""
    global _STORE
    _STORE = None if root is None else FontStore(root)
