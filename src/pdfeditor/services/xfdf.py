"""XFDF (ISO 19444-1) import/export of comments.

XFDF uses raw PDF coordinates (origin bottom-left, unrotated). Models use visible page space,
so everything goes through ``Page.pdf_matrix`` and its inverse.
"""

from __future__ import annotations

import math
import uuid
import xml.etree.ElementTree as ET
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime

from pdfeditor.core.commands import AddAnnotationCommand, MacroCommand
from pdfeditor.engine.base import Document
from pdfeditor.model.annotations import (
    AnnotationModel,
    AnnotationType,
    ReviewState,
    is_synthetic_name,
)
from pdfeditor.model.color import Color
from pdfeditor.model.geometry import Matrix, Point, Quad, Rect

NS = "http://ns.adobe.com/xfdf/"
_TAGS = {
    AnnotationType.TEXT: "text",
    AnnotationType.FREE_TEXT: "freetext",
    AnnotationType.LINE: "line",
    AnnotationType.SQUARE: "square",
    AnnotationType.CIRCLE: "circle",
    AnnotationType.POLYGON: "polygon",
    AnnotationType.POLYLINE: "polyline",
    AnnotationType.HIGHLIGHT: "highlight",
    AnnotationType.UNDERLINE: "underline",
    AnnotationType.SQUIGGLY: "squiggly",
    AnnotationType.STRIKEOUT: "strikeout",
    AnnotationType.STAMP: "stamp",
    AnnotationType.INK: "ink",
}
_TYPES = {tag: t for t, tag in _TAGS.items()}

# The largest XFDF text either app imports. Checked before anything is parsed, so a huge file
# costs one length test. The web mirrors this value in web/app/src/commentsImport (S4b).
MAX_XFDF_BYTES = 8 * 1024 * 1024

# Largest magnitude a coordinate may have, in points. A page is at most a few thousand points
# across, so this is generous; it stops values PyMuPDF's point type cannot hold (a 40-digit
# number overflowed it and raised a TypeError during the write, a fuzz crash).
MAX_COORDINATE = 1_000_000.0


class XfdfTooLarge(ValueError):
    """The text is over ``MAX_XFDF_BYTES`` in UTF-8. A ``ValueError``, so callers that only
    catch that still refuse the file; the actions layer catches it first for its own message."""


def check_size(text: str) -> None:
    """Refuse ``text`` when its UTF-8 form is over ``MAX_XFDF_BYTES``.

    A character is at least one byte, so ``len(text)`` over the limit refuses without encoding;
    otherwise the text is encoded once to measure its exact UTF-8 size.
    """
    if len(text) > MAX_XFDF_BYTES or len(text.encode("utf-8")) > MAX_XFDF_BYTES:
        raise XfdfTooLarge(f"XFDF is larger than {MAX_XFDF_BYTES} bytes")


def _n(v: float) -> str:
    text = f"{v:.4f}".rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


def _date(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    base = dt.strftime("D:%Y%m%d%H%M%S")
    offset = dt.utcoffset()
    if offset is None:
        return base
    minutes = int(offset.total_seconds()) // 60
    sign = "+" if minutes >= 0 else "-"
    hh, mm = divmod(abs(minutes), 60)
    return f"{base}{sign}{hh:02d}'{mm:02d}'"


def _parse_date(value: str | None) -> datetime | None:
    if not value:
        return None
    digits = value.removeprefix("D:")[:14]
    try:
        return datetime.strptime(digits.ljust(14, "0"), "%Y%m%d%H%M%S")
    except ValueError:
        return None


# -- export -----------------------------------------------------------------------------------
def _export_names(doc: Document) -> dict[int, str]:
    """The /NM each comment is written with, by object id.

    A comment without a real name (its name is synthetic) gets a per-export name, so the file
    never carries a backend name and replies can still point at their parent.
    """
    out: dict[int, str] = {}
    count = 0
    for index in range(doc.page_count):
        for a in doc.page(index).annotations():
            if a.id is None:
                continue
            if not a.name or is_synthetic_name(a.name):
                count += 1
                out[a.id] = f"pdfeditor-xfdf-{count}"
            else:
                out[a.id] = a.name
    return out


def export_xfdf(doc: Document, file_name: str = "") -> str:
    root = ET.Element("xfdf", {"xmlns": NS, "xml:space": "preserve"})
    annots = ET.SubElement(root, "annots")
    names = _export_names(doc)
    for index in range(doc.page_count):
        page = doc.page(index)
        m = page.pdf_matrix
        models = page.annotations()
        for a in models:
            tag = _TAGS.get(a.type)
            if tag is None or a.id is None:
                continue
            el = ET.SubElement(annots, tag, _common_attrs(a, index, m))
            el.set("name", names[a.id])
            if a.in_reply_to is not None and names.get(a.in_reply_to):
                el.set("inreplyto", names[a.in_reply_to])
            _geometry_out(el, a, m)
            if a.contents:
                ET.SubElement(el, "contents").text = a.contents
    if file_name:
        ET.SubElement(root, "f", {"href": file_name})
    ET.indent(root)
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding="unicode")


def _pdf_rect(r: Rect, m: Matrix) -> str:
    box = r.transform(m)
    return ",".join(_n(v) for v in box.as_tuple())


def _pdf_points(points: Iterable[Point], m: Matrix, sep: str = ",") -> str:
    out = []
    for p in points:
        q = p.transform(m)
        out.append(f"{_n(q.x)},{_n(q.y)}")
    return sep.join(out)


def _common_attrs(a: AnnotationModel, page: int, m: Matrix) -> dict[str, str]:
    attrs = {"page": str(page), "rect": _pdf_rect(a.rect, m), "name": a.name, "flags": _flags(a)}
    if a.author:
        attrs["title"] = a.author
    if a.subject:
        attrs["subject"] = a.subject
    if a.color is not None:
        attrs["color"] = a.color.to_hex().upper()
    if a.fill is not None:
        attrs["interior-color"] = a.fill.to_hex().upper()
    if a.opacity < 1:
        attrs["opacity"] = _n(a.opacity)
    if a.border_width != 1:
        attrs["width"] = _n(a.border_width)
    if (d := _date(a.modified)) is not None:
        attrs["date"] = d
    if (d := _date(a.created)) is not None:
        attrs["creationdate"] = d
    if a.state is not ReviewState.NONE:
        attrs["state"] = a.state.value
        attrs["statemodel"] = "Review"
    if a.type in (AnnotationType.TEXT, AnnotationType.STAMP) and a.icon:
        attrs["icon"] = a.icon.lstrip("#")
    if a.type is AnnotationType.FREE_TEXT:
        attrs["fontsize"] = _n(a.font_size)
    return attrs


def _flags(a: AnnotationModel) -> str:
    names = []
    for bit, name in (
        (2, "hidden"),
        (4, "print"),
        (8, "nozoom"),
        (16, "norotate"),
        (128, "locked"),
    ):
        if a.flags & bit or (bit == 128 and a.locked):
            names.append(name)
    return ",".join(names)


def _geometry_out(el: ET.Element, a: AnnotationModel, m: Matrix) -> None:
    if a.type.is_markup:
        el.set("coords", _pdf_points((p for q in a.quads for p in (q.ul, q.ur, q.ll, q.lr)), m))
    elif a.type is AnnotationType.LINE and len(a.vertices) >= 2:
        el.set("start", _pdf_points([a.vertices[0]], m))
        el.set("end", _pdf_points([a.vertices[1]], m))
        el.set("head", a.line_endings[0])
        el.set("tail", a.line_endings[1])
    elif a.type in (AnnotationType.POLYGON, AnnotationType.POLYLINE):
        ET.SubElement(el, "vertices").text = _pdf_points(a.vertices, m, ";")
    elif a.is_callout:  # XFDF 'callout': the leader line, tip first
        el.set("callout", _pdf_points(a.vertices, m))
        el.set("head", a.line_endings[0])
    elif a.type is AnnotationType.INK:
        inklist = ET.SubElement(el, "inklist")
        for stroke in a.ink:
            ET.SubElement(inklist, "gesture").text = _pdf_points(stroke, m, ";")


# -- import -----------------------------------------------------------------------------------
def parse_xfdf(text: str, doc: Document) -> list[AnnotationModel]:
    """Parse XFDF into models in visible space. Replies carry ``extra["irt_name"]``.

    Raises ``XfdfTooLarge`` for text over ``MAX_XFDF_BYTES`` (before anything else runs),
    ``ValueError`` for input that is not XFDF, and ``ET.ParseError`` for malformed XML.
    A DOCTYPE or ENTITY declaration is refused outright: XFDF never needs one, and entity
    declarations are the usual vehicle for XML amplification attacks.
    """
    check_size(text)
    lowered = text.lower()
    if "<!doctype" in lowered or "<!entity" in lowered:
        raise ValueError("not XFDF: DOCTYPE and ENTITY declarations are not allowed")
    root = ET.fromstring(text)
    if root.tag.split("}")[-1] != "xfdf":
        raise ValueError("not XFDF: the root element is not xfdf")
    annots = root.find(f"{{{NS}}}annots")
    if annots is None:
        annots = root.find("annots")
    if annots is None:
        return []
    out: list[AnnotationModel] = []
    for el in annots:
        tag = el.tag.split("}")[-1]
        atype = _TYPES.get(tag)
        if atype is None:
            continue
        page_index = int(el.get("page", "0"))
        if not 0 <= page_index < doc.page_count:
            continue
        inverse = doc.page(page_index).pdf_matrix.inverted()
        model = AnnotationModel(atype, page_index, _rect_in(el.get("rect", "0,0,0,0"), inverse))
        model.name = el.get("name", "")
        model.author = el.get("title", "")
        model.subject = el.get("subject", "")
        model.color = _color(el.get("color"))
        model.fill = _color(el.get("interior-color"))
        model.opacity = float(el.get("opacity", "1"))
        model.border_width = float(el.get("width", "1"))
        model.modified = _parse_date(el.get("date"))
        model.created = _parse_date(el.get("creationdate"))
        model.icon = el.get("icon", "")
        model.font_size = float(el.get("fontsize", "11"))
        flags = el.get("flags", "")
        model.locked = "locked" in flags
        if el.get("state"):
            try:
                model.state = ReviewState(el.get("state", "None"))
            except ValueError:
                model.state = ReviewState.NONE
        if el.get("inreplyto"):
            model.extra = {"irt_name": el.get("inreplyto", "")}
        contents = el.find(f"{{{NS}}}contents")
        if contents is None:
            contents = el.find("contents")
        model.contents = (contents.text or "") if contents is not None else ""
        _geometry_in(el, model, inverse)
        out.append(model)
    return out


@dataclass(frozen=True, slots=True)
class XfdfPreview:
    """What importing a file would add. ``comments`` counts every comment, replies included,
    so it equals the number ``import_command`` adds for the same document; ``replies`` is the
    part of it that answers another comment. ``pages`` are the 0-based pages, ascending."""

    comments: int
    replies: int
    pages: tuple[int, ...]


def preview_xfdf(text: str, doc: Document) -> XfdfPreview:
    """Count what :func:`import_command` would add, without changing the document.

    Uses :func:`parse_xfdf` itself, so the rules (size, DOCTYPE, unknown tags, pages out of
    range) are the import's rules and the counts cannot drift from it.
    """
    models = parse_xfdf(text, doc)
    replies = sum(1 for m in models if m.extra.get("irt_name"))
    pages = tuple(sorted({m.page_index for m in models}))
    return XfdfPreview(comments=len(models), replies=replies, pages=pages)


def import_command(text: str, doc: Document) -> MacroCommand:
    """One undoable step that adds every comment in ``text`` (parents before replies).

    A name that is synthetic, empty or already in the document gets a fresh one, and the replies
    that point at a renamed comment are pointed at its new name.
    """
    models = parse_xfdf(text, doc)
    models.sort(key=lambda m: bool(m.extra.get("irt_name")))
    existing = {a.name for i in range(doc.page_count) for a in doc.page(i).annotations()}
    renamed: dict[str, str] = {}
    for model in models:
        old = model.name
        if not old or is_synthetic_name(old) or old in existing:
            model.name = f"pdfeditor-{uuid.uuid4().hex}"
        if old:
            renamed.setdefault(old, model.name)
        existing.add(model.name)
    for model in models:
        irt = model.extra.get("irt_name")
        if irt:
            model.extra = {**model.extra, "irt_name": renamed.get(irt, irt)}
    commands = [AddAnnotationCommand(model) for model in models]
    return MacroCommand(f"Import {len(commands)} Comments", list(commands))


def _coordinate(text: str) -> float:
    """One numeric coordinate, refused unless it is finite and within ``MAX_COORDINATE``.

    Refusing here, at parse time, means an out-of-range value never reaches the engine. It is a
    ``ValueError``, which both the service and the actions layer turn into a clean refusal.
    """
    value = float(text)
    if not math.isfinite(value) or abs(value) > MAX_COORDINATE:
        raise ValueError(
            f"not XFDF: a coordinate is out of range (finite, at most {MAX_COORDINATE:g} points)"
        )
    return value


def _pairs(text: str) -> list[Point]:
    nums = [_coordinate(v) for v in text.replace(";", ",").split(",") if v.strip()]
    return [Point(nums[i], nums[i + 1]) for i in range(0, len(nums) - 1, 2)]


def _rect_in(text: str, inverse: Matrix) -> Rect:
    x0, y0, x1, y1 = (_coordinate(v) for v in text.split(","))
    return Rect(x0, y0, x1, y1).normalized().transform(inverse)


def _color(value: str | None) -> Color | None:
    if not value:
        return None
    try:
        return Color.from_hex(value)
    except ValueError:
        return None


def _geometry_in(el: ET.Element, model: AnnotationModel, inverse: Matrix) -> None:
    def find(name: str) -> ET.Element | None:
        found = el.find(f"{{{NS}}}{name}")
        return found if found is not None else el.find(name)

    if model.type.is_markup:
        pts = [p.transform(inverse) for p in _pairs(el.get("coords", ""))]
        model.quads = tuple(Quad(*pts[i : i + 4]) for i in range(0, len(pts) - 3, 4))
    elif model.type is AnnotationType.LINE:
        start = _pairs(el.get("start", "0,0"))[0].transform(inverse)
        end = _pairs(el.get("end", "0,0"))[0].transform(inverse)
        model.vertices = (start, end)
        model.line_endings = (el.get("head", "None"), el.get("tail", "None"))
    elif model.type is AnnotationType.FREE_TEXT and el.get("callout"):
        model.vertices = tuple(p.transform(inverse) for p in _pairs(el.get("callout", "")))
        model.line_endings = (el.get("head", "None"), "None")
    elif model.type in (AnnotationType.POLYGON, AnnotationType.POLYLINE):
        vertices = find("vertices")
        if vertices is not None and vertices.text:
            model.vertices = tuple(p.transform(inverse) for p in _pairs(vertices.text))
    elif model.type is AnnotationType.INK:
        inklist = find("inklist")
        strokes = []
        if inklist is not None:
            for gesture in inklist:
                if gesture.text:
                    strokes.append(tuple(p.transform(inverse) for p in _pairs(gesture.text)))
        model.ink = tuple(strokes)
