"""Writes on rotated and cropped pages (issue #537).

The fixture ``rotated_cropped`` has pages 0-3 with a crop box that starts off the origin, pages
4-7 with a MediaBox that starts off the origin and no crop box, all at /Rotate 0, 90, 180 and 270,
and page 8 with a crop box at (0, 0) at /Rotate 270. Every write must land where it was asked.
pypdfium2 renders the saved file (it applies /Rotate and the crop box itself), pikepdf reads the
raw PDF objects, and the expected PDF points come from PyMuPDF's boxes, not from the engine.
"""

from __future__ import annotations

import io
import re
import shutil
from dataclasses import replace
from pathlib import Path

import pymupdf
import pytest

from pdfeditor.engine.base import Engine, SaveOptions
from pdfeditor.model.annotations import AnnotationModel, AnnotationType
from pdfeditor.model.color import Color
from pdfeditor.model.geometry import Point, Rect
from pdfeditor.model.objects import TextStyle
from pdfeditor.model.outline import Destination, OutlineItem
from pdfeditor.model.pages import ImageStamp, TextStamp
from pdfeditor.model.redaction import RedactOptions
from tests.hostcheck import record

RED = Color(1, 0, 0)
CROPPED = tuple(range(8))  # pages 0-7: every box layout and rotation
ALL = tuple(range(9))  # plus page 8: crop at (0, 0), /Rotate 270


def _open(engine: Engine, fixture_pdf, tmp_path: Path, name: str = "rotated_cropped"):
    path = tmp_path / f"{name}.pdf"
    shutil.copy2(fixture_pdf(name), path)
    return engine.open(path), path


def _pdf_point(page: pymupdf.Page, x: float, y: float) -> tuple[float, float]:
    """A visible point in PDF user space, from PyMuPDF's unrotated coordinates.

    Unrotated coordinates run from the crop box's top-left corner; the PDF top edge of the crop
    box is the MediaBox top minus the crop box's top-left y.
    """
    u = pymupdf.Point(x, y) * page.derotation_matrix
    crop, media = page.cropbox, page.mediabox
    return (crop.x0 + u.x, media.y1 - crop.y0 - u.y)


def _text_box(doc: Engine, page_index: int, needle: str) -> Rect:
    hits = doc.page(page_index).search(needle)
    assert hits, needle
    box = hits[0].rect
    for q in hits[1:]:
        box = box.union(q.rect)
    return box


def _png(rgb: tuple[int, int, int]) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (64, 64), rgb).save(buf, format="PNG")
    return buf.getvalue()


def _raw_outline_xy(path: Path) -> dict[str, tuple[float, float]]:
    """Title -> raw (x, y) of each bookmark's /XYZ destination, read with PyMuPDF's raw keys."""
    doc = pymupdf.open(path)
    out: dict[str, tuple[float, float]] = {}
    try:
        for xref in doc.get_outline_xrefs():
            title = doc.xref_get_key(xref, "Title")[1].strip("()")
            dest = doc.xref_get_key(xref, "A/D")  # MuPDF writes a GoTo action
            if dest[0] != "array":
                continue
            numbers = [float(v) for v in re.findall(r"-?\d+(?:\.\d+)?", dest[1].split("/XYZ")[1])]
            out[title] = (numbers[0], numbers[1])
    finally:
        doc.close()
    return out


def _set_bookmarks(engine: Engine, fixture_pdf, tmp_path: Path) -> tuple[Engine, Path]:
    doc, path = _open(engine, fixture_pdf, tmp_path)
    items = [OutlineItem(f"P{i}", dest=Destination(i, Point(100, 200))) for i in ALL]
    doc.set_outline(items)
    doc.save()
    doc.close()
    return engine, path


# -- where a write lands ------------------------------------------------------------------------


@pytest.mark.parametrize("page_index", ALL)
def test_pdf_matrix_maps_visible_corners_to_the_crop_box(
    engine: Engine, fixture_pdf, page_index: int
) -> None:
    doc = engine.open(fixture_pdf("rotated_cropped"))
    page = doc.page(page_index)
    fz = pymupdf.open(fixture_pdf("rotated_cropped"))[page_index]
    w, h = page.rect.width, page.rect.height
    for vx, vy in ((0, 0), (w, h)):
        got = Point(vx, vy).transform(page.pdf_matrix)
        want = _pdf_point(fz, vx, vy)
        assert (got.x, got.y) == pytest.approx(want, abs=1e-6)
    doc.close()


@pytest.mark.parametrize("page_index", CROPPED)
def test_square_and_circle_create_and_move(
    engine: Engine, fixture_pdf, tmp_path: Path, page_index: int
) -> None:
    doc, path = _open(engine, fixture_pdf, tmp_path)
    page = doc.page(page_index)
    box = Rect(100, 100, 200, 160)
    square = page.add_annotation(
        AnnotationModel(AnnotationType.SQUARE, page_index, box, color=RED, fill=RED)
    )
    circle = page.add_annotation(
        AnnotationModel(
            AnnotationType.CIRCLE, page_index, Rect(300, 400, 360, 460), color=RED, fill=RED
        )
    )
    moved = page.update_annotation(replace(square, rect=Rect(120, 120, 220, 180)))
    assert moved.rect.x0 == pytest.approx(120, abs=1)
    doc.save()
    doc.close()
    # The circle (300-360, 400-460) is in the same file, so the red pixels span both shapes.
    record("red_bbox_pdfium", path, page=page_index, expected=[120, 120, 360, 460], tol=3)
    again = engine.open(path)
    names = {a.name: a.rect for a in again.page(page_index).annotations()}
    assert names[square.name].x0 == pytest.approx(120, abs=1)
    assert names[circle.name].x1 == pytest.approx(360, abs=1)
    again.close()


@pytest.mark.parametrize("page_index", CROPPED)
def test_ink_update_lands_where_requested(
    engine: Engine, fixture_pdf, tmp_path: Path, page_index: int
) -> None:
    doc, path = _open(engine, fixture_pdf, tmp_path)
    page = doc.page(page_index)
    ink = page.add_annotation(
        AnnotationModel(
            AnnotationType.INK,
            page_index,
            Rect(0, 0, 0, 0),
            color=RED,
            border_width=2,
            ink=((Point(350, 300), Point(380, 340), Point(420, 310)),),
        )
    )
    moved = page.update_annotation(
        replace(ink, ink=((Point(450, 300), Point(480, 340), Point(520, 310)),))
    )
    assert moved.ink[0][0].x == pytest.approx(450, abs=1)
    doc.save()
    doc.close()
    record("red_bbox_pdfium", path, page=page_index, expected=[449, 299, 521, 341], tol=3)


# -- redaction leak (the text must go) ----------------------------------------------------------


@pytest.mark.parametrize("page_index", ALL)
def test_redaction_removes_multi_line_text_on_rotated_cropped_pages(
    engine: Engine, fixture_pdf, tmp_path: Path, page_index: int
) -> None:
    """A two-line mark over SECRETONE and SECRETTWO removes both words, and only them."""
    if not engine.capabilities.redact:
        pytest.skip("engine can't redact")
    doc, path = _open(engine, fixture_pdf, tmp_path)
    page = doc.page(page_index)
    one = page.search("SECRETONE")[0]
    two = page.search("SECRETTWO")[0]
    page.add_annotation(
        AnnotationModel(
            AnnotationType.REDACT,
            page_index,
            one.rect.union(two.rect),
            quads=(one, two),
            fill=Color(0, 0, 0),
        )
    )
    assert page.apply_redactions(None, RedactOptions()) == 1
    doc.save(options=SaveOptions(garbage=4))
    doc.close()
    record("text_lacks_pdfium", path, page=page_index, text="SECRETONE")
    record("text_lacks_pdfium", path, page=page_index, text="SECRETTWO")
    record("text_contains_pdfium", path, page=page_index, text="Anchor")


# -- content, stamps, background and OCR text ---------------------------------------------------


@pytest.mark.parametrize("page_index", ALL)
def test_text_added_on_rotated_cropped_page_is_where_requested(
    engine: Engine, fixture_pdf, tmp_path: Path, page_index: int
) -> None:
    doc, path = _open(engine, fixture_pdf, tmp_path)
    page = doc.page(page_index)
    page.add_text(Rect(100, 100, 300, 160), "Hello", TextStyle(size=20, color=RED))
    doc.save()
    doc.close()
    record("text_contains_pdfium", path, page=page_index, text="Hello")
    again = engine.open(path)
    box = _text_box(again, page_index, "Hello")
    assert box.x0 == pytest.approx(100, abs=3)
    assert 100 <= (box.y0 + box.y1) / 2 <= 160  # the text sits inside its box
    again.close()


@pytest.mark.parametrize("page_index", ALL)
def test_image_stamp_on_rotated_cropped_page_is_where_requested(
    engine: Engine, fixture_pdf, tmp_path: Path, page_index: int
) -> None:
    doc, path = _open(engine, fixture_pdf, tmp_path)
    doc.page(page_index).stamp_image(
        ImageStamp(_png((255, 0, 0)), Rect(100, 100, 200, 160), keep_proportion=False)
    )
    doc.save()
    doc.close()
    record("red_bbox_pdfium", path, page=page_index, expected=[100, 100, 200, 160], tol=2)


@pytest.mark.parametrize("page_index", ALL)
def test_text_stamp_on_rotated_cropped_page_is_where_requested(
    engine: Engine, fixture_pdf, tmp_path: Path, page_index: int
) -> None:
    """Guard for the path that was already right: insert_text with morph."""
    doc, path = _open(engine, fixture_pdf, tmp_path)
    doc.page(page_index).stamp_text(TextStamp("Stamp", Point(100, 200), font_size=20, color=RED))
    doc.save()
    doc.close()
    record("text_contains_pdfium", path, page=page_index, text="Stamp")
    again = engine.open(path)
    box = _text_box(again, page_index, "Stamp")
    assert box.x0 == pytest.approx(100, abs=2) and box.y0 < 200 < box.y1
    again.close()


@pytest.mark.parametrize("page_index", ALL)
def test_background_covers_the_visible_rotated_cropped_page(
    engine: Engine, fixture_pdf, tmp_path: Path, page_index: int
) -> None:
    doc, path = _open(engine, fixture_pdf, tmp_path)
    page = doc.page(page_index)
    w, h = page.rect.width, page.rect.height
    page.fill_background(RED)
    doc.save()
    doc.close()
    record("red_bbox_pdfium", path, page=page_index, expected=[0, 0, w, h], tol=2)


@pytest.mark.parametrize("page_index", ALL)
def test_ocr_text_layer_is_placed_over_the_scan(
    engine: Engine, fixture_pdf, tmp_path: Path, page_index: int
) -> None:
    """A text-only layer in visible orientation: its word is found at the same place."""
    doc, path = _open(engine, fixture_pdf, tmp_path)
    page = doc.page(page_index)
    w, h = page.rect.width, page.rect.height
    layer = pymupdf.open()
    lp = layer.new_page(width=w, height=h)
    lp.insert_text((100, 200), "hiddenword", fontsize=20, render_mode=3)
    want = lp.search_for("hiddenword")[0]
    layer_bytes = layer.tobytes()
    layer.close()
    page.add_text_layer(layer_bytes)
    doc.save()
    doc.close()
    again = engine.open(path)
    got = again.page(page_index).search("hiddenword")[0].rect
    assert got.x0 == pytest.approx(want.x0, abs=1)
    assert got.y0 == pytest.approx(want.y0, abs=1)
    again.close()


# -- bookmarks ----------------------------------------------------------------------------------


@pytest.mark.parametrize("page_index", ALL)
def test_bookmark_destination_is_where_it_was_set(
    engine: Engine, fixture_pdf, tmp_path: Path, page_index: int
) -> None:
    doc, path = _open(engine, fixture_pdf, tmp_path)
    doc.set_outline([OutlineItem("Target", dest=Destination(page_index, Point(100, 200)))])
    doc.save()
    doc.close()
    check = pymupdf.open(path)
    left, top = _pdf_point(check[page_index], 100, 200)
    check.close()
    record("outline_dest_pikepdf", path, index=0, page=page_index, left=left, top=top)
    again = engine.open(path)
    point = again.outline()[0].dest.point
    assert point is not None and point.x == pytest.approx(100, abs=0.5)
    assert point.y == pytest.approx(200, abs=0.5)
    again.close()


def test_rewriting_the_outline_keeps_every_raw_destination(
    engine: Engine, fixture_pdf, tmp_path: Path
) -> None:
    """set_outline(outline()) on a correct file changes no /XYZ value (drift guard)."""
    _, path = _set_bookmarks(engine, fixture_pdf, tmp_path)
    before = _raw_outline_xy(path)
    doc = engine.open(path)
    doc.set_outline(doc.outline())
    doc.save()
    doc.close()
    after = _raw_outline_xy(path)
    assert len(before) == len(ALL) and after.keys() == before.keys()
    for title, xy in after.items():
        assert xy == pytest.approx(before[title], abs=1e-3), title


def test_deleting_a_bookmarked_page_keeps_the_other_destinations(
    engine: Engine, fixture_pdf, tmp_path: Path
) -> None:
    """The dangling-entry prune rewrites the outline; the surviving /XYZ values stay put."""
    _, path = _set_bookmarks(engine, fixture_pdf, tmp_path)
    before = _raw_outline_xy(path)
    doc = engine.open(path)
    doc.select_pages([i for i in ALL if i != 4])
    doc.save()
    doc.close()
    after = _raw_outline_xy(path)
    assert "P4" not in after and len(after) == len(ALL) - 1
    for title, xy in after.items():
        assert xy == pytest.approx(before[title], abs=1e-3), title
