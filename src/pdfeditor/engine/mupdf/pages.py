"""Page operations for the MuPDF backend: insert, delete, reorder, rotate, crop, labels, stamps.

Structural operations go through ``Document.select`` where possible, because it remaps
bookmarks and links; page labels are saved and re-applied since ``select`` drops them.
"""

from __future__ import annotations

import hashlib
import io
import logging
import os
import tempfile
from collections.abc import Sequence
from typing import TYPE_CHECKING

import pymupdf

from pdfeditor.engine.base import EngineError
from pdfeditor.engine.mupdf import content as ct
from pdfeditor.engine.mupdf import space
from pdfeditor.engine.mupdf.marks import marked
from pdfeditor.engine.mupdf.pagecopy import select_with_copies
from pdfeditor.model.fonts import FontRefKind
from pdfeditor.model.geometry import Rect
from pdfeditor.model.pages import ImageStamp, LabelStyle, MarkKind, PageLabelRule, TextStamp

if TYPE_CHECKING:
    from pdfeditor.engine.mupdf.document import MuDocument
    from pdfeditor.engine.mupdf.page import MuPage

logger = logging.getLogger(__name__)


# -- labels -----------------------------------------------------------------------------------
def label_rules(doc: MuDocument) -> list[PageLabelRule]:
    rules = []
    for r in doc.fz.get_page_labels():
        try:
            # MuPDF leaves the style out for a prefix-only rule (no /S), so a missing key is NONE,
            # not DECIMAL: reading it as DECIMAL would turn the rule into numbers on the next save.
            style = LabelStyle(r.get("style", "") or "")
        except ValueError:
            style = LabelStyle.DECIMAL
        rules.append(
            PageLabelRule(
                start=int(r.get("startpage", 0)),
                style=style,
                prefix=r.get("prefix", "") or "",
                first=int(r.get("firstpagenum", 1) or 1),
            )
        )
    return sorted(rules, key=lambda r: r.start)


def set_label_rules(doc: MuDocument, rules: Sequence[PageLabelRule]) -> None:
    count = doc.page_count
    doc.fz.set_page_labels(
        [
            {
                "startpage": r.start,
                "prefix": r.prefix,
                "style": r.style.value,
                "firstpagenum": r.first,
            }
            for r in sorted(rules, key=lambda r: r.start)
            if 0 <= r.start < count
        ]
    )


def page_labels(doc: MuDocument) -> list[str]:
    """Every page's label, read from the catalogue once.

    Built with MuPDF's own ``get_label_pno`` (what ``Page.get_label`` uses), so the web and the
    desktop agree exactly, including MuPDF's alphabetic numbering past Z.
    """
    count = doc.page_count
    try:
        if not hasattr(doc.fz, "_get_page_labels"):  # a PyMuPDF without the private read
            return _page_labels_from_rules(doc, count)
        raw = doc.fz._get_page_labels()
        if not raw:
            return []
        labels = sorted(raw)
        out: list[str] = []
        for index in range(count):
            try:
                out.append(str(pymupdf.utils.get_label_pno(index, labels)))
            except (IndexError, KeyError, ValueError):
                out.append("")  # before the first rule's start page
        return out
    except Exception:
        # Labels are cosmetic: a malformed /PageLabels must not fail the whole page list.
        logger.warning("could not read page labels; showing page numbers", exc_info=True)
        return []


def _page_labels_from_rules(doc: MuDocument, count: int) -> list[str]:
    """The same labels from the public rule dictionaries, for a PyMuPDF without the private read."""
    rules = sorted(doc.fz.get_page_labels(), key=lambda r: int(r.get("startpage", 0)))
    if not rules:
        return []
    out: list[str] = []
    for index in range(count):
        applicable = [r for r in rules if int(r.get("startpage", 0)) <= index]
        if not applicable:
            out.append("")
            continue
        rule = applicable[-1]
        style = str(rule.get("style", "") or "")
        start = int(rule.get("startpage", 0))
        first = int(rule.get("firstpagenum", 1) or 1)
        number = index - start + first - (1 if style in ("a", "A") else 0)
        out.append(pymupdf.utils.construct_label(style, str(rule.get("prefix", "") or ""), number))
    return out


# -- structure --------------------------------------------------------------------------------
def _prune_dangling_outline(doc: MuDocument) -> None:
    """Drop bookmarks whose target page no longer exists (their children move up a level)."""
    toc = doc.fz.get_toc(simple=False)
    if not any(entry[2] < 1 and entry[3].get("kind") == pymupdf.LINK_GOTO for entry in toc):
        return
    out: list[list[object]] = []
    removed_levels: list[int] = []  # levels of removed ancestors on the current path
    for entry in toc:
        level = int(entry[0])
        removed_levels = [lv for lv in removed_levels if lv < level]
        dangling = int(entry[2]) < 1 and entry[3].get("kind") == pymupdf.LINK_GOTO
        if dangling:
            removed_levels.append(level)
            continue
        new_level = max(1, level - len(removed_levels))
        # never deeper than one level below the previous kept item
        new_level = min(new_level, int(out[-1][0]) + 1) if out else 1  # type: ignore[call-overload]
        info = dict(entry[3])
        if info.get("kind") == pymupdf.LINK_GOTO and info.get("to") is not None:
            # get_toc reports the target in visible space; set_toc needs the encoded point.
            target = doc.page(int(entry[2]) - 1).fz
            info["to"] = space.toc_point(target, pymupdf.Point(info["to"]))
        out.append([new_level, entry[1], entry[2], info])
    doc.fz.set_toc(out)


def select(doc: MuDocument, order: Sequence[int]) -> None:
    """Keep exactly ``order`` (indices may repeat, i.e. duplicate pages) in that order.

    Repeats become independent copies, never the same page object twice, and catalog entries
    MuPDF's selection drops (form, language, output intents, ...) are kept.
    """
    count = doc.page_count
    if not order:
        raise EngineError("a document must keep at least one page")
    if any(not 0 <= i < count for i in order):
        raise EngineError("page index out of range")
    rules = label_rules(doc)
    select_with_copies(doc.fz, order)
    doc.structure_changed()
    _prune_dangling_outline(doc)
    if rules:
        set_label_rules(doc, rules)
    doc.structure_changed()


def insert_blank(doc: MuDocument, at: int, width: float, height: float) -> None:
    at = min(max(at, 0), doc.page_count)
    doc.fz.new_page(pno=at if at < doc.page_count else -1, width=width, height=height)
    doc.structure_changed()


def insert_document(doc: MuDocument, source: MuDocument, pages: Sequence[int], at: int) -> None:
    """Copy ``pages`` of ``source`` (with their annotations and links) in before index ``at``."""
    at = min(max(at, 0), doc.page_count)
    for offset, index in enumerate(pages):
        if not 0 <= index < source.page_count:
            raise EngineError(f"source page {index} out of range")
        target = at + offset
        # live count: doc.page_count is refreshed only after the loop (issue #158)
        doc.fz.insert_pdf(
            source.fz,
            from_page=index,
            to_page=index,
            start_at=target if target < doc.fz.page_count else -1,
            annots=True,
            links=True,
        )
    doc.structure_changed()


def insert_image_page(doc: MuDocument, at: int, image: bytes) -> None:
    """A new page showing ``image`` at its native resolution (96 dpi if it has none)."""
    try:
        img = pymupdf.open(stream=image)
        pdf = pymupdf.open("pdf", img.convert_to_pdf())
    except Exception as exc:
        raise EngineError(f"not a supported image: {exc}") from exc
    at = min(max(at, 0), doc.page_count)
    doc.fz.insert_pdf(pdf, start_at=at if at < doc.page_count else -1)
    pdf.close()
    img.close()
    doc.structure_changed()


def set_rotation(page: MuPage, degrees: int) -> None:
    if degrees % 90:
        raise EngineError("page rotation must be a multiple of 90 degrees")
    page.fz.set_rotation(degrees % 360)
    page._doc.structure_changed()  # page size (visible) may swap: views must reload geometry


def set_crop(page: MuPage, rect: Rect) -> None:
    """Crop to ``rect`` given in the current visible space."""
    fz = page.fz
    # Crop input is converted with derotation_matrix on purpose: set_cropbox takes top-left,
    # MediaBox-relative coordinates, which the crop origin added below restores.
    unrot = (pymupdf.Rect(rect.x0, rect.y0, rect.x1, rect.y1) * fz.derotation_matrix).normalize()
    crop = fz.cropbox  # top-left based, relative to the MediaBox
    dx, dy = crop.x0, crop.y0
    new = pymupdf.Rect(unrot.x0 + dx, unrot.y0 + dy, unrot.x1 + dx, unrot.y1 + dy)
    new = new & fz.mediabox
    if new.is_empty or new.width < 1 or new.height < 1:
        raise EngineError("crop rectangle is empty or outside the page")
    fz.set_cropbox(new)
    page._doc.structure_changed()


# -- stamps -----------------------------------------------------------------------------------
def stamp_text(page: MuPage, stamp: TextStamp) -> None:
    fz = page.fz
    # insert_text with morph takes unrotated input and is right with derotation_matrix (checked
    # on rotated, cropped pages), so it keeps that matrix (engine/mupdf/space.py).
    origin = pymupdf.Point(stamp.origin.x, stamp.origin.y) * fz.derotation_matrix
    # morph angle = page rotation + visible counter-clockwise angle (keeps text upright/at angle)
    morph = (origin, pymupdf.Matrix(fz.rotation + stamp.angle))
    ref = stamp.font_ref
    kwargs: dict[str, object] = dict(
        fontsize=stamp.font_size,
        color=stamp.color.rgb(),
        fill_opacity=stamp.opacity,
        stroke_opacity=stamp.opacity,
        morph=morph,
        overlay=stamp.on_top,
    )
    with marked(page, stamp.mark, stamp.origin.y < page.rect.height / 2):
        if ref is not None and ref.kind is FontRefKind.FILE:
            # insert_text() only takes a font file by path, not a buffer: write the (possibly
            # face-extracted) program to a scratch file for the call, then remove it. PyMuPDF
            # reuses a font already on the page under the same resource name, and treats base-14
            # names ("Symbol", "helv") as its built-ins: name it after the file and face, so two
            # faces of a family (or an installed "Symbol") each get their own program.
            buffer = ct.load_file_font(ref.path, ref.index)
            face_id = hashlib.sha1(f"{ref.path}|{ref.index}".encode()).hexdigest()[:10]
            resource_name = f"PEF{face_id}"
            with tempfile.NamedTemporaryFile(suffix=".ttf", delete=False) as tmp:
                tmp.write(buffer)
            try:
                fz.insert_text(
                    origin, stamp.text, fontname=resource_name, fontfile=tmp.name, **kwargs
                )
            finally:
                os.unlink(tmp.name)
            page._doc.note_file_font_embedded()
        else:
            fz.insert_text(origin, stamp.text, fontname=stamp.font, **kwargs)
    page._doc.mark_page_changed(page.index)


def stamp_image(page: MuPage, stamp: ImageStamp) -> None:
    data = stamp.image
    if stamp.opacity < 1:
        data = _with_opacity(data, stamp.opacity)
    fz = page.fz
    rect = (pymupdf.Rect(*stamp.rect.as_tuple()) * space.helper_space(fz)).normalize()
    with marked(page, stamp.mark, stamp.rect.center.y < page.rect.height / 2):
        fz.insert_image(
            rect,
            stream=data,
            keep_proportion=stamp.keep_proportion,
            overlay=stamp.on_top,
            rotate=fz.rotation,  # upright in the visible page
        )
    page._doc.mark_page_changed(page.index)


def _with_opacity(data: bytes, opacity: float) -> bytes:
    from PIL import Image

    img = Image.open(io.BytesIO(data)).convert("RGBA")
    alpha = img.getchannel("A").point(lambda a: int(a * max(0.0, min(1.0, opacity))))
    img.putalpha(alpha)
    out = io.BytesIO()
    img.save(out, format="PNG")
    return out.getvalue()


def fill_background(
    page: MuPage,
    color: tuple[float, float, float],
    opacity: float = 1.0,
    mark: MarkKind | None = None,
) -> None:
    """Paint the whole page behind the existing content."""
    fz = page.fz
    area = (fz.rect * space.helper_space(fz)).normalize()  # the visible page, unrotated coords
    with marked(page, mark):
        fz.draw_rect(area, color=None, fill=color, fill_opacity=opacity, overlay=False)
    page._doc.mark_page_changed(page.index)


_BASE14: dict[str, pymupdf.Font] = {}  # kept for the process: base-14 programs are built in


def text_width(text: str, font: str, size: float) -> float:
    # measure with the font program's Unicode map: ``get_text_length`` encodes the text as
    # WinAnsi first and gets characters outside it wrong ("•" even shortens a line)
    try:
        if font not in _BASE14:
            _BASE14[font] = pymupdf.Font(font)
        return float(_BASE14[font].text_length(text, fontsize=size))
    except Exception:
        return float(pymupdf.get_text_length(text, fontname=font, fontsize=size))
