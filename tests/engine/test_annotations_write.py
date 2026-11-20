"""Contract tests for annotation writing (capability ``annotations_write``)."""

from __future__ import annotations

import dataclasses
import shutil
from pathlib import Path

import numpy as np
import pytest

from pdfeditor.engine.base import ColorMode, Engine, EngineError, RenderRequest
from pdfeditor.model.annotations import (
    AnnotationModel,
    AnnotationType,
    ReviewState,
    is_synthetic_name,
)
from pdfeditor.model.color import Color
from pdfeditor.model.geometry import Point, Quad, Rect
from tests.hostcheck import record

RED = Color(1, 0, 0)
BLUE = Color(0, 0, 1)


@pytest.fixture
def writable(engine: Engine) -> Engine:
    if not engine.capabilities.annotations_write:
        pytest.skip("engine can't write annotations")
    return engine


def _ink_bbox(page, request: RenderRequest | None = None) -> Rect | None:
    """Bounding box (page space at scale 1) of clearly colored pixels."""
    img = page.render(request or RenderRequest(color=ColorMode.RGB))
    arr = np.frombuffer(img.samples, dtype=np.uint8).reshape(img.height, img.stride)
    rgb = arr[:, : img.width * 3].reshape(img.height, img.width, 3).astype(int)
    colored = (np.abs(rgb[:, :, 0] - rgb[:, :, 2]) > 80) | (
        np.abs(rgb[:, :, 1] - rgb[:, :, 2]) > 80
    )
    ys, xs = np.nonzero(colored)
    if len(xs) == 0:
        return None
    return Rect(float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max()))


def _models(page_rect: Rect) -> list[AnnotationModel]:
    r = Rect(100, 150, 220, 230)
    pts = (Point(100, 300), Point(180, 260), Point(240, 330))
    return [
        AnnotationModel(
            AnnotationType.TEXT, 0, Rect(300, 100, 320, 120), contents="note", color=Color(1, 1, 0)
        ),
        AnnotationModel(
            AnnotationType.FREE_TEXT,
            0,
            Rect(300, 150, 500, 190),
            contents="Free",
            color=RED,
            font_size=14,
            text_color=RED,
        ),
        AnnotationModel(AnnotationType.SQUARE, 0, r, color=RED, fill=Color(1, 0.8, 0.8)),
        AnnotationModel(AnnotationType.CIRCLE, 0, r.translated(250, 200), color=BLUE),
        AnnotationModel(
            AnnotationType.LINE,
            0,
            Rect(0, 0, 0, 0),
            color=RED,
            vertices=(Point(100, 400), Point(300, 420)),
            line_endings=("None", "ClosedArrow"),
        ),
        AnnotationModel(AnnotationType.POLYGON, 0, Rect(0, 0, 0, 0), color=BLUE, vertices=pts),
        AnnotationModel(
            AnnotationType.POLYLINE,
            0,
            Rect(0, 0, 0, 0),
            color=RED,
            vertices=tuple(p + Point(0, 150) for p in pts),
        ),
        AnnotationModel(
            AnnotationType.INK,
            0,
            Rect(0, 0, 0, 0),
            color=BLUE,
            border_width=2,
            ink=((Point(350, 300), Point(380, 340), Point(420, 310)),),
        ),
        AnnotationModel(
            AnnotationType.HIGHLIGHT,
            0,
            Rect(0, 0, 0, 0),
            color=Color(1, 1, 0),
            quads=(Quad.from_rect(Rect(100, 600, 250, 615)),),
        ),
        AnnotationModel(
            AnnotationType.STRIKEOUT,
            0,
            Rect(0, 0, 0, 0),
            color=RED,
            quads=(Quad.from_rect(Rect(100, 630, 250, 645)),),
        ),
        AnnotationModel(AnnotationType.STAMP, 0, Rect(350, 600, 500, 650), icon="Approved"),
    ]


def _open(engine: Engine, fixture_pdf, tmp_path: Path, name: str = "text_multipage"):
    path = tmp_path / f"{name}.pdf"
    shutil.copy2(fixture_pdf(name), path)
    return engine.open(path), path


@pytest.mark.parametrize("page_index", [0, 1], ids=["upright", "rotated90"])
def test_create_every_type_roundtrip(
    writable: Engine, fixture_pdf, tmp_path: Path, page_index: int
) -> None:
    doc, path = _open(writable, fixture_pdf, tmp_path, "rotated_pages")
    page = doc.page(page_index)
    created = []
    for model in _models(page.rect):
        model.page_index = page_index
        model.author = "Tester"
        stored = page.add_annotation(model)
        assert stored.id is not None and stored.name
        assert stored.type is model.type and stored.author == "Tester"
        created.append(stored)
    # geometry comes back in visible space
    by_type = {a.type: a for a in page.annotations()}
    assert by_type[AnnotationType.SQUARE].rect.intersects(Rect(100, 150, 220, 230))
    line = by_type[AnnotationType.LINE]
    assert line.vertices[0].x == pytest.approx(100, abs=1) and line.vertices[1].y == pytest.approx(
        420, abs=1
    )
    assert line.line_endings == ("None", "ClosedArrow")
    hl = by_type[AnnotationType.HIGHLIGHT]
    assert hl.quads[0].rect.x0 == pytest.approx(100, abs=1)
    assert by_type[AnnotationType.INK].ink[0][0].x == pytest.approx(350, abs=1)
    assert by_type[AnnotationType.STAMP].icon.endswith("Approved")
    # the square is drawn where the model says, in visible space
    bbox = _ink_bbox(page, RenderRequest(color=ColorMode.RGB, clip=Rect(90, 140, 230, 240)))
    assert bbox is not None
    doc.save()
    doc.close()

    record("annot_count_pikepdf", path, page=page_index, minimum=len(created))
    record("page_count_pdfium", path, pages=5)
    again = writable.open(path)
    names = {a.name for a in again.page(page_index).annotations()}
    assert {c.name for c in created} <= names
    again.close()


def test_update_moves_and_restyles(writable: Engine, fixture_pdf, tmp_path: Path) -> None:
    doc, _ = _open(writable, fixture_pdf, tmp_path)
    page = doc.page(0)
    sq = page.add_annotation(
        AnnotationModel(AnnotationType.SQUARE, 0, Rect(100, 300, 200, 400), color=RED)
    )
    sq.rect = Rect(300, 500, 380, 560)
    sq.color = BLUE
    sq.contents = "moved"
    sq.opacity = 0.5
    updated = page.update_annotation(sq)
    assert updated.rect.intersects(Rect(300, 500, 380, 560)) and not updated.rect.intersects(
        Rect(100, 300, 200, 400)
    )
    assert (
        updated.color == BLUE
        and updated.contents == "moved"
        and updated.opacity == pytest.approx(0.5)
    )

    ink = page.add_annotation(
        AnnotationModel(
            AnnotationType.INK,
            0,
            Rect(0, 0, 0, 0),
            color=RED,
            ink=((Point(100, 100), Point(150, 150)),),
        )
    )
    ink.ink = ((Point(200, 200), Point(260, 250)),)
    moved = page.update_annotation(ink)
    assert moved.ink[0][0].x == pytest.approx(200, abs=1)
    assert moved.rect.x0 >= 190  # rect recomputed from the new points

    hl = page.add_annotation(
        AnnotationModel(
            AnnotationType.HIGHLIGHT,
            0,
            Rect(0, 0, 0, 0),
            color=Color(1, 1, 0),
            quads=(Quad.from_rect(Rect(100, 700, 200, 712)),),
        )
    )
    hl.quads = (Quad.from_rect(Rect(300, 700, 400, 712)),)
    assert page.update_annotation(hl).quads[0].rect.x0 == pytest.approx(300, abs=1)
    doc.close()


def test_reply_state_and_lock(writable: Engine, fixture_pdf, tmp_path: Path) -> None:
    doc, path = _open(writable, fixture_pdf, tmp_path)
    page = doc.page(0)
    parent = page.add_annotation(
        AnnotationModel(AnnotationType.TEXT, 0, Rect(50, 50, 70, 70), contents="Question?")
    )
    reply = page.add_annotation(
        AnnotationModel(
            AnnotationType.TEXT,
            0,
            parent.rect,
            contents="Answer",
            in_reply_to=parent.id,
            state=ReviewState.ACCEPTED,
        )
    )
    assert reply.in_reply_to == parent.id and reply.state is ReviewState.ACCEPTED
    parent.locked = True
    assert page.update_annotation(parent).locked
    doc.save()
    doc.close()
    again = writable.open(path)
    replies = [a for a in again.page(0).annotations() if a.in_reply_to is not None]
    assert replies and replies[0].contents == "Answer"
    again.close()


def test_delete_and_order(writable: Engine, fixture_pdf, tmp_path: Path) -> None:
    doc, _ = _open(writable, fixture_pdf, tmp_path)
    page = doc.page(0)
    a = page.add_annotation(
        AnnotationModel(AnnotationType.SQUARE, 0, Rect(100, 100, 200, 200), color=RED, fill=RED)
    )
    b = page.add_annotation(
        AnnotationModel(AnnotationType.SQUARE, 0, Rect(150, 150, 250, 250), color=BLUE, fill=BLUE)
    )
    assert page.annotation_order() == [a.id, b.id]
    probe = RenderRequest(color=ColorMode.RGB, clip=Rect(170, 170, 175, 175))
    assert page.render(probe).samples[2] > 200  # blue on top
    page.set_annotation_order([b.id, a.id])
    assert page.annotation_order() == [b.id, a.id]
    assert page.render(probe).samples[0] > 200  # red on top now
    with pytest.raises(EngineError):
        page.set_annotation_order([a.id])
    page.delete_annotation(a.id)
    assert [x.id for x in page.annotations()] == [b.id]
    page.delete_annotation(None, name=b.name)
    assert page.annotations() == []
    with pytest.raises(EngineError):
        page.delete_annotation(12345)
    doc.close()


@pytest.mark.parametrize("fixture", ["annotations", "rotated_pages"])
def test_flatten_preserves_appearance(
    writable: Engine, fixture_pdf, tmp_path: Path, fixture: str
) -> None:
    if not writable.capabilities.annotations_flatten:
        pytest.skip("engine can't flatten")
    doc, path = _open(writable, fixture_pdf, tmp_path, fixture)
    page = doc.page(0 if fixture == "annotations" else 1)
    if fixture == "rotated_pages":
        page.add_annotation(
            AnnotationModel(
                AnnotationType.SQUARE,
                1,
                Rect(100, 100, 300, 200),
                color=RED,
                fill=Color(1, 0.8, 0.8),
            )
        )
        page.add_annotation(
            AnnotationModel(
                AnnotationType.HIGHLIGHT,
                1,
                Rect(0, 0, 0, 0),
                color=Color(1, 1, 0),
                quads=(Quad.from_rect(Rect(50, 300, 400, 320)),),
            )
        )
    before = page.render(RenderRequest(color=ColorMode.RGB)).samples
    visible = [
        a for a in page.annotations() if a.type not in (AnnotationType.POPUP,) and not a.flags & 2
    ]
    count = page.flatten_annotations()
    assert count == len(visible)
    assert [a for a in page.annotations() if a.type is not AnnotationType.POPUP] == []
    after = page.render(RenderRequest(color=ColorMode.RGB, annotations=False)).samples
    diff = np.abs(
        np.frombuffer(before, np.uint8).astype(int) - np.frombuffer(after, np.uint8).astype(int)
    )
    assert diff.mean() < 1.0 and (diff > 80).mean() < 0.002
    doc.save()
    doc.close()
    again = writable.open(path)
    index = 0 if fixture == "annotations" else 1
    left = [a for a in again.page(index).annotations() if a.type is not AnnotationType.POPUP]
    assert left == []
    after_reopen = again.page(index).render(RenderRequest(color=ColorMode.RGB)).samples
    assert (
        np.abs(
            np.frombuffer(after_reopen, np.uint8).astype(int)
            - np.frombuffer(before, np.uint8).astype(int)
        ).mean()
        < 1.0
    )
    again.close()


def test_flatten_selected_only(writable: Engine, fixture_pdf, tmp_path: Path) -> None:
    doc, _ = _open(writable, fixture_pdf, tmp_path)
    page = doc.page(0)
    keep = page.add_annotation(
        AnnotationModel(AnnotationType.SQUARE, 0, Rect(100, 100, 150, 150), color=RED)
    )
    burn = page.add_annotation(
        AnnotationModel(AnnotationType.SQUARE, 0, Rect(300, 300, 350, 350), color=BLUE)
    )
    assert page.flatten_annotations([burn.id]) == 1
    assert [a.id for a in page.annotations()] == [keep.id]
    blue = _ink_bbox(
        page, RenderRequest(color=ColorMode.RGB, annotations=False, clip=Rect(290, 290, 360, 360))
    )
    assert blue is not None  # now part of the page content
    doc.close()


def test_file_attachment_annotation(writable: Engine, fixture_pdf, tmp_path: Path) -> None:
    doc, path = _open(writable, fixture_pdf, tmp_path)
    page = doc.page(0)
    att = page.add_annotation(
        AnnotationModel(
            AnnotationType.FILE_ATTACHMENT,
            0,
            Rect(500, 50, 520, 70),
            contents="data file",
            file_name="data.csv",
            file_data=b"a,b\n1,2\n",
        )
    )
    assert att.type is AnnotationType.FILE_ATTACHMENT
    doc.save()
    doc.close()
    record("attachment_bytes_pikepdf", path, expected="a,b\n1,2\n")


def test_pdf_matrix_maps_to_pdf_space(engine: Engine, fixture_pdf) -> None:
    doc = engine.open(fixture_pdf("rotated_pages"))
    upright, rotated = doc.page(0), doc.page(1)
    top_left = Point(0, 0).transform(upright.pdf_matrix)
    assert top_left.y == pytest.approx(upright.boxes.crop.height)  # PDF origin is bottom-left
    # rotated 90: visible top-left is the PDF bottom-left corner... of the rotated page
    p = Point(0, 0).transform(rotated.pdf_matrix)
    q = Point(rotated.rect.width, rotated.rect.height).transform(rotated.pdf_matrix)
    assert {round(p.x), round(q.x)} == {0, 595} and {round(p.y), round(q.y)} == {0, 842}
    doc.close()


# -- comments without /NM (issue #168) ------------------------------------------------------
# The fixture ``annotations_unnamed`` has three comments on page 0 (two squares, a note) and a
# redaction mark on page 1, none with a /NM. Every one must still be addressable by a name that
# is non-empty, distinct and stable while the document is open.


def _unnamed(engine: Engine, fixture_pdf, tmp_path: Path):
    doc, path = _open(engine, fixture_pdf, tmp_path, "annotations_unnamed")
    return doc, path


def test_unnamed_annotations_read_back_distinct_stable_names(engine: Engine, fixture_pdf) -> None:
    doc = engine.open(fixture_pdf("annotations_unnamed"))
    first = [a.name for a in doc.page(0).annotations()]
    assert len(first) == 3 and all(first)
    assert len(set(first)) == 3
    assert [a.name for a in doc.page(0).annotations()] == first  # stable across reads
    assert [a.name for a in doc.page(1).annotations()] != [""]
    assert all(a.name for a in doc.page(1).annotations())
    doc.close()


def test_update_of_an_unnamed_annotation_changes_only_that_one(
    writable: Engine, fixture_pdf, tmp_path: Path
) -> None:
    doc, _ = _unnamed(writable, fixture_pdf, tmp_path)
    page = doc.page(0)
    before = page.annotations()
    second = before[1]
    page.update_annotation(dataclasses.replace(second, contents="Edited", color=RED))
    after = {a.id: a for a in page.annotations()}
    assert after[second.id].contents == "Edited"
    assert after[second.id].color == RED
    for other in (before[0], before[2]):
        assert after[other.id].contents == other.contents
        assert after[other.id].color == other.color
        assert after[other.id].name == other.name
    doc.close()


def test_delete_by_name_of_an_unnamed_annotation_deletes_only_that_one(
    writable: Engine, fixture_pdf, tmp_path: Path
) -> None:
    doc, _ = _unnamed(writable, fixture_pdf, tmp_path)
    page = doc.page(0)
    before = page.annotations()
    page.delete_annotation(None, name=before[1].name)
    left = page.annotations()
    assert [a.id for a in left] == [before[0].id, before[2].id]
    assert [a.name for a in left] == [before[0].name, before[2].name]
    doc.close()


def test_undo_of_delete_gives_a_real_name_and_stays_addressable(
    writable: Engine, fixture_pdf, tmp_path: Path
) -> None:
    doc, _ = _unnamed(writable, fixture_pdf, tmp_path)
    page = doc.page(0)
    gone = page.annotations()[1]
    page.delete_annotation(gone.id, name=gone.name)
    stored = page.add_annotation(dataclasses.replace(gone, id=None))
    # a synthetic name is never written: the re-created comment gets a real /NM
    assert stored.name.startswith("pdfeditor-") and not is_synthetic_name(stored.name)
    assert page.current_annotation_name(gone.name) == stored.name
    # a command that still holds the old name finds the comment
    page.update_annotation(dataclasses.replace(gone, contents="Back"))
    assert next(a for a in page.annotations() if a.name == stored.name).contents == "Back"
    doc.close()


def test_saved_unnamed_comments_stay_addressable(
    writable: Engine, fixture_pdf, tmp_path: Path
) -> None:
    doc, path = _unnamed(writable, fixture_pdf, tmp_path)
    page = doc.page(0)
    second = page.annotations()[1]
    page.update_annotation(dataclasses.replace(second, contents="Edited"))
    doc.save()
    doc.close()

    # A full save gives the untouched comments a real /NM, so their names survive the reopen;
    # each is still found by its contents, then addressed by the name read back.
    again = writable.open(path)
    page = again.page(0)
    names = [a.name for a in page.annotations()]
    assert len(names) == 3 and all(names) and len(set(names)) == 3
    edited = next(a for a in page.annotations() if a.contents == "Edited")
    page.update_annotation(dataclasses.replace(edited, contents="Edited again"))
    contents = sorted(a.contents for a in page.annotations())
    assert contents == ["Box one", "Edited again", "Note three"]
    again.close()
    # a note's /Popup is an Annots entry too: not a comment; no backend name is ever written
    record("comments_unnamed_pikepdf", path)


# -- box geometry, "no fill" and empty contents (issues #163, #164, #170) --------------------
# A bordered square or circle must read back the rect it was written with, through add, update
# and a delete-then-undo (re-creating the model). Each write is also saved, reopened, opened in
# pikepdf and rendered in pypdfium2.

BOX = Rect(100, 100, 200, 160)


def _assert_rect(actual: Rect, expected: Rect) -> None:
    got = (actual.x0, actual.y0, actual.x1, actual.y1)
    assert got == pytest.approx((expected.x0, expected.y0, expected.x1, expected.y1), abs=0.01)


def _save_and_reopen(
    engine: Engine,
    doc,
    path: Path,
    subtype: str,
    present: tuple[str, ...] = (),
    absent: tuple[str, ...] = (),
    contents: str | None = None,
):
    """Save, check the file in pikepdf and pypdfium2, and reopen it with the engine.

    ``present``, ``absent`` and ``contents`` assert on the saved annotation's entries.
    """
    doc.save()
    doc.close()
    record(
        "annot_keys_pikepdf",
        path,
        subtype=subtype,
        present=list(present),
        absent=list(absent),
        contents=contents,
    )
    record("page_count_pdfium", path, pages=5)  # text_multipage has five pages
    record("render_pdfium", path, page=0, scale=1)
    return engine.open(path)


@pytest.mark.parametrize(
    "kind", [AnnotationType.SQUARE, AnnotationType.CIRCLE], ids=["square", "circle"]
)
def test_bordered_box_reads_back_the_rect_it_was_written_with(
    writable: Engine, fixture_pdf, tmp_path: Path, kind: AnnotationType
) -> None:
    doc, path = _open(writable, fixture_pdf, tmp_path)
    page = doc.page(0)
    stored = page.add_annotation(AnnotationModel(kind, 0, BOX, color=RED, border_width=2))
    _assert_rect(stored.rect, BOX)  # add
    read = next(a for a in page.annotations() if a.name == stored.name)
    _assert_rect(read.rect, BOX)

    for _ in range(3):  # update: every write must leave the rect where it is
        read = page.update_annotation(dataclasses.replace(read, color=BLUE))
        _assert_rect(read.rect, BOX)
    assert read.color == BLUE

    page.delete_annotation(read.id, name=read.name)  # delete, then undo re-creates the model
    recreated = page.add_annotation(dataclasses.replace(read, id=None))
    _assert_rect(recreated.rect, BOX)
    _assert_rect(page.update_annotation(dataclasses.replace(recreated, contents="again")).rect, BOX)

    again = _save_and_reopen(writable, doc, path, f"/{kind.value}", present=("/Rect",))
    reopened = next(a for a in again.page(0).annotations() if a.name == recreated.name)
    _assert_rect(reopened.rect, BOX)
    assert reopened.border_width == pytest.approx(2)
    again.close()


def test_no_fill_removes_the_interior_colour(writable: Engine, fixture_pdf, tmp_path: Path) -> None:
    doc, path = _open(writable, fixture_pdf, tmp_path)
    page = doc.page(0)
    sq = page.add_annotation(AnnotationModel(AnnotationType.SQUARE, 0, BOX, color=RED, fill=BLUE))
    assert sq.fill == BLUE
    cleared = page.update_annotation(dataclasses.replace(sq, fill=None))
    assert cleared.fill is None and cleared.color == RED
    _assert_rect(cleared.rect, BOX)

    again = _save_and_reopen(writable, doc, path, "/Square", absent=("/IC",))
    reopened = next(a for a in again.page(0).annotations() if a.name == sq.name)
    assert reopened.fill is None
    again.close()


def test_empty_contents_clear_the_stored_text(
    writable: Engine, fixture_pdf, tmp_path: Path
) -> None:
    doc, path = _open(writable, fixture_pdf, tmp_path)
    page = doc.page(0)
    sq = page.add_annotation(
        AnnotationModel(AnnotationType.SQUARE, 0, BOX, color=RED, contents="Old text")
    )
    cleared = page.update_annotation(dataclasses.replace(sq, contents=""))
    assert cleared.contents == ""
    assert next(a for a in page.annotations() if a.name == sq.name).contents == ""

    again = _save_and_reopen(writable, doc, path, "/Square", contents="")
    reopened = next(a for a in again.page(0).annotations() if a.name == sq.name)
    assert reopened.contents == ""
    again.close()


def test_degenerate_box_is_refused_and_leaves_the_square_unchanged(
    writable: Engine, fixture_pdf, tmp_path: Path
) -> None:
    doc, _ = _open(writable, fixture_pdf, tmp_path)
    page = doc.page(0)
    sq = page.add_annotation(AnnotationModel(AnnotationType.SQUARE, 0, BOX, color=RED))
    before = next(a for a in page.annotations() if a.name == sq.name)
    with pytest.raises(EngineError):
        page.update_annotation(dataclasses.replace(sq, rect=Rect(150, 100, 150, 160), color=BLUE))
    with pytest.raises(EngineError):
        page.add_annotation(AnnotationModel(AnnotationType.CIRCLE, 0, Rect(10, 10, 10, 50)))
    after = next(a for a in page.annotations() if a.name == sq.name)
    _assert_rect(after.rect, BOX)
    assert after.color == before.color == RED
    assert len(page.annotations()) == 1  # the refused add left no annotation behind
    doc.close()


def test_no_fill_removes_the_interior_colour_on_a_line(
    writable: Engine, fixture_pdf, tmp_path: Path
) -> None:
    doc, path = _open(writable, fixture_pdf, tmp_path)
    page = doc.page(0)
    line = page.add_annotation(
        AnnotationModel(
            AnnotationType.LINE,
            0,
            Rect(0, 0, 0, 0),
            color=RED,
            fill=BLUE,
            vertices=(Point(100, 400), Point(300, 420)),
        )
    )
    assert line.fill == BLUE
    cleared = page.update_annotation(dataclasses.replace(line, fill=None))
    assert cleared.fill is None

    again = _save_and_reopen(writable, doc, path, "/Line", absent=("/IC",))
    reopened = next(a for a in again.page(0).annotations() if a.name == line.name)
    assert reopened.fill is None
    again.close()


# -- multi-line redaction marks (issue #165) ----------------------------------------------------
# A text mark keeps one quad per line. Its quads and overlay colour must read back after save
# and reopen, not just the bounding box.


def _corners(quads) -> list[tuple[float, float]]:
    return [(p.x, p.y) for q in quads for p in (q.ul, q.ur, q.ll, q.lr)]


def _flat(quads) -> list[float]:
    # pytest 9.2 rejects pytest.approx on nested sequences, so compare the coordinates flat.
    return [c for xy in _corners(quads) for c in xy]


def test_two_line_redaction_mark_round_trips_quads_and_colour(
    writable: Engine, fixture_pdf, tmp_path: Path
) -> None:
    doc, path = _open(writable, fixture_pdf, tmp_path)
    lines = (Quad.from_rect(Rect(100, 100, 220, 114)), Quad.from_rect(Rect(100, 130, 180, 144)))
    mark = AnnotationModel(
        AnnotationType.REDACT,
        0,
        Rect(100, 100, 220, 144),
        quads=lines,
        overlay_text="REDACTED",
        text_color=RED,
    )
    stored = doc.page(0).add_annotation(mark)
    assert _flat(stored.quads) == pytest.approx(_flat(lines))  # add
    assert stored.text_color == RED

    again = _save_and_reopen(writable, doc, path, "/Redact")
    reopened = next(a for a in again.page(0).annotations() if a.name == stored.name)
    assert _flat(reopened.quads) == pytest.approx(_flat(lines))
    assert reopened.text_color == RED
    assert reopened.overlay_text == "REDACTED"
    again.close()

    # The saved /QuadPoints hold the two lines in PDF space (origin bottom-left).
    corners = [list(c) for c in _corners(lines)]
    record("quad_points_pikepdf", path, subtype="/Redact", corners=corners)


# -- restyling a redaction mark (W7.4b) ---------------------------------------------------------
# An update must write a mark's box colour, overlay text and text colour, not only its geometry:
# the restyle action sends exactly those three fields through update_annotation.


def test_redaction_mark_update_persists_fill_overlay_and_text_colour(
    writable: Engine, fixture_pdf, tmp_path: Path
) -> None:
    doc, path = _open(writable, fixture_pdf, tmp_path)
    lines = (Quad.from_rect(Rect(100, 100, 220, 114)), Quad.from_rect(Rect(100, 130, 180, 144)))
    mark = AnnotationModel(
        AnnotationType.REDACT,
        0,
        Rect(100, 100, 220, 144),
        quads=lines,
        contents="secret",
        overlay_text="OLD",
        text_color=RED,
    )
    stored = doc.page(0).add_annotation(mark)
    restyled = dataclasses.replace(stored, fill=BLUE, overlay_text="EXEMPT", text_color=BLUE)
    updated = doc.page(0).update_annotation(restyled)
    assert (updated.fill, updated.overlay_text, updated.text_color) == (BLUE, "EXEMPT", BLUE)
    assert updated.rect == stored.rect and updated.name == stored.name
    assert updated.contents == "secret"
    assert _flat(updated.quads) == pytest.approx(_flat(lines))  # no cross-out change

    # Clearing the overlay text removes it; the box colour and text colour stay as set.
    cleared = doc.page(0).update_annotation(dataclasses.replace(updated, overlay_text=""))
    assert cleared.overlay_text == "" and cleared.fill == BLUE and cleared.text_color == BLUE

    again = _save_and_reopen(writable, doc, path, "/Redact", contents="secret")
    reopened = next(a for a in again.page(0).annotations() if a.name == stored.name)
    assert reopened.fill == BLUE and reopened.text_color == BLUE
    assert reopened.overlay_text == ""
    assert _flat(reopened.quads) == pytest.approx(_flat(lines))
    again.close()
    record(
        "redact_annot_pikepdf",
        path,
        page=0,
        mark=stored.name,
        fill=[0, 0, 1],
        overlay="",
        text=[0, 0, 1],
    )
