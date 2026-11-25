"""PyMuPDF implementation of :class:`pdfeditor.engine.base.Document`."""

from __future__ import annotations

import contextlib
import hashlib
import logging
import os
import re
import shutil
import tempfile
import uuid
from collections import OrderedDict
from collections.abc import Sequence
from dataclasses import replace
from pathlib import Path
from typing import Any

import pymupdf

from pdfeditor.engine.base import (
    Document,
    EngineError,
    OpenError,
    OptimizeOptions,
    PasswordCallback,
    PasswordRequired,
    SaveError,
    SaveOptions,
)
from pdfeditor.engine.mupdf import autotag, pages, space
from pdfeditor.engine.mupdf import convert as cv
from pdfeditor.engine.mupdf import optimize as opt
from pdfeditor.engine.mupdf import sanitize as scrub
from pdfeditor.engine.mupdf import structure as struct
from pdfeditor.engine.mupdf.page import MuPage
from pdfeditor.engine.mupdf.pagecopy import SharingIndex, ensure_page_unshared
from pdfeditor.model.annotations import SYNTHETIC_NAME_PREFIX
from pdfeditor.model.color import Color
from pdfeditor.model.metadata import (
    DocumentInfo,
    EmbeddedFile,
    EncryptionMethod,
    FontInfo,
    ImageInfo,
    LayerInfo,
    Metadata,
    Permissions,
    SecuritySettings,
    SpaceUsage,
)
from pdfeditor.model.outline import Destination, OutlineItem, flatten
from pdfeditor.model.pages import PageLabelRule
from pdfeditor.model.redaction import SanitizeOptions
from pdfeditor.model.structure import AccessibilitySettings, StructNode

log = logging.getLogger(__name__)

_META_KEYS = {
    "title": "title",
    "author": "author",
    "subject": "subject",
    "keywords": "keywords",
    "creator": "creator",
    "producer": "producer",
    "creation_date": "creationDate",
    "mod_date": "modDate",
}
MAX_PASSWORD_ATTEMPTS = 5


def _open_fz(source: Path | bytes) -> pymupdf.Document:
    try:
        if isinstance(source, bytes):
            fz = pymupdf.open(stream=source, filetype="pdf")
        else:
            if not source.exists():
                raise OpenError(f"file not found: {source}")
            if source.stat().st_size == 0:
                raise OpenError("the file is empty")
            fz = pymupdf.open(source, filetype="pdf")
    except OpenError:
        raise
    except Exception as exc:
        log.info("open failed: %s", exc)
        raw = source if isinstance(source, bytes) else source.read_bytes()
        handler = _raw_security_handler(raw)
        if handler not in (None, "Standard"):
            raise OpenError(_unsupported_security(handler)) from exc
        raise OpenError("this isn't a PDF file, or it is too damaged to repair") from exc
    if not fz.is_pdf:
        fz.close()
        raise OpenError("not a PDF document")
    handler = _security_handler(fz)
    if handler not in (None, "Standard"):
        fz.close()
        raise OpenError(_unsupported_security(handler))
    return fz


def _unsupported_security(handler: str) -> str:
    return (
        f"the document uses a security handler that isn't supported ({handler}). "
        "It was probably encrypted for specific people with certificates or a rights-management "
        "server; open it in the application that can use those"
    )


def _raw_security_handler(raw: bytes) -> str | None:
    """The /Filter of the /Encrypt dictionary, found by scanning the file (for files MuPDF
    refuses outright)."""
    ref = re.search(rb"/Encrypt\s+(\d+)\s+\d+\s+R", raw)
    if ref is not None:
        body = re.search(rb"\b" + ref.group(1) + rb"\s+\d+\s+obj(.*?)endobj", raw, re.S)
        text = body.group(1) if body else b""
    else:
        inline = re.search(rb"/Encrypt\s*<<(.*?)>>", raw, re.S)
        text = inline.group(1) if inline else b""
    found = re.search(rb"/Filter\s*/([\w.#-]+)", text)
    return found.group(1).decode("latin-1") if found else None


def _security_handler(fz: pymupdf.Document) -> str | None:
    """The /Filter of the trailer's /Encrypt dictionary (None when not encrypted)."""
    try:
        kind, value = fz.xref_get_key(-1, "Encrypt")
        if kind == "null":
            return None
        if kind == "xref":
            kind, value = fz.xref_get_key(int(value.split()[0]), "Filter")
        else:
            kind, value = fz.xref_get_key(-1, "Encrypt/Filter")
    except (ValueError, RuntimeError):  # a dangling /Encrypt in a damaged file
        return None
    return value.lstrip("/") if kind == "name" else None


def _authenticate(fz: pymupdf.Document, password: str | PasswordCallback | None) -> str | None:
    """Unlock ``fz`` if needed; returns the password that worked (None if not encrypted)."""
    if not fz.needs_pass:
        return None
    if isinstance(password, str):
        if fz.authenticate(password):
            return password
        raise PasswordRequired("wrong password")
    if password is None:
        raise PasswordRequired("document is password protected")
    for attempt in range(1, MAX_PASSWORD_ATTEMPTS + 1):
        candidate = password(attempt)
        if candidate is None:
            break
        if fz.authenticate(candidate):
            return candidate
    raise PasswordRequired("document is password protected")


_DAMAGED_MESSAGE = "the file is too damaged to read"
# What MuPDF raises for damage: PyMuPDF maps some errors to RuntimeError or ValueError and
# others (a bad object, a syntax error) to its FzErrorBase classes.
_MUPDF_OPEN_ERRORS: tuple[type[BaseException], ...] = (
    RuntimeError,
    ValueError,
    pymupdf.mupdf.FzErrorBase,
)


def open_document(source: Path | bytes, password: str | PasswordCallback | None) -> MuDocument:
    fz = _open_fz(source)
    try:
        used = _authenticate(fz, password)
        path = source.resolve() if isinstance(source, Path) else None
        if fz.is_repaired:
            log.warning("document was repaired on open: %s", path or "<bytes>")
        # Only a signed document needs an original to append its in-place update to (see
        # incremental_bytes). A document opened from bytes keeps those bytes for that, and only
        # then.
        signed = (fz.get_sigflags() or 0) > 0
        kept = source if isinstance(source, bytes) and signed else None
        return MuDocument(fz, path, used, source_bytes=kept, lineage=signed)
    except PasswordRequired:
        fz.close()
        raise
    except _MUPDF_OPEN_ERRORS as exc:
        # Damage that the open itself accepted (a bad page tree, a bad xref) surfaces here. Any
        # other error is a bug and is not caught.
        fz.close()
        raise OpenError(_DAMAGED_MESSAGE) from exc


# Most pages with MuPDF objects (a fz page, display lists) loaded at once. Each loaded page holds
# MuPDF memory until it is evicted, so scrolling through a large document stays bounded. The same
# limit applies on desktop and web.
PAGE_OBJECT_LIMIT = 64


class MuDocument:
    def __init__(
        self,
        fz: pymupdf.Document,
        path: Path | None,
        password: str | None,
        source_bytes: bytes | None = None,
        lineage: bool = False,
    ) -> None:
        self._fz = fz
        self._path = path
        # In-place incremental saves (see incremental_bytes). The lineage is the original file a
        # signed document's single update is appended to: the bytes when opened from bytes, else
        # the file at _path (read on use).
        self._lineage_on = lineage
        self._lineage_base: bytes | None = source_bytes
        self._lineage_written = False  # the one update has been written (see incremental_bytes)
        self._lineage_output: bytes | None = None
        self._lineage_edit = -1
        self._lineage_digest = b""
        self._edits = 0  # bumped by every change (see incremental_bytes)
        # synthetic name -> the /NM it was replaced with (this session; names are unique per
        # document, so the page isn't part of the key)
        self.renamed: dict[str, str] = {}
        self._password = password
        self._pages: dict[int, MuPage] = {}
        # Pages with loaded MuPDF objects, least recently used first. Touched and evicted only
        # under the engine lock (see touch_page); MuPage.invalidate removes its own entry.
        self._loaded: OrderedDict[MuPage, None] = OrderedDict()
        self._revisions: dict[int, int] = {}
        self._generation = 0  # bumped whenever the whole document is reloaded
        # Cached so page()/revision never call into MuPDF (they're used without the lock).
        self._page_count = int(fz.page_count)
        self._backing_tmp: Path | None = None  # set when a failed save left us on a temp file
        self._force_dirty = False
        self._security: SecuritySettings | None = None  # applied on the next full save
        self._sharing = SharingIndex()
        # Set when content editing embedded a font file (content.py, pages.py); a full save
        # then subsets it so an installed font's whole program isn't kept in the PDF.
        self._gained_file_fonts = False
        # Objects below this number came with the file: their fonts are never subset on save
        # (a complete embedded font lets later edits add characters).
        self._loaded_xrefs = int(self._fz.xref_length())
        # snapshot digest -> (_loaded_xrefs, _gained_file_fonts) when it was taken: a full save
        # renumbers objects, so undoing past it must bring back the numbering's own boundary
        self._snapshot_fonts: dict[bytes, tuple[int, bool]] = {}

    # -- internal ---------------------------------------------------------------------------
    @property
    def fz(self) -> pymupdf.Document:
        return self._fz

    def page_revision(self, index: int) -> int:
        return self._generation * 1_000_000 + self._revisions.get(index, 0)

    def note_file_font_embedded(self) -> None:
        """Record that a FILE font ref was just embedded, so the next full save subsets it."""
        self._edits += 1  # any change; see incremental_bytes
        self._gained_file_fonts = True

    def mark_page_changed(self, index: int) -> None:
        self._edits += 1  # any change; see incremental_bytes
        self._invalidate_page(index)

    def _invalidate_page(self, index: int) -> None:
        """A new revision and dropped caches for one page, without counting as an edit. Only a
        view change that writes no object (a layer toggle) may use this alone."""
        self._revisions[index] = self._revisions.get(index, 0) + 1
        self._sharing.dirty(index)
        page = self._pages.get(index)
        if page is not None:
            page.invalidate()

    def unshare_page(self, index: int) -> None:
        """Copy-on-write: call before changing page ``index`` in place, so the change can't
        show on another page that shares its content, resources or annotations.

        Every in-place page change calls this first, shared or not, so it's where the edit
        counter moves for page changes: a clean page changes no revision, and the save cache
        must still notice (see incremental_bytes)."""
        self._edits += 1
        result = ensure_page_unshared(self._fz, index, self._sharing)
        if result.structure:
            self.structure_changed()
        for changed in result.pages:
            self.mark_page_changed(changed)

    def structure_changed(self) -> None:
        """Call after pages were inserted, deleted or moved: resync counts and drop caches."""
        self._reset_pages()

    def _reset_pages(self) -> None:
        self._edits += 1  # any change; see incremental_bytes
        self._sharing.reset()
        self._generation += 1
        self._page_count = int(self._fz.page_count)
        for page in [*self._pages.values(), *self._loaded]:
            page.invalidate()
        self._loaded.clear()
        self._pages.clear()

    def touch_page(self, page: MuPage) -> None:
        """Mark ``page`` as the most recently used loaded page, and evict the oldest pages over
        ``PAGE_OBJECT_LIMIT``.

        Called from MuPage.fz and MuPage._display_list, which already call MuPDF, so the engine
        lock is held: freeing a MuPDF object outside it can corrupt the heap. An evicted MuPage
        stays valid; its objects reload on its next access.
        """
        loaded = self._loaded
        loaded[page] = None
        loaded.move_to_end(page)
        while len(loaded) > PAGE_OBJECT_LIMIT:
            oldest, _ = loaded.popitem(last=False)
            oldest.invalidate()

    @property
    def loaded_page_count(self) -> int:
        """Pages with MuPDF objects loaded right now (at most ``PAGE_OBJECT_LIMIT``)."""
        return len(self._loaded)

    def _catalog_key(self, key: str) -> tuple[str, str]:
        result: tuple[str, str] = self._fz.xref_get_key(self._fz.pdf_catalog(), key)
        return result

    # -- Document protocol ------------------------------------------------------------------
    @property
    def path(self) -> Path | None:
        return self._path

    @property
    def page_count(self) -> int:
        return self._page_count

    @property
    def is_dirty(self) -> bool:
        return bool(self._fz.is_dirty) or self._force_dirty

    @property
    def is_repaired(self) -> bool:
        """MuPDF had to repair the file when it was opened (the desktop's save check uses it)."""
        return bool(self._fz.is_repaired)

    def page(self, index: int) -> MuPage:
        if not 0 <= index < self.page_count:
            raise IndexError(f"page index {index} out of range 0..{self.page_count - 1}")
        page = self._pages.get(index)
        if page is None:
            page = self._pages[index] = MuPage(self, index)
        return page

    def info(self) -> DocumentInfo:
        # A damaged catalog passes the open and fails here, so it is an open failure too.
        try:
            return self._read_info()
        except _MUPDF_OPEN_ERRORS as exc:
            raise OpenError(_DAMAGED_MESSAGE) from exc

    def _read_info(self) -> DocumentInfo:
        fz = self._fz
        meta = fz.metadata or {}
        size = None
        if self._path is not None and self._path.exists():
            size = self._path.stat().st_size
        names_js = self._catalog_key("Names/JavaScript")[0] != "null"
        kind, open_action = self._catalog_key("OpenAction")
        if kind == "xref":  # an indirect action object: look inside it
            open_action = fz.xref_object(int(open_action.split()[0]))
        open_js = "/JS" in open_action or "/JavaScript" in open_action
        marked = self._catalog_key("MarkInfo/Marked")[1] == "true"
        struct_tree = self._catalog_key("StructTreeRoot")[0] != "null"
        sigflags = fz.get_sigflags()
        return DocumentInfo(
            page_count=self.page_count,
            pdf_version=str(meta.get("format", "")).removeprefix("PDF ").strip(),
            encryption=_encryption_method(meta.get("encryption")),
            permissions=_permissions(fz.permissions),
            is_repaired=bool(fz.is_repaired),
            has_forms=bool(fz.is_form_pdf),
            has_signatures=sigflags is not None and sigflags > 0,
            has_javascript=names_js or open_js,
            is_tagged=marked or struct_tree,
            has_xmp=self._catalog_key("Metadata")[0] == "xref",
            file_size=size,
        )

    def metadata(self) -> Metadata:
        meta = self._fz.metadata or {}
        return Metadata(**{ours: meta.get(theirs) or "" for ours, theirs in _META_KEYS.items()})

    def set_metadata(self, meta: Metadata) -> None:
        self._edits += 1  # any change; see incremental_bytes
        self._fz.set_metadata({theirs: getattr(meta, ours) for ours, theirs in _META_KEYS.items()})

    def xmp(self) -> str:
        return str(self._fz.get_xml_metadata())

    def set_xmp(self, xml: str) -> None:
        self._edits += 1  # any change; see incremental_bytes
        if xml:
            self._fz.set_xml_metadata(xml)
        else:
            self._fz.del_xml_metadata()

    def outline(self) -> list[OutlineItem]:
        roots: list[OutlineItem] = []
        stack: list[tuple[int, OutlineItem]] = []
        for entry in self._fz.get_toc(simple=False):
            level, title, page_no = int(entry[0]), str(entry[1]), int(entry[2])
            info: dict[str, Any] = entry[3] if len(entry) > 3 else {}
            item = OutlineItem(title=title)
            if info.get("kind") == pymupdf.LINK_URI:
                item.uri = info.get("uri")
            elif page_no >= 1:
                to = info.get("to")
                item.dest = Destination(
                    page_index=page_no - 1,
                    point=cv.point(to) if to is not None else None,
                    zoom=float(info["zoom"]) if info.get("zoom") else None,
                )
            item.is_open = not info.get("collapse", True)
            if info.get("color"):
                item.color = Color(*info["color"])
            item.bold = bool(info.get("bold"))
            item.italic = bool(info.get("italic"))
            while stack and stack[-1][0] >= level:
                stack.pop()
            (stack[-1][1].children if stack else roots).append(item)
            stack.append((level, item))
        return roots

    def set_outline(self, items: Sequence[OutlineItem]) -> None:
        self._edits += 1  # any change; see incremental_bytes
        toc: list[list[Any]] = []
        for level, item in flatten(list(items)):
            info: dict[str, Any] = {"collapse": not item.is_open}
            if item.color is not None:
                info["color"] = item.color.rgb()
            if item.bold:
                info["bold"] = True
            if item.italic:
                info["italic"] = True
            if item.uri:
                info.update(kind=pymupdf.LINK_URI, uri=item.uri)
                toc.append([level, item.title, -1, info])
            elif item.dest is not None:
                info["kind"] = pymupdf.LINK_GOTO
                if item.dest.point is not None:
                    # set_toc encodes the point itself; toc_point makes it come out right.
                    target = self.page(item.dest.page_index).fz
                    info["to"] = space.toc_point(target, cv.to_fz_point(item.dest.point))
                if item.dest.zoom:
                    info["zoom"] = item.dest.zoom
                toc.append([level, item.title, item.dest.page_index + 1, info])
            else:
                toc.append([level, item.title, -1, info])
        self._fz.set_toc(toc)

    def page_label(self, index: int) -> str:
        label = self.page(index).fz.get_label()
        return str(label) if label else str(index + 1)

    def page_labels(self) -> list[str]:
        return pages.page_labels(self)

    def embedded_files(self) -> list[EmbeddedFile]:
        out = []
        for name in self._fz.embfile_names():
            info = self._fz.embfile_info(name)
            out.append(
                EmbeddedFile(
                    name=name,
                    filename=info.get("ufilename") or info.get("filename") or name,
                    size=int(info.get("size") or info.get("length") or 0),
                    description=info.get("description") or "",
                )
            )
        return out

    def extract_embedded_file(self, name: str) -> bytes:
        try:
            return bytes(self._fz.embfile_get(name))
        except Exception as exc:  # a damaged stream raises a MuPDF error; callers see EngineError
            raise EngineError(f"couldn't read the attachment {name!r}") from exc

    def add_embedded_file(
        self, name: str, data: bytes, filename: str, description: str = ""
    ) -> None:
        if name in self._fz.embfile_names():
            raise EngineError(f"an attachment named {name!r} already exists")
        self._edits += 1  # any change; see incremental_bytes
        self._fz.embfile_add(name, data, filename=filename, ufilename=filename, desc=description)

    def remove_embedded_file(self, name: str) -> None:
        if name not in self._fz.embfile_names():
            raise EngineError(f"no attachment named {name!r}")
        self._edits += 1  # any change; see incremental_bytes
        # PyMuPDF's ``embfile_del`` indexes the flat key/value array by entry, not by pair, so it
        # removes the wrong file for any entry but the first. Find the key here and remove its
        # pair, as ``embfile_names`` reads the same array.
        pdf = pymupdf._as_pdf_document(self._fz)
        names = pymupdf.mupdf.pdf_dict_getl(
            pymupdf.mupdf.pdf_trailer(pdf),
            pymupdf.PDF_NAME("Root"),
            pymupdf.PDF_NAME("Names"),
            pymupdf.PDF_NAME("EmbeddedFiles"),
            pymupdf.PDF_NAME("Names"),
        )
        for i in range(0, pymupdf.mupdf.pdf_array_len(names), 2):
            key = pymupdf.mupdf.pdf_to_text_string(pymupdf.mupdf.pdf_array_get(names, i))
            if key == name:
                pymupdf.mupdf.pdf_array_delete(names, i + 1)
                pymupdf.mupdf.pdf_array_delete(names, i)
                return
        raise EngineError(f"no attachment named {name!r}")  # listed, yet not in the array

    def layers(self) -> list[LayerInfo]:
        return [
            LayerInfo(
                id=int(cfg["number"]),
                name=str(cfg["text"]),
                visible=bool(cfg["on"]),
                depth=int(cfg["depth"]),
                locked=bool(cfg["locked"]),
            )
            for cfg in self._fz.layer_ui_configs()
        ]

    def set_layer_visible(self, layer_id: int, visible: bool) -> None:
        # No ``_edits`` bump: a view toggle writes no object (checked: the object digest is the
        # same before and after), so a later in-place save may still reuse the cached update.
        self._fz.set_layer_ui_config(layer_id, 0 if visible else 2)
        # Cached display lists bake in layer visibility, so every page gets a new revision.
        for index in range(self.page_count):
            self._invalidate_page(index)

    def fonts(self) -> list[FontInfo]:
        seen: dict[int, FontInfo] = {}
        pages: dict[int, list[int]] = {}
        for pno in range(self.page_count):
            for xref, ext, ftype, basefont, _name, encoding, *_ in self._fz.get_page_fonts(pno):
                used = pages.setdefault(xref, [])
                if not used or used[-1] != pno:
                    used.append(pno)
                if xref in seen:
                    continue
                subset = len(basefont) > 7 and basefont[6] == "+" and basefont[:6].isupper()
                seen[xref] = FontInfo(
                    name=basefont[7:] if subset else basefont,
                    type=ftype,
                    encoding=encoding,
                    embedded=ext not in ("n/a", ""),
                    subset=subset,
                    ref=xref,
                )
        return [replace(info, pages=tuple(pages[x])) for x, info in seen.items()]

    def extract_font(self, ref: int) -> tuple[str, bytes]:
        basename, ext, _type, buffer = self._fz.extract_font(ref)
        if not buffer or ext in ("n/a", ""):
            raise ValueError("this font is not embedded")
        name = basename.split("+", 1)[-1] or f"font-{ref}"
        return f"{name}.{ext}", bytes(buffer)

    def images(self) -> list[ImageInfo]:
        found: dict[int, tuple[tuple[int, int, str], list[int]]] = {}
        for pno in range(self.page_count):
            for xref, _smask, width, height, _bpc, colorspace, *_ in self._fz.get_page_images(pno):
                if xref <= 0:
                    continue
                entry = found.setdefault(xref, ((int(width), int(height), str(colorspace)), []))
                if pno not in entry[1]:
                    entry[1].append(pno)
        return [
            ImageInfo(xref, w, h, cs, tuple(pages)) for xref, ((w, h, cs), pages) in found.items()
        ]

    def extract_image(self, ref: int) -> tuple[bytes, str]:
        info = self._fz.extract_image(ref)
        if not info:
            raise ValueError(f"object {ref} is not an image")
        smask = int(info.get("smask") or 0)
        data, ext = bytes(info["image"]), str(info["ext"])
        if smask or ext not in ("png", "jpeg", "jpg", "tiff", "bmp", "gif"):
            # apply the soft mask / normalize unusual encodings (jbig2, ccitt, ...) to PNG
            pix = pymupdf.Pixmap(self._fz, ref)
            if pix.colorspace and pix.colorspace.n > 3:
                pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
            if smask:
                pix = pymupdf.Pixmap(pix, pymupdf.Pixmap(self._fz, smask))
            data, ext = pix.tobytes("png"), "png"
        return data, "jpeg" if ext == "jpg" else ext

    # -- saving -----------------------------------------------------------------------------
    def _save_kwargs(self, options: SaveOptions) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "garbage": options.garbage,
            "deflate": options.deflate,
            "use_objstms": 1 if options.object_streams else 0,
            "clean": options.clean_content,
            "encryption": pymupdf.PDF_ENCRYPT_KEEP,
        }
        if options.decrypt:
            kwargs["encryption"] = pymupdf.PDF_ENCRYPT_NONE
            return kwargs
        s = self._security
        if s is not None and options.apply_security:
            kwargs["encryption"] = _ENCRYPT_METHODS[s.method]
            if s.method is not EncryptionMethod.NONE:
                kwargs["user_pw"] = s.user_password
                kwargs["owner_pw"] = s.owner_password or s.user_password
                kwargs["permissions"] = _permission_bits(s.permissions)
        return kwargs

    # -- structure (tags) -------------------------------------------------------------------------
    def structure_tree(self) -> list[StructNode]:
        return struct.structure_tree(self._fz)

    def set_struct_element(self, ref: int, type: str | None = None, alt: str | None = None) -> None:
        self._edits += 1  # any change; see incremental_bytes
        struct.set_struct_element(self._fz, ref, type, alt)

    def reorder_struct_children(self, parent: int | None, order: Sequence[int]) -> None:
        self._edits += 1
        struct.reorder_children(self._fz, parent, order)

    def auto_tag(self) -> dict[str, int]:
        self._edits += 1
        return autotag.auto_tag(self)

    def accessibility_settings(self) -> AccessibilitySettings:
        return struct.accessibility_settings(self._fz)

    def set_accessibility_settings(self, settings: AccessibilitySettings) -> None:
        self._edits += 1  # any change; see incremental_bytes
        struct.set_accessibility_settings(self._fz, settings)

    # -- security -------------------------------------------------------------------------------
    def pending_security(self) -> SecuritySettings | None:
        return self._security

    def set_pending_security(self, settings: SecuritySettings | None) -> None:
        self._edits += 1  # any change; see incremental_bytes
        if settings is not None and settings.method not in _ENCRYPT_METHODS:
            raise EngineError(f"can't encrypt with {settings.method.value}")
        self._security = settings

    def has_owner_access(self) -> bool:
        if not (self._fz.metadata or {}).get("encryption"):
            return True
        # re-authenticating with the password that already worked is safe
        return int(self._fz.authenticate(self._password or "")) in (1, 4, 6)

    def unlock_owner(self, password: str) -> bool:
        self._edits += 1
        # A wrong password leaves an already-open MuPDF document unreadable, so try it on a
        # scratch copy first.
        probe = pymupdf.open("pdf", self._fz.tobytes(encryption=pymupdf.PDF_ENCRYPT_KEEP))
        try:
            ok = int(probe.authenticate(password)) in (4, 6)
        finally:
            probe.close()
        if ok:
            self._fz.authenticate(password)
            self._password = password
        return ok

    def _verify(self, path: Path, expected_pages: int) -> None:
        """Reopen a freshly written file and check it's sound before we trust it."""
        try:
            check = pymupdf.open(path, filetype="pdf")
        except Exception as exc:
            raise SaveError(f"saved file cannot be reopened: {exc}") from exc
        try:
            if check.needs_pass and self._password is not None:
                check.authenticate(self._password)
            if check.is_repaired:
                raise SaveError("saved file needed repair when reopened")
            if check.page_count != expected_pages:
                raise SaveError(
                    f"saved file has {check.page_count} pages, expected {expected_pages}"
                )
        finally:
            check.close()

    def _reopen(self, path: Path) -> None:
        self._fz = _open_fz(path)
        if self._fz.needs_pass:
            self._fz.authenticate(self._password or "")
        # The saved file is the new original: a fresh lineage, starting from it.
        self._lineage_on = (self._fz.get_sigflags() or 0) > 0
        self._lineage_base = None
        self._lineage_written = False
        self._lineage_output = None
        self._edits += 1
        self._loaded_xrefs = int(self._fz.xref_length())
        self._reset_pages()

    def _subset_new_fonts(self) -> None:
        """Subset the fonts added since the file was loaded, and only those.

        ``subset_fonts`` works on every font, but skips names that already carry a subset tag:
        the file's own complete fonts get one for the duration of the call.
        """
        fz = self._fz
        hidden: dict[int, str] = {}
        for pno in range(fz.page_count):
            for xref, ext, _type, basefont, *_ in fz.get_page_fonts(pno):
                tagged = len(basefont) > 7 and basefont[6] == "+"
                if xref in hidden or xref >= self._loaded_xrefs or tagged or ext in ("n/a", ""):
                    continue
                source = fz.xref_object(xref, compressed=True)
                tagged_source = re.sub(r"/BaseFont\s*/", "/BaseFont/KEEPFT+", source, count=1)
                if tagged_source != source:  # (names with "+" can't go through xref_set_key)
                    hidden[xref] = source
                    fz.update_object(xref, tagged_source)
        try:
            fz.subset_fonts()
        finally:
            for xref, source in hidden.items():
                fz.update_object(xref, source)

    def save(self, path: Path | None = None, options: SaveOptions | None = None) -> Path:
        # A full save names unnamed annotations in the live document before writing (below).
        self._edits += 1
        options = options or SaveOptions()
        base = path or self._path
        if base is None:
            raise SaveError("document has no file name; use save-as")
        target = base.resolve()
        if options.incremental:
            self._save_incremental(target)
        else:
            self._name_unnamed_annotations()
            self._save_full(target, options)
        self._path = target
        if options.incremental:
            # MuPDF's writer has advanced past the original file, so a further update can't be
            # appended to it: in-place bytes are not available after an incremental file save.
            self._lineage_on = False
        self._force_dirty = False
        return target

    def _name_unnamed_annotations(self) -> int:
        """Give every annotation without a /NM a unique name before a full save.

        Object numbers can change in a full rewrite, so a synthetic name would not survive the
        save; a real /NM does. The names are set in the open document, so they are in the file
        and stay after the reload. Each synthetic name is recorded as renamed, so undo entries
        made before the save still find their comments. This doesn't go through a Command: it
        changes no visible content and isn't a user edit. Incremental saves don't call this
        (object numbers don't change there), and snapshots (``to_bytes``) never name anything.
        """
        # Collect first, then write: nothing is changed while the annotation list is walked.
        unnamed: list[int] = []
        for index in range(self.page_count):
            unnamed.extend(
                a.xref for a in self._fz.load_page(index).annots() if not a.info.get("id")
            )
        for xref in unnamed:
            name = f"pdfeditor-{uuid.uuid4().hex}"
            self._fz.xref_set_key(xref, "NM", pymupdf.get_pdf_str(name))
            self.renamed[f"{SYNTHETIC_NAME_PREFIX}{xref}"] = name
        return len(unnamed)

    def _save_incremental(self, target: Path) -> None:
        if self._path is None or target != self._path or self._backing_tmp is not None:
            raise SaveError("incremental save is only possible to the file the document came from")
        if not self._fz.can_save_incrementally():
            raise SaveError("this document can't be saved incrementally; use a full save")
        backup = target.with_name(f".{target.name}.{uuid.uuid4().hex[:8]}.bak")
        shutil.copy2(target, backup)
        pages = self.page_count
        try:
            self._fz.save(target, incremental=True, encryption=pymupdf.PDF_ENCRYPT_KEEP)
            self._verify(target, pages)
        except Exception as exc:
            log.error("incremental save failed, restoring backup: %s", exc)
            self._fz.close()
            shutil.copy2(backup, target)
            self._reopen(target)
            if isinstance(exc, SaveError):
                raise
            raise SaveError(str(exc)) from exc
        finally:
            with contextlib.suppress(OSError):
                backup.unlink()

    def _subset_gained_fonts(self, options: SaveOptions) -> bool:
        """Subset the fonts this app embedded, for a full save (not for an incremental one).
        Returns whether it ran."""
        if self._gained_file_fonts and options.subset_fonts:
            self._subset_new_fonts()
            return True
        return False

    def prepare_full_save(self, options: SaveOptions) -> None:
        """What a full save does to the open document before writing it, as :meth:`save`
        does: names unnamed annotations and subsets the fonts this app embedded. Done in the
        open document too. It counts as a change (bumps the edit counter) only when it changed
        something: a repeat copy of an unchanged document must not spend the in-place lineage."""
        try:
            changed = self._name_unnamed_annotations() > 0
            changed = self._subset_gained_fonts(options) or changed
        except pymupdf.mupdf.FzErrorBase as exc:
            # Naming an annotation loads its page, which a damaged page tree can refuse.
            log.info("save preparation failed: %s", exc)
            raise SaveError("the document's page tree is too damaged to save") from exc
        if changed:
            self._edits += 1

    def _save_full(self, target: Path, options: SaveOptions) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(f".{target.name}.{uuid.uuid4().hex[:8]}.tmp")
        pages = self.page_count
        old_password = self._password
        security = self._security
        if security is not None:  # the saved file opens with the new passwords
            self._password = (
                None
                if security.method is EncryptionMethod.NONE
                else security.owner_password or security.user_password
            )
        try:
            self._subset_gained_fonts(options)
            self._fz.save(tmp, **self._save_kwargs(options))
            self._verify(tmp, pages)
        except Exception as exc:
            self._password = old_password
            with contextlib.suppress(OSError):
                tmp.unlink()
            if isinstance(exc, SaveError):
                raise
            raise SaveError(str(exc)) from exc
        # MuPDF keeps its source file open (locked on Windows): release it before replacing.
        self._fz.close()
        old_backing = self._backing_tmp
        try:
            os.replace(tmp, target)
        except OSError as exc:
            # Keep all edits by continuing on the verified temp file; the user can retry.
            self._reopen(tmp)
            self._backing_tmp = tmp
            self._force_dirty = True
            raise SaveError(f"cannot replace {target}: {exc}") from exc
        self._reopen(target)
        self._backing_tmp = None
        self._security = None  # now part of the file
        self._gained_file_fonts = False
        if old_backing is not None:
            with contextlib.suppress(OSError):
                old_backing.unlink()

    def can_save_incrementally(self) -> bool:
        return (
            self._security is None  # encryption can only change in a full rewrite
            and self._path is not None
            and self._backing_tmp is None
            and bool(self._fz.name)
            and bool(self._fz.can_save_incrementally())
        )

    def incremental_bytes(self, options: SaveOptions) -> bytes | None:
        """See ``Document.incremental_bytes``. The caller holds the engine lock.

        Writes ONE update against the original file (the lineage). pymupdf's ``save`` would
        append only onto the file the document was opened from, which would change the user's
        file, so MuPDF's own writer (the one ``save`` calls) writes the update onto a temporary
        copy of the original, which is read back. Nothing on disk changes.

        MuPDF's writer can't be run a second time on the same document: after a write it keeps
        an advanced cross-reference state that a further update would not match. So the update
        is written once per lineage. The same unchanged state returns the same bytes (cached);
        a change after that write makes an in-place save impossible, and it raises SaveError.
        """
        if not self._lineage_on or self._security is not None or self._backing_tmp is not None:
            return None
        digest = self._state_digest()
        if (
            self._lineage_output is not None
            and self._lineage_edit == self._edits
            and self._lineage_digest == digest
        ):
            return self._lineage_output
        if self._lineage_written:
            raise SaveError(
                "This signed document can only be saved in place once after it changes; "
                "save as a new file to keep the signatures."
            )
        if not self._fz.can_save_incrementally():
            return None
        base = self._lineage_base
        if base is None and self._path is not None:
            try:
                base = self._path.read_bytes()
            except OSError as exc:
                raise SaveError(f"cannot read {self._path}: {exc}") from exc
        if base is None:
            return None
        # Same preparation as ``save``, so the update matches a file save. The writer options
        # stay at MuPDF's defaults apart from the update itself: no garbage collection,
        # compression or renumbering, which would rewrite the original's bytes. The /ID is kept
        # as it is: MuPDF would otherwise give every write a new random second identifier, and
        # the same state would then never produce the same bytes.
        write_opts = pymupdf.mupdf.PdfWriteOptions()
        write_opts.do_incremental = 1
        write_opts.do_encrypt = pymupdf.mupdf.PDF_ENCRYPT_KEEP
        write_opts.do_garbage = 0
        write_opts.dont_regenerate_id = 1
        try:
            pdf = pymupdf._as_pdf_document(self._fz)
            # The clean steps may change objects before the update is written. The update
            # contains those changes, so the digest is taken after them: a repeat call on the
            # same state then finds the cache.
            pymupdf.JM_embedded_clean(pdf)
            pymupdf.JM_ensure_identity(pdf)
            with tempfile.TemporaryDirectory(prefix="pdfeditor-incr-") as tmp:
                target = Path(tmp) / "incremental.pdf"
                target.write_bytes(base)
                # Failures before this point leave the lineage unspent: MuPDF's writer hasn't run.
                # From here on it may have advanced its cross-reference state even if it fails,
                # so the lineage stays spent.
                self._lineage_written = True
                pymupdf.mupdf.pdf_save_document(pdf, str(target), write_opts)
                result = target.read_bytes()
        except Exception as exc:
            raise SaveError(f"incremental save failed: {exc}") from exc
        self._lineage_output = result
        self._lineage_edit = self._edits
        self._lineage_digest = self._state_digest()
        return result

    def _state_digest(self) -> bytes:
        """A digest of every object in the live document: the safety net under ``_edits``.

        A change that bypasses the edit counter still changes an object, so the cached output
        is never returned for a state it wasn't written from. The write itself leaves the
        objects as they were (the digest is the same before and after it), so the cache
        survives the write. Costs about 40 ms for a 1000-page file.
        """
        fz = self._fz
        h = hashlib.sha256()
        for xref in range(1, int(fz.xref_length())):
            try:
                h.update(fz.xref_object(xref, compressed=False).encode("utf-8", "surrogateescape"))
            except RuntimeError:  # a free entry in the cross-reference table
                h.update(b"free")
                continue
            if fz.xref_is_stream(xref):
                h.update(bytes(fz.xref_stream(xref) or b""))
        return h.digest()

    def load_state(self, data: bytes) -> None:
        self._edits += 1  # any change; see incremental_bytes
        new = _open_fz(data)
        if new.needs_pass and not new.authenticate(self._password or ""):
            new.close()
            raise OpenError("snapshot can't be decrypted with the document's password")
        self._fz.close()
        self._fz = new
        # A snapshot is not the original file, so no update can be appended to it: a signed
        # document may not be saved in place by bytes until it's saved to a file again.
        self._lineage_output = None
        self._lineage_written = self._lineage_written or self._lineage_on
        known = self._snapshot_fonts.get(hashlib.sha1(data).digest())
        if known is not None:
            self._loaded_xrefs, self._gained_file_fonts = known
        else:  # unknown numbering: treat every font as the document's own (never subset it)
            self._loaded_xrefs, self._gained_file_fonts = int(new.xref_length()), False
        self._reset_pages()

    def select_pages(self, order: Sequence[int]) -> None:
        self._edits += 1  # any change; see incremental_bytes
        pages.select(self, order)

    def insert_blank_page(self, at: int, width: float, height: float) -> None:
        self._edits += 1  # any change; see incremental_bytes
        pages.insert_blank(self, at, width, height)

    def insert_pages(self, source: Document, pages_: Sequence[int], at: int) -> None:
        self._edits += 1  # any change; see incremental_bytes
        if not isinstance(source, MuDocument):
            raise EngineError("can only copy pages between documents of the same engine")
        pages.insert_document(self, source, pages_, at)

    def insert_image_page(self, at: int, image: bytes) -> None:
        self._edits += 1  # any change; see incremental_bytes
        pages.insert_image_page(self, at, image)

    def page_label_rules(self) -> list[PageLabelRule]:
        return pages.label_rules(self)

    def set_page_label_rules(self, rules: Sequence[PageLabelRule]) -> None:
        self._edits += 1  # any change; see incremental_bytes
        pages.set_label_rules(self, rules)

    def sanitize(self, options: SanitizeOptions) -> list[str]:
        self._edits += 1  # any change; see incremental_bytes
        fz = self._fz
        report: list[str] = []
        before_meta = any(
            (fz.metadata or {}).get(k)
            for k in ("title", "author", "subject", "keywords", "creator", "producer")
        )
        if options.comments:
            removed = 0
            for index in range(self.page_count):
                page = fz.load_page(index)
                for annot in list(page.annots()):
                    if annot.type[0] not in (pymupdf.PDF_ANNOT_WIDGET, pymupdf.PDF_ANNOT_LINK):
                        page.delete_annot(annot)
                        removed += 1
            if removed:
                report.append(f"{removed} comment(s) and markup(s)")
        attachments = len(fz.embfile_names())
        links = sum(len(fz.load_page(i).get_links()) for i in range(self.page_count))
        has_js = self.info().has_javascript
        has_xmp = bool(fz.get_xml_metadata())
        hidden = 0
        if options.hidden_text:
            for index in range(self.page_count):
                # render mode 3 = invisible (typical of OCR layers and hidden text tricks)
                hidden += sum(
                    1 for span in fz.load_page(index).get_texttrace() if span.get("type") == 3
                )
        fz.scrub(
            attached_files=options.attachments,
            clean_pages=True,
            embedded_files=options.attachments,
            hidden_text=options.hidden_text,
            # the document-wide JavaScript and XMP pass is done by scrub_objects, which skips
            # object numbers missing from the xref (scrub() raises on them)
            javascript=False,
            metadata=options.metadata,
            redactions=False,  # applying marks is the separate, reviewed step
            remove_links=options.links,
            # scrub's reset_fields calls widget.reset() on every widget, which clears a
            # signature's /V; reset_form_values does the reset and leaves signatures alone
            reset_fields=False,
            reset_responses=options.comments,
            thumbnails=options.thumbnails,
            xml_metadata=False,
        )
        scrub.scrub_objects(fz, options.javascript, options.xmp)
        if options.form_data:
            # scrub() misses values held on a field's parent; see reset_form_values
            scrub.reset_form_values(fz)
        catalog = fz.pdf_catalog()
        if options.javascript:
            # scrub() blanks script text but leaves the actions; remove the triggers themselves
            kind, value = fz.xref_get_key(catalog, "OpenAction")
            action = fz.xref_object(int(value.split()[0])) if kind == "xref" else value
            if "/JavaScript" in action or "/JS" in action:
                fz.xref_set_key(catalog, "OpenAction", "null")
            fz.xref_set_key(catalog, "AA", "null")
            fz.xref_set_key(catalog, "Names/JavaScript", "null")
            for index in range(self.page_count):
                fz.xref_set_key(fz.page_xref(index), "AA", "null")
        if options.attachments and fz.xref_get_key(catalog, "PageMode")[1] == "/UseAttachments":
            fz.xref_set_key(catalog, "PageMode", "/UseNone")
        if options.metadata and before_meta:
            report.append("document properties (title, author, ...)")
        if options.xmp and has_xmp:
            report.append("XMP metadata")
        if options.javascript and has_js:
            report.append("JavaScript")
        if options.attachments and attachments:
            report.append(f"{attachments} attached file(s)")
        if options.links and links:
            report.append(f"{links} link(s)")
        if options.hidden_text and hidden:
            report.append(f"{hidden} hidden text run(s)")
        if options.form_data and fz.is_form_pdf:
            report.append("form field values")
        layers: list[str] = []
        if options.hidden_layers:
            sections, layers = scrub.remove_hidden_layers(self)
            if layers or sections:
                names = ", ".join(f'"{n}"' for n in layers)
                report.append(
                    f"{len(layers)} hidden layer(s)"
                    + (f" ({names})" if names else "")
                    + f" with {sections} content section(s)"
                )
        if options.off_page_text:
            glyphs = scrub.remove_off_page_text(self)
            if glyphs:
                report.append(f"{glyphs} off-page text character(s)")
        if options.hidden_layers and layers:
            # MuPDF reads /OCProperties once, at open: reload so the layer list is current
            fonts = self._loaded_xrefs, self._gained_file_fonts  # same numbering: keep them
            self.load_state(bytes(self._fz.tobytes(garbage=0, encryption=pymupdf.PDF_ENCRYPT_KEEP)))
            self._loaded_xrefs, self._gained_file_fonts = fonts
            self._force_dirty = True
        self._reset_pages()
        return report

    def copy(self) -> MuDocument:
        data = self._fz.tobytes(garbage=0, encryption=pymupdf.PDF_ENCRYPT_KEEP)
        return open_document(bytes(data), self._password)

    def space_usage(self) -> SpaceUsage:
        return opt.space_usage(self._fz)

    def optimize(self, options: OptimizeOptions) -> None:
        self._edits += 1  # any change; see incremental_bytes
        opt.optimize(self._fz, options)
        self._reset_pages()

    def to_bytes(self, options: SaveOptions | None = None) -> bytes:
        options = options or SaveOptions()
        # Garbage collection (garbage >= 2) compacts the open document's objects in place, which
        # would change the state an in-place update of a signed document is built on. Such a
        # write goes through a scratch copy instead.
        try:
            source = self._scratch_copy() if options.garbage >= 2 and self._lineage_on else self
            if source.page_count == 0:
                raise SaveError("the document has no pages, so it can't be saved")
            data = bytes(source._fz.tobytes(**source._save_kwargs(options)))
        except pymupdf.mupdf.FzErrorBase as exc:
            # The open accepted a page tree or object that MuPDF cannot write back (the scratch
            # copy of a signed document's write included).
            log.info("save failed: %s", exc)
            raise SaveError("the document's page tree is too damaged to write") from exc
        if options.garbage == 0:  # keeps object numbers: a snapshot that may be loaded back
            key = hashlib.sha1(data).digest()
            self._snapshot_fonts[key] = (self._loaded_xrefs, self._gained_file_fonts)
        return data

    def _scratch_copy(self) -> MuDocument:
        """An independent copy of the current state, with the same pending security settings."""
        data = bytes(self._fz.tobytes(garbage=0, encryption=pymupdf.PDF_ENCRYPT_KEEP))
        scratch = open_document(data, self._password)
        scratch._security = self._security
        return scratch

    def close(self) -> None:
        self._reset_pages()
        self._fz.close()
        if self._backing_tmp is not None:
            with contextlib.suppress(OSError):
                self._backing_tmp.unlink()
            self._backing_tmp = None


def _encryption_method(value: str | None) -> EncryptionMethod:
    if not value:
        return EncryptionMethod.NONE
    v = value.lower()
    if "aes" in v:
        return EncryptionMethod.AES_256 if "256" in v else EncryptionMethod.AES_128
    if "rc4" in v:
        return EncryptionMethod.RC4_40 if "40" in v else EncryptionMethod.RC4_128
    return EncryptionMethod.UNKNOWN


_ENCRYPT_METHODS = {
    EncryptionMethod.NONE: pymupdf.PDF_ENCRYPT_NONE,
    EncryptionMethod.AES_128: pymupdf.PDF_ENCRYPT_AES_128,
    EncryptionMethod.AES_256: pymupdf.PDF_ENCRYPT_AES_256,
}


def _permission_bits(p: Permissions) -> int:
    bits = 0
    for flag, on in (
        (pymupdf.PDF_PERM_PRINT, p.print),
        (pymupdf.PDF_PERM_MODIFY, p.modify),
        (pymupdf.PDF_PERM_COPY, p.copy),
        (pymupdf.PDF_PERM_ANNOTATE, p.annotate),
        (pymupdf.PDF_PERM_FORM, p.fill_forms),
        (pymupdf.PDF_PERM_ACCESSIBILITY, p.accessibility),
        (pymupdf.PDF_PERM_ASSEMBLE, p.assemble),
        (pymupdf.PDF_PERM_PRINT_HQ, p.print_high_quality),
    ):
        if on:
            bits |= flag
    return bits


def _permissions(bits: int) -> Permissions:
    return Permissions(
        print=bool(bits & pymupdf.PDF_PERM_PRINT),
        modify=bool(bits & pymupdf.PDF_PERM_MODIFY),
        copy=bool(bits & pymupdf.PDF_PERM_COPY),
        annotate=bool(bits & pymupdf.PDF_PERM_ANNOTATE),
        fill_forms=bool(bits & pymupdf.PDF_PERM_FORM),
        accessibility=bool(bits & pymupdf.PDF_PERM_ACCESSIBILITY),
        assemble=bool(bits & pymupdf.PDF_PERM_ASSEMBLE),
        print_high_quality=bool(bits & pymupdf.PDF_PERM_PRINT_HQ),
    )
