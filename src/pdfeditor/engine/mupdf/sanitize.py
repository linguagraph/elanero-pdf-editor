"""Sanitizing steps MuPDF's ``scrub()`` doesn't cover: hidden layers and off-page text.

* **Hidden layers.** Content in optional-content groups that are OFF in the default
  configuration is invisible in viewers but fully extractable. It is stripped from page and
  form XObject content streams (see :mod:`pdfeditor.engine.contentstream.optional`), hidden
  XObjects and annotations are dropped, and the hidden groups are removed from
  ``/OCProperties`` so the layer names go too.
* **Off-page text.** Glyphs lying entirely outside the CropBox can't be seen but are still in
  the file; they are removed with text-only redactions that cover exactly those glyphs, so a
  partly visible glyph at the edge stays.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from typing import TYPE_CHECKING

import pymupdf

from pdfeditor.engine.contentstream.optional import (
    VisibilityExpr,
    ocmd_visible,
    strip_hidden_content,
)
from pdfeditor.engine.contentstream.parser import ContentSyntaxError, parse, write
from pdfeditor.engine.mupdf import annots

if TYPE_CHECKING:
    from pdfeditor.engine.mupdf.document import MuDocument

log = logging.getLogger(__name__)

_REF = re.compile(r"(\d+)\s+(\d+)\s+R\b")
_NAMED_REF = re.compile(r"/([^\s/<>\[\]()]+)\s*(\d+)\s+\d+\s+R\b")
_TOKEN = re.compile(r"\[|\]|/[^\s/<>\[\]()]+|\d+\s+\d+\s+R\b")


def _refs(text: str) -> list[int]:
    return [int(m.group(1)) for m in _REF.finditer(text)]


def _decode_name(name: str) -> str:
    return re.sub(r"#([0-9A-Fa-f]{2})", lambda m: chr(int(m.group(1), 16)), name)


def _type(fz: pymupdf.Document, xref: int) -> str:
    kind, value = fz.xref_get_key(xref, "Type")
    return str(value).lstrip("/") if kind == "name" else ""


# -- which groups are hidden --------------------------------------------------------------------
class _Visibility:
    """OCG states in the document's default configuration (/OCProperties /D)."""

    def __init__(self, fz: pymupdf.Document) -> None:
        self.fz = fz
        catalog = fz.pdf_catalog()
        self.ocgs = _refs(fz.xref_get_key(catalog, "OCProperties/OCGs")[1])
        base = fz.xref_get_key(catalog, "OCProperties/D/BaseState")[1]
        on = set(_refs(fz.xref_get_key(catalog, "OCProperties/D/ON")[1]))
        off = set(_refs(fz.xref_get_key(catalog, "OCProperties/D/OFF")[1]))
        if base == "/OFF":
            self.off = {g for g in self.ocgs if g not in on}
        else:
            self.off = off
        self._cache: dict[int, bool] = {}
        self.used_by_visible_ocmd: set[int] = set()

    def is_on(self, ocg: int) -> bool:
        return ocg not in self.off

    def hidden(self, xref: int) -> bool:
        """Whether content tagged with the OCG/OCMD ``xref`` is hidden by default."""
        if xref not in self._cache:
            kind = _type(self.fz, xref)
            if kind == "OCG":
                self._cache[xref] = not self.is_on(xref)
            elif kind == "OCMD":
                ocgs = _refs(self.fz.xref_get_key(xref, "OCGs")[1])
                policy = self.fz.xref_get_key(xref, "P")[1].lstrip("/")
                ve_kind, ve = self.fz.xref_get_key(xref, "VE")
                expression = _parse_ve(ve) if ve_kind == "array" else None
                visible = ocmd_visible(ocgs, policy, self.is_on, expression)
                if visible:
                    self.used_by_visible_ocmd.update(ocgs)
                    self.used_by_visible_ocmd.update(_refs(ve) if expression else ())
                self._cache[xref] = not visible
            else:
                self._cache[xref] = False
        return self._cache[xref]


def _parse_ve(text: str) -> VisibilityExpr | None:
    stack: list[list[str | VisibilityExpr]] = []
    result: VisibilityExpr | None = None
    for token in _TOKEN.findall(text):
        if token == "[":
            stack.append([])
        elif token == "]":
            if not stack:
                return None
            done = stack.pop()
            if stack:
                stack[-1].append(done)
            else:
                result = done
        elif stack:
            stack[-1].append(token[1:] if token.startswith("/") else int(token.split()[0]))
    return result


# -- resources ----------------------------------------------------------------------------------
def _resources(fz: pymupdf.Document, holder: int, page: bool) -> tuple[int, str] | None:
    """(xref, key prefix) addressing ``holder``'s resource dictionary; pages inherit it."""
    seen: set[int] = set()
    while holder and holder not in seen:
        seen.add(holder)
        kind, value = fz.xref_get_key(holder, "Resources")
        if kind == "xref":
            return int(value.split()[0]), ""
        if kind == "dict":
            return holder, "Resources/"
        if not page:
            return None
        kind, value = fz.xref_get_key(holder, "Parent")
        holder = int(value.split()[0]) if kind == "xref" else 0
    return None


def _category(fz: pymupdf.Document, scope: tuple[int, str], category: str) -> dict[str, int]:
    owner, prefix = scope
    kind, value = fz.xref_get_key(owner, prefix + category)
    if kind == "xref":
        value = fz.xref_object(int(value.split()[0]), compressed=True)
    elif kind != "dict":
        return {}
    return {_decode_name(n): int(x) for n, x in _NAMED_REF.findall(value)}


def _drop_entries(
    fz: pymupdf.Document, scope: tuple[int, str], category: str, names: set[str]
) -> None:
    owner, prefix = scope
    kind, value = fz.xref_get_key(owner, prefix + category)
    if kind == "xref":
        owner, path = int(value.split()[0]), ""
    else:
        path = prefix + category + "/"
    for name in names:
        fz.xref_set_key(owner, path + name, "null")


# -- hidden layers ------------------------------------------------------------------------------
class _LayerStripper:
    def __init__(self, doc: MuDocument) -> None:
        self.doc = doc
        self.fz = doc.fz
        self.vis = _Visibility(self.fz)
        self.sections = 0
        self.done_forms: set[int] = set()
        self.keep: set[int] = set()  # hidden groups still referenced (by form fields)
        # resource entries to drop once every stream is done (resource dicts can be shared,
        # and a page processed later must still see the names to recognise hidden content)
        self.unused: list[tuple[tuple[int, str], str, set[str]]] = []

    def run(self) -> tuple[int, list[str]]:
        fz = self.fz
        if not self.vis.off:
            return 0, []
        for index in range(self.doc.page_count):
            page_xref = fz.page_xref(index)
            scope = _resources(fz, page_xref, page=True)
            if scope is not None:
                changed = self._rewrite(scope, fz[index].read_contents, index)
                if changed is not None:
                    new = fz.get_new_xref()
                    fz.update_object(new, "<<>>")
                    fz.update_stream(new, changed)
                    fz.xref_set_key(page_xref, "Contents", f"{new} 0 R")
            self._annotations(index)
            self.doc.mark_page_changed(index)
        for scope, category, unused in self.unused:
            _drop_entries(fz, scope, category, unused)
        dropped = {g for g in self.vis.off if g not in self.keep | self.vis.used_by_visible_ocmd}
        names = [self._name(g) for g in self.vis.ocgs if g in dropped]
        self._drop_groups(dropped)
        return self.sections, names

    def _rewrite(
        self, scope: tuple[int, str], read: Callable[[], bytes], index: int
    ) -> bytes | None:
        """Strip hidden content from one stream (and, recursively, the forms it draws)."""
        fz = self.fz
        properties = _category(fz, scope, "Properties")
        xobjects = _category(fz, scope, "XObject")
        hidden_props = {n for n, x in properties.items() if self.vis.hidden(x)}
        hidden_xobjects: set[str] = set()
        for name, xref in xobjects.items():
            kind, value = fz.xref_get_key(xref, "OC")
            if kind == "xref" and self.vis.hidden(int(value.split()[0])):
                hidden_xobjects.add(name)
            elif fz.xref_get_key(xref, "Subtype")[1] == "/Form":
                self._form(xref, scope, index)
        if not hidden_props and not hidden_xobjects:
            return None
        try:
            ops = parse(read())
        except ContentSyntaxError:
            log.warning("page %d: content can't be parsed; hidden layers left in place", index)
            return None
        new_ops, removed = strip_hidden_content(ops, hidden_props, hidden_xobjects)
        self.sections += removed
        self.unused.append((scope, "Properties", hidden_props))
        self.unused.append((scope, "XObject", hidden_xobjects))
        return write(new_ops)

    def _form(self, xref: int, parent_scope: tuple[int, str], index: int) -> None:
        if xref in self.done_forms:
            return
        self.done_forms.add(xref)
        scope = _resources(self.fz, xref, page=False) or parent_scope
        changed = self._rewrite(scope, lambda: self.fz.xref_stream(xref) or b"", index)
        if changed is not None:
            self.fz.update_stream(xref, changed)

    def _annotations(self, index: int) -> None:
        fz = self.fz
        page = fz[index]
        for annot in list(page.annots()):
            if self._annot_hidden(annot.xref):
                page.delete_annot(annot)
                self.sections += 1
        for widget in page.widgets():
            kind, value = fz.xref_get_key(widget.xref, "OC")
            if kind == "xref" and self.vis.hidden(int(value.split()[0])):
                # never delete form fields here; keep their groups so they stay hidden
                oc = int(value.split()[0])
                self.keep.add(oc)
                self.keep.update(_refs(fz.xref_get_key(oc, "OCGs")[1]))

    def _annot_hidden(self, xref: int) -> bool:
        kind, value = self.fz.xref_get_key(xref, "OC")
        return kind == "xref" and self.vis.hidden(int(value.split()[0]))

    def _name(self, ocg: int) -> str:
        kind, value = self.fz.xref_get_key(ocg, "Name")
        return str(value) if kind in ("string", "unicode") else f"layer {ocg}"

    def _drop_groups(self, dropped: set[int]) -> None:
        """Remove ``dropped`` OCGs from /OCProperties (group list, configurations, UI order)."""
        fz = self.fz
        catalog = fz.pdf_catalog()
        kind, value = fz.xref_get_key(catalog, "OCProperties")
        if kind not in ("dict", "xref"):
            return

        def strip(text: str) -> str:
            return _REF.sub(lambda m: "" if int(m.group(1)) in dropped else m.group(0), text)

        # indirect sub-objects (a /D or /Configs entry kept as its own object)
        pending = [int(value.split()[0])] if kind == "xref" else []
        pending += [x for x in _refs(value) if x not in self.vis.ocgs]
        seen: set[int] = set()
        while pending:
            xref = pending.pop()
            if xref in seen or _type(fz, xref) in ("OCG", "OCMD"):
                continue
            seen.add(xref)
            text = fz.xref_object(xref, compressed=True)
            pending += [x for x in _refs(text) if x not in self.vis.ocgs]
            fz.update_object(xref, strip(text))
        if kind == "dict":
            fz.xref_set_key(catalog, "OCProperties", strip(value))
        if not _refs(fz.xref_get_key(catalog, "OCProperties/OCGs")[1]):
            fz.xref_set_key(catalog, "OCProperties", "null")


def remove_hidden_layers(doc: MuDocument) -> tuple[int, list[str]]:
    """Strip content of layers that are OFF by default; returns (sections removed, names of
    the layers dropped)."""
    if doc.fz.xref_get_key(doc.fz.pdf_catalog(), "OCProperties")[0] == "null":
        return 0, []
    return _LayerStripper(doc).run()


# -- off-page text ------------------------------------------------------------------------------
def _outside(box: pymupdf.Rect, page: pymupdf.Rect) -> bool:
    return box.x1 <= page.x0 or box.x0 >= page.x1 or box.y1 <= page.y0 or box.y0 >= page.y1


def _off_page_boxes(page: pymupdf.Page) -> tuple[list[pymupdf.Rect], int]:
    """Redaction boxes covering the glyphs entirely outside the crop box, and their count.

    Consecutive off-page glyphs of a span share one box, as long as that box stays off the
    page. Boxes are inset a little so they don't catch a neighbouring, partly visible glyph
    (MuPDF removes every glyph a redaction box touches).
    """
    area = page.rect * page.derotation_matrix  # unrotated, the space texttrace reports in
    boxes: list[pymupdf.Rect] = []
    count = 0
    for span in page.get_texttrace():
        run: pymupdf.Rect | None = None
        for char in span["chars"]:
            box = pymupdf.Rect(char[3])
            if box.is_empty:
                x, y = char[2]
                box = pymupdf.Rect(x, y - 0.5, x + 0.5, y)
            if not _outside(box, area):
                if run is not None:
                    boxes.append(run)
                run = None
                continue
            count += 1
            if run is not None and _outside(run | box, area):
                run |= box
            else:
                if run is not None:
                    boxes.append(run)
                run = pymupdf.Rect(box)
        if run is not None:
            boxes.append(run)
    inset = []
    for b in boxes:
        dx, dy = min(0.5, b.width / 4), min(0.5, b.height / 4)
        inset.append(pymupdf.Rect(b.x0 + dx, b.y0 + dy, b.x1 - dx, b.y1 - dy))
    return inset, count


def remove_off_page_text(doc: MuDocument) -> int:
    """Remove glyphs that lie entirely outside their page's crop box; returns how many."""
    total = 0
    for index in range(doc.page_count):
        page = doc.page(index)
        boxes, count = _off_page_boxes(page.fz)
        if not boxes:
            continue
        doc.unshare_page(index)  # what lies off one page may be on another sharing its content
        stashed = annots.stash_redactions(page)
        try:
            for box in boxes:
                page.fz.add_redact_annot(box, fill=False)
            page.fz.apply_redactions(
                images=pymupdf.PDF_REDACT_IMAGE_NONE,
                graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
                text=pymupdf.PDF_REDACT_TEXT_REMOVE,
            )
        finally:
            annots.restore_redactions(page, stashed)
        doc.mark_page_changed(index)
        total += count
    return total


# -- form values ------------------------------------------------------------------------------
def _kids_of(fz: pymupdf.Document, xref: int, key: str) -> list[int]:
    """The references in an array key (direct or indirect) of an object."""
    kind, value = fz.xref_get_key(xref, key)
    if kind == "xref":  # an indirect array
        value = fz.xref_object(int(value.split()[0]), compressed=True)
    return [int(n) for n, _ in _REF.findall(value)]


def _chain(fz: pymupdf.Document, xref: int) -> list[int]:
    """The object and its ancestors up the ``/Parent`` chain, nearest first."""
    chain = [xref]
    for _ in range(32):  # field hierarchies are shallow; guards against a cycle
        kind, value = fz.xref_get_key(chain[-1], "Parent")
        if kind != "xref":
            break
        chain.append(int(value.split()[0]))
    return chain


def _inherited(fz: pymupdf.Document, xref: int, key: str) -> tuple[str, str]:
    """A field attribute as a reader sees it: on the field, or on the nearest ancestor that has
    it (``/FT`` and ``/V`` are inheritable). Returns ``("null", "")`` when no node has it."""
    for node in _chain(fz, xref):
        kind, value = fz.xref_get_key(node, key)
        if kind != "null":
            return kind, value
    return "null", ""


def _is_widget(fz: pymupdf.Document, xref: int) -> bool:
    kind, value = fz.xref_get_key(xref, "Subtype")
    return kind == "name" and value.lstrip("/") == "Widget"


def _reset_widget(fz: pymupdf.Document, xref: int, field_type: str) -> None:
    """Make one widget show the reset value. A button's ``/AS`` moves to the reset state (its
    ``/V`` or ``/DV``, else Off) when its normal appearance has that state. A text or choice
    widget drops its ``/AP``, which still draws the old text; the catalog's NeedAppearances
    (set by the caller) makes a viewer rebuild it from the reset ``/V``."""
    if field_type == "Btn":
        kind, value = _inherited(fz, xref, "V")
        state = value.lstrip("/") if kind == "name" else "Off"
        if fz.xref_get_key(xref, f"AP/N/{state}")[0] == "null":
            state = "Off"
        fz.xref_set_key(xref, "AS", f"/{state}")
    else:
        fz.xref_set_key(xref, "AP", "null")


def reset_form_values(fz: pymupdf.Document) -> int:
    """Clear the value of every form field, however deep in the field hierarchy it sits.

    MuPDF's ``scrub(reset_fields=True)`` resets widgets only, and on a field whose value lives
    on a parent (the usual layout since PyMuPDF 2.1 writes a text field as a parent with a kid
    widget) it leaves the value in place. So each field's ``/V`` is removed here, or set to its
    ``/DV`` default where it has one, and the widgets under a cleared field are brought in line:
    a button's ``/AS`` follows the new value and a text widget's ``/AP`` is dropped (see
    ``_reset_widget``). Signature fields (``/FT /Sig``, inherited or not) are skipped entirely:
    their ``/V`` is the signature, and clearing it would silently remove the signature.
    Returns how many values were cleared.
    """
    catalog = fz.pdf_catalog()
    kind, value = fz.xref_get_key(catalog, "AcroForm")
    if kind == "xref":
        owner, prefix = int(value.split()[0]), ""
    elif kind == "dict":
        owner, prefix = catalog, "AcroForm/"
    else:
        return 0
    stack = _kids_of(fz, owner, prefix + "Fields")
    seen: set[int] = set()
    cleared_fields: set[int] = set()
    cleared = 0
    while stack:
        xref = stack.pop()
        if xref in seen:
            continue
        seen.add(xref)
        stack.extend(_kids_of(fz, xref, "Kids"))
        field_kind, field_type = _inherited(fz, xref, "FT")
        if field_kind == "name" and field_type.lstrip("/") == "Sig":
            continue
        if fz.xref_get_key(xref, "V")[0] != "null":
            # xref_get_key returns decoded text, so the default is written back as PDF syntax
            default_kind, default = fz.xref_get_key(xref, "DV")
            if default_kind in ("string", "unicode"):
                fz.xref_set_key(xref, "V", pymupdf.get_pdf_str(default))
            elif default_kind == "name":
                fz.xref_set_key(xref, "V", f"/{default.lstrip('/')}")
            else:
                fz.xref_set_key(xref, "V", "null")
            cleared += 1
            cleared_fields.add(xref)
        if _is_widget(fz, xref) and any(n in cleared_fields for n in _chain(fz, xref)):
            _reset_widget(fz, xref, field_type.lstrip("/"))
    if cleared:
        fz.xref_set_key(owner, f"{prefix}NeedAppearances", "true")
    return cleared
