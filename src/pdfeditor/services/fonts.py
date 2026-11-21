"""Catalog of fonts installed on this machine: where to look, how to read a face, and a
cache so the app doesn't re-read every font file on every launch. Also the check of an uploaded
font file (:func:`validate_font_bytes`, W6.9).

Headless (no Qt): the UI runs :meth:`FontCatalog.scan` as a background job.

This module ships in the web package (scripts/web_package.py), so fontTools is imported inside
the functions that use it, never at module level: the web worker loads fontTools only before
its first font call. Without fontTools the desktop catalogue reads nothing, and the upload check
raises ImportError, which the web maps to NOT_SUPPORTED.
"""

from __future__ import annotations

import io
import json
import logging
import os
import platform
import re
import struct
from collections.abc import Iterable, Sequence
from dataclasses import replace
from pathlib import Path
from typing import TYPE_CHECKING

from pdfeditor.core.jobs import CancelToken, ProgressFn, no_progress
from pdfeditor.core.paths import data_dir
from pdfeditor.model.fonts import (
    BITMAP_ONLY,
    RESTRICTED,
    FontFace,
    FontRef,
    FontRefKind,
    licence_refusal,
)
from pdfeditor.model.platform import current

if TYPE_CHECKING:  # annotations only: fontTools is imported inside the functions (see below)
    from fontTools.ttLib import TTFont

logger = logging.getLogger(__name__)

# fontTools warns about some installed fonts' implausible 'created' timestamp; it's noise here.
logging.getLogger("fontTools.ttLib.tables._h_e_a_d").setLevel(logging.ERROR)

__all__ = [
    "BITMAP_ONLY",
    "RESTRICTED",
    "FontCatalog",
    "FontRejected",
    "cached_catalog",
    "installed_ref_for_font_name",
    "normalize_font_name",
    "read_faces",
    "system_font_dirs",
    "text_scripts",
    "validate_font_bytes",
]

_SKIP_SUFFIXES = {".fon", ".fnt", ".pfb", ".pfm"}
_FONT_SUFFIXES = {".ttf", ".otf", ".ttc", ".otc"}
CACHE_VERSION = 1

# coarse cmap coverage: representative code point -> script label
_SCRIPT_PROBES: tuple[tuple[str, int], ...] = (
    ("latin", ord("A")),
    ("cyrillic", 0x0410),  # capital A
    ("greek", 0x0391),  # capital alpha
    ("cjk", 0x4E2D),  # "middle"
    ("arabic", 0x0627),  # alef
    ("hebrew", 0x05D0),  # alef
)

# same coarse buckets as _SCRIPT_PROBES, but as Unicode ranges, for classifying a piece of text
# rather than a font's cmap.
_SCRIPT_RANGES: tuple[tuple[str, int, int], ...] = (
    ("cyrillic", 0x0400, 0x04FF),
    ("greek", 0x0370, 0x03FF),
    ("cjk", 0x3040, 0x30FF),  # hiragana/katakana
    ("cjk", 0x3400, 0x9FFF),  # CJK unified ideographs (+ extension A)
    ("cjk", 0xAC00, 0xD7A3),  # hangul syllables
    ("arabic", 0x0600, 0x06FF),
    ("hebrew", 0x0590, 0x05FF),
)

# A collection above this many faces is refused from its header, before fontTools builds an offset
# table for each one (a forged count could otherwise make it read a million entries). Real
# collections hold a few dozen faces at most.
MAX_COLLECTION_FACES = 64

_SUBSET_PREFIX = re.compile(r"^[A-Z]{6}\+")
_STYLE_SUFFIX = re.compile(r"[-, ]?(Bold\s*Italic|BoldItalic|Bold|Italic|Oblique)$", re.IGNORECASE)


def text_scripts(text: str) -> frozenset[str]:
    """Coarse scripts used in ``text`` (the same buckets as :data:`_SCRIPT_PROBES`).

    Used to flag an installed font that doesn't cover what's being typeset (e.g. no Cyrillic).
    """
    found: set[str] = set()
    for ch in text:
        cp = ord(ch)
        if ch.isalpha() and cp < 0x0250:
            found.add("latin")
            continue
        for label, lo, hi in _SCRIPT_RANGES:
            if lo <= cp <= hi:
                found.add(label)
                break
    return frozenset(found)


def normalize_font_name(name: str) -> tuple[str, bool, bool]:
    """Split a PDF/engine font name into ``(family, bold, italic)``.

    Strips a subset prefix (``ABCDEF+Calibri``) and a style suffix (``-Bold``, ``,BoldItalic``,
    ``-Italic``, ``-Oblique``), so a name MuPDF wrote on save, like ``"ABCDEF+Calibri-Bold"``,
    matches the catalog family ``"Calibri"`` with ``bold=True``.
    """
    base = _SUBSET_PREFIX.sub("", name)
    bold = False
    italic = False
    while True:
        match = _STYLE_SUFFIX.search(base)
        if not match:
            break
        token = match.group(1).lower().replace(" ", "")
        if "bold" in token:
            bold = True
        if "italic" in token or "oblique" in token:
            italic = True
        base = base[: match.start()].rstrip("-, ")
    return base, bold, italic


def _family_key(name: str) -> str:
    key = "".join(c for c in name.lower() if c.isalnum())
    for suffix in ("psmt", "mt", "ps"):
        if key.endswith(suffix) and len(key) > len(suffix) + 2:
            return key[: -len(suffix)]
    return key


def same_font_family(a: str, b: str) -> bool:
    """Whether two font names (PDF BaseFont, extracted span font or family) are one family."""
    fa, fb = normalize_font_name(a)[0], normalize_font_name(b)[0]
    return bool(fa) and _family_key(fa) == _family_key(fb)


def _name_key(name: str) -> str:
    """``name`` without subset prefix, case, punctuation and Adobe's PostScript decorations on
    each part ("ABCDEF+TimesNewRomanPS-BoldMT" and "Times New Roman Bold" both give
    "timesnewromanbold"; the family "Calisto MT" gives "calisto")."""
    parts = re.split(r"[-,]", _SUBSET_PREFIX.sub("", name).lower())
    return "".join(re.sub(r"(ps)?(mt)?$", "", re.sub(r"[^a-z0-9]", "", p)) for p in parts)


def _face_by_full_name(catalog: FontCatalog, font_name: str) -> FontFace | None:
    """The face whose "family style" is ``font_name`` (compared by :func:`_name_key`).

    MuPDF reports a reopened font by its full name ("Georgia Regular", "Segoe UI Semibold"),
    which suffix stripping alone can't map to the right face. A bare family name means its
    upright face nearest to regular weight ("Futura" is Book, not Light).
    """
    key = _name_key(font_name)
    if not key:
        return None
    for family in catalog.families():
        family_key = _name_key(family)
        if not family_key or not key.startswith(family_key):
            continue
        if key == family_key:
            return catalog.find(family)
        for face in catalog.faces_of(family):
            if key == family_key + _name_key(face.style):
                return face
    return None


def installed_ref_for_font_name(
    catalog: FontCatalog,
    font_name: str,
    bold: bool | None = None,
    italic: bool | None = None,
) -> FontRef | None:
    """The catalog's best face for ``font_name`` (after normalizing it), or ``None``.

    For reusing an installed font after reopening a document: the embedded font program MuPDF
    wrote loses its original name/cmap tables, so a later edit needs to recognize the family
    from the (possibly subsetted, styled) name alone. ``bold``/``italic`` are the style bar's
    toggles and override what the name says, so un-bolding a "Georgia Bold" paragraph works;
    ``None`` takes them from the name.
    """
    face = _face_by_full_name(catalog, font_name)
    if face is not None:
        face_bold = face.weight >= 600
        if (bold is not None and bold != face_bold) or (
            italic is not None and italic != face.italic
        ):
            # keep the named weight when only the slant changes (Black -> Black Italic)
            weight = face.weight if bold is None or bold == face_bold else None
            face = catalog.find(
                face.family,
                face_bold if bold is None else bold,
                face.italic if italic is None else italic,
                weight,
            )
        if face is not None:
            return FontRef.file(face.path, face.index, face.family) if face.embeddable else None
    family, name_bold, name_italic = normalize_font_name(font_name)
    if not family:
        return None
    bold = name_bold if bold is None else bold
    italic = name_italic if italic is None else italic
    face = catalog.find(family, bold, italic)
    if face is None:
        # PDF names drop the spaces ("TimesNewRomanPSMT", "SegoeUI"): compare loosely
        wanted = _family_key(family)
        match = next((f for f in catalog.families() if _family_key(f) == wanted), None)
        if match is not None:
            face = catalog.find(match, bold, italic)
    if face is None or not face.embeddable:
        return None
    return FontRef.file(face.path, face.index, face.family)


def system_font_dirs() -> list[Path]:
    """Existing, platform-appropriate directories to scan for installed fonts.

    Empty on the web build, which has no OS font folders (W0.4, item 7); its fonts come from the
    bundle or from uploaded files.
    """
    if not current().system_fonts:
        return []
    system = platform.system()
    candidates: list[Path] = []
    if system == "Windows":
        windir = os.environ.get("WINDIR", r"C:\Windows")
        candidates.append(Path(windir) / "Fonts")
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            candidates.append(Path(local_app_data) / "Microsoft" / "Windows" / "Fonts")
    elif system == "Darwin":
        candidates += [
            Path("/Library/Fonts"),
            Path("/System/Library/Fonts"),
            Path.home() / "Library" / "Fonts",
        ]
    else:
        candidates += [
            Path("/usr/share/fonts"),
            Path("/usr/local/share/fonts"),
            Path.home() / ".local" / "share" / "fonts",
            Path.home() / ".fonts",
        ]
    return [path for path in candidates if path.is_dir()]


def _iter_font_files(dirs: Iterable[Path]) -> list[Path]:
    files: list[Path] = []
    for root in dirs:
        try:
            walker = root.rglob("*")
        except OSError:
            continue
        for path in walker:
            try:
                if not path.is_file():
                    continue
            except OSError:
                continue
            suffix = path.suffix.lower()
            if suffix in _SKIP_SUFFIXES or suffix not in _FONT_SUFFIXES:
                continue
            files.append(path)
    return files


def _script_coverage(font: TTFont) -> frozenset[str]:
    try:
        cmap = font.getBestCmap() or {}
    except Exception:
        return frozenset()
    return frozenset(label for label, probe in _SCRIPT_PROBES if probe in cmap)


def _name(font: TTFont, preferred: int, fallback: int) -> str:
    names = font["name"]
    value = names.getDebugName(preferred) or names.getDebugName(fallback)
    return value or ""


def _embeddable(font: TTFont) -> tuple[bool, str]:
    os2 = font.get("OS/2")
    if os2 is None:
        return True, ""
    fs_type = int(getattr(os2, "fsType", 0))
    if fs_type & RESTRICTED:
        return False, "restricted by fsType"
    if fs_type & BITMAP_ONLY:
        return False, "bitmap-only by fsType"
    return True, ""


def _face_from_ttfont(font: TTFont, path: Path, index: int) -> FontFace | None:
    family = _name(font, 16, 1)
    if not family:
        return None
    style = _name(font, 17, 2) or "Regular"
    os2 = font.get("OS/2")
    head = font.get("head")
    weight = int(getattr(os2, "usWeightClass", 400)) if os2 is not None else 400
    fs_selection = int(getattr(os2, "fsSelection", 0)) if os2 is not None else 0
    mac_style = int(getattr(head, "macStyle", 0)) if head is not None else 0
    italic = bool(fs_selection & 0x01) or bool(mac_style & 0x02)
    embeddable, reason = _embeddable(font)
    return FontFace(
        family=family,
        style=style,
        weight=weight,
        italic=italic,
        path=str(path),
        index=index,
        embeddable=embeddable,
        reason=reason,
        scripts=_script_coverage(font),
        variable="fvar" in font,
    )


_TABLES = ("name", "OS/2", "head", "cmap", "fvar")


def read_faces(path: Path) -> list[FontFace]:
    """Every face in ``path``, skipping any that can't be read. Never raises."""
    suffix = path.suffix.lower()
    if suffix in _SKIP_SUFFIXES or suffix not in _FONT_SUFFIXES:
        return []
    try:
        from fontTools.ttLib import TTFont
        from fontTools.ttLib.ttCollection import TTCollection

        if suffix in (".ttc", ".otc"):
            collection = TTCollection(str(path), lazy=True)
            try:
                faces = []
                for index, font in enumerate(collection.fonts):
                    face = _face_from_ttfont(font, path, index)
                    if face is not None:
                        faces.append(face)
                return faces
            finally:
                collection.close()
        font = TTFont(str(path), lazy=True, fontNumber=0)
        try:
            face = _face_from_ttfont(font, path, 0)
        finally:
            font.close()
        return [face] if face is not None else []
    except Exception:
        logger.debug("unreadable font file: %s", path, exc_info=True)
        return []


class FontRejected(Exception):
    """A font file that can't be added (:func:`validate_font_bytes`).

    ``kind`` is ``"invalid"``: ``reason`` says why (``not_a_font``, ``woff``, ``unreadable``,
    ``too_many_faces`` or ``no_usable_face``). Or ``"not_embeddable"``: every usable face is
    refused by its fsType, ``reason`` is the first one's code (``restricted`` or ``bitmap_only``)
    and ``refused`` lists them all. Reasons are stable codes, never text from the file.
    """

    def __init__(self, kind: str, reason: str, refused: Sequence[FontFace] = ()) -> None:
        super().__init__(reason)
        self.kind = kind
        self.reason = reason
        self.refused: list[FontFace] = list(refused)


# The first four bytes of each file kind fontTools reads. WOFF is named only to refuse it with
# its own reason (fontTools reads it, but the web build has no Brotli for WOFF2).
_SFNT_FORMATS: dict[bytes, str] = {
    b"\x00\x01\x00\x00": "truetype",
    b"true": "truetype",
    b"OTTO": "opentype",
    b"ttcf": "collection",
}
_WOFF_MAGICS = (b"wOFF", b"wOF2")


def _is_usable(font: TTFont) -> bool:
    """Has a character map with at least one mapping, and outlines. Only the table directory is
    consulted for the outlines, so no charstrings are decompiled. A bitmap-only font (sbix, CBDT)
    has no outlines and can't be embedded as a PDF font."""
    try:
        if not font.getBestCmap():
            return False
    except Exception:
        return False
    return ("glyf" in font and "loca" in font) or "CFF " in font or "CFF2" in font


def _probe_face(font: TTFont, label: str, index: int) -> tuple[FontFace | None, str]:
    """``(face, refusal)`` of one face. ``face`` is None when the face is unreadable or not
    usable (it is skipped). ``refusal`` is the licence code when the usable face's fsType refuses
    embedding, else ``""``; a refused face's ``reason`` holds that code."""
    try:
        face = _face_from_ttfont(font, Path(label), index)
        if face is None or not _is_usable(font):
            return None, ""
        os2 = font.get("OS/2")
        refusal = licence_refusal(None if os2 is None else int(getattr(os2, "fsType", 0)))
    except MemoryError:
        raise
    except Exception:
        logger.debug("unreadable face %d of %s", index, label, exc_info=True)
        return None, ""
    if refusal is None:
        return face, ""
    return replace(face, reason=refusal), refusal


def validate_font_bytes(data: bytes, label: str) -> tuple[str, list[FontFace], list[FontFace]]:
    """``(format, embeddable faces, refused faces)`` of an uploaded font file, read in memory.

    ``label`` is the file name, for messages only. ``format`` is ``truetype``, ``opentype`` or
    ``collection``. The fsType rules are the desktop's (:func:`licence_refusal`), so a file the
    desktop refuses is refused here too. Only the tables the checks need are decompiled.

    Raises :class:`FontRejected`, or ``ImportError`` when fontTools is not loaded (the web worker
    before its install). A ``MemoryError`` is never turned into a rejection.
    """
    from fontTools.ttLib import TTFont
    from fontTools.ttLib.ttCollection import TTCollection

    magic = data[:4]
    if magic in _WOFF_MAGICS:
        raise FontRejected("invalid", "woff")
    fmt = _SFNT_FORMATS.get(magic)
    if fmt is None:
        raise FontRejected("invalid", "not_a_font")
    if fmt == "collection":
        if len(data) < 12:
            raise FontRejected("invalid", "unreadable")
        (count,) = struct.unpack(">I", data[8:12])  # the TTC header's numFonts
        if count > MAX_COLLECTION_FACES:
            raise FontRejected("invalid", "too_many_faces")

    try:
        if fmt == "collection":
            container: TTCollection | TTFont = TTCollection(io.BytesIO(data), lazy=True)
            fonts = list(container.fonts)
        else:
            container = TTFont(io.BytesIO(data), lazy=True, fontNumber=0)
            fonts = [container]
    except MemoryError:
        raise
    except Exception:
        raise FontRejected("invalid", "unreadable") from None

    faces: list[FontFace] = []
    refused: list[FontFace] = []
    try:
        for index, font in enumerate(fonts):
            face, refusal = _probe_face(font, label, index)
            if face is None:
                continue
            (refused if refusal else faces).append(face)
    finally:
        container.close()

    if not faces and not refused:
        raise FontRejected("invalid", "no_usable_face")
    if not faces:
        raise FontRejected("not_embeddable", refused[0].reason, refused)
    return fmt, faces, refused


def _cache_path() -> Path:
    return data_dir() / "fonts.json"


def _file_key(path: Path) -> tuple[int, float] | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    return stat.st_size, stat.st_mtime


def _face_to_json(face: FontFace) -> dict[str, object]:
    return {
        "family": face.family,
        "style": face.style,
        "weight": face.weight,
        "italic": face.italic,
        "index": face.index,
        "embeddable": face.embeddable,
        "reason": face.reason,
        "scripts": sorted(face.scripts),
        "variable": face.variable,
    }


def _face_from_json(path: str, data: dict[str, object]) -> FontFace:
    scripts = data["scripts"]
    if not isinstance(scripts, list):  # a damaged cache file: skip the entry, never crash
        raise ValueError("bad cache entry: scripts")
    return FontFace(
        family=str(data["family"]),
        style=str(data["style"]),
        weight=int(str(data["weight"])),
        italic=bool(data["italic"]),
        path=path,
        index=int(str(data["index"])),
        embeddable=bool(data["embeddable"]),
        reason=str(data["reason"]),
        scripts=frozenset(scripts),
        variable=bool(data["variable"]),
    )


class FontCatalog:
    """An indexed view of the font files on disk, cached in ``data_dir()/fonts.json``.

    ``folders`` replaces the system font folders as the default for :meth:`scan`, for hosts
    with no system fonts (the web scans the fonts the user uploaded). ``cache_path`` replaces
    the cache file's location; ``None`` keeps the desktop's.
    """

    def __init__(
        self,
        folders: Sequence[Path] | None = None,
        cache_path: Path | None = None,
    ) -> None:
        self._faces: list[FontFace] = []
        self._by_path: dict[str, list[FontFace]] = {}
        self._folders = list(folders) if folders is not None else None
        self._cache_path = cache_path

    def _cache_file(self) -> Path:
        return self._cache_path if self._cache_path is not None else _cache_path()

    def faces(self) -> list[FontFace]:
        return list(self._faces)

    def families(self) -> list[str]:
        names = {face.family for face in self._faces}
        return sorted(names, key=str.casefold)

    def faces_of(self, family: str) -> list[FontFace]:
        return [face for face in self._faces if face.family == family]

    def find(
        self, family: str, bold: bool = False, italic: bool = False, weight: int | None = None
    ) -> FontFace | None:
        """The face of ``family`` that best matches ``bold``/``italic``, or ``None``.

        Among equal matches the weight nearest ``weight`` wins (default 400, or 700 for bold),
        so a family with Light/Semibold/Black faces gives Regular and Bold, not whichever face
        was scanned first.
        """
        candidates = self.faces_of(family)
        if not candidates:
            return None
        target = weight if weight is not None else 700 if bold else 400

        def score(face: FontFace) -> tuple[int, int, int]:
            is_bold = face.weight >= 600
            return (int(is_bold != bold), int(face.italic != italic), abs(face.weight - target))

        return min(candidates, key=score)

    def face_for(self, ref: FontRef) -> FontFace | None:
        if ref.kind is not FontRefKind.FILE:
            return None
        for face in self._by_path.get(ref.path, []):
            if face.index == ref.index:
                return face
        return None

    def load_cache(self) -> None:
        """Load the on-disk cache without touching the filesystem for font files.

        Fast path for app startup: shows what was known as of the last scan.
        """
        path = self._cache_file()
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            return
        if not isinstance(raw, dict) or raw.get("version") != CACHE_VERSION:
            return
        entries = raw.get("files")
        if not isinstance(entries, dict):
            return
        faces: list[FontFace] = []
        by_path: dict[str, list[FontFace]] = {}
        for file_path, entry in entries.items():
            try:
                face_list = [_face_from_json(file_path, item) for item in entry["faces"]]
            except (KeyError, TypeError, ValueError):
                continue
            faces.extend(face_list)
            by_path[file_path] = face_list
        self._faces = faces
        self._by_path = by_path

    def scan(
        self,
        dirs: Iterable[Path] | None = None,
        token: CancelToken | None = None,
        progress: ProgressFn = no_progress,
    ) -> None:
        """Rebuild the catalog from ``dirs`` (default: the constructor's folders, else
        :func:`system_font_dirs`).

        Reuses the cache for files whose size and mtime haven't changed; reads everything
        else. Cancellable: raises :class:`pdfeditor.core.jobs.Cancelled` via ``token``, and
        the cache on disk is left as it was before the scan.
        """
        if dirs is not None:
            search_dirs = list(dirs)
        elif self._folders is not None:
            search_dirs = list(self._folders)
        else:
            search_dirs = system_font_dirs()
        token = token or CancelToken()

        path = self._cache_file()
        cached_entries: dict[str, dict[str, object]] = {}
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict) and raw.get("version") == CACHE_VERSION:
                entries = raw.get("files")
                if isinstance(entries, dict):
                    cached_entries = entries
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            pass

        files = _iter_font_files(search_dirs)
        total = len(files)
        new_entries: dict[str, dict[str, object]] = {}
        faces: list[FontFace] = []
        by_path: dict[str, list[FontFace]] = {}

        for done, file_path in enumerate(files, start=1):
            token.check()
            key = _file_key(file_path)
            if key is None:
                progress(done, total)
                continue
            size, mtime = key
            str_path = str(file_path)
            cached = cached_entries.get(str_path)
            if cached is not None and cached.get("size") == size and cached.get("mtime") == mtime:
                try:
                    cached_faces = cached["faces"]
                    assert isinstance(cached_faces, list)
                    face_list = [_face_from_json(str_path, item) for item in cached_faces]
                except (KeyError, TypeError, ValueError, AssertionError):
                    face_list = read_faces(file_path)
            else:
                face_list = read_faces(file_path)
            new_entries[str_path] = {
                "size": size,
                "mtime": mtime,
                "faces": [_face_to_json(face) for face in face_list],
            }
            faces.extend(face_list)
            by_path[str_path] = face_list
            progress(done, total)

        self._faces = faces
        self._by_path = by_path
        try:
            path.write_text(
                json.dumps({"version": CACHE_VERSION, "files": new_entries}), encoding="utf-8"
            )
        except OSError:
            logger.debug("couldn't write font cache: %s", path, exc_info=True)


_shared_catalog: FontCatalog | None = None


def cached_catalog() -> FontCatalog:
    """A process-wide :class:`FontCatalog` loaded from disk (no filesystem scan).

    Call :meth:`FontCatalog.scan` on it (normally as a background job) to refresh it.
    """
    global _shared_catalog
    if _shared_catalog is None:
        _shared_catalog = FontCatalog()
        _shared_catalog.load_cache()
    return _shared_catalog
