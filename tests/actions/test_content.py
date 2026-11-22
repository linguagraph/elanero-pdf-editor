"""Content-editing actions on real documents: labels, results, undo, refusals and the round-trip
rule. Each action runs through ``DocumentSession`` with no Qt. Saved files must open in pikepdf
and render in pypdfium2 (independent implementations), not only in MuPDF.
"""

from __future__ import annotations

import io
import math
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from typing import cast

import pytest
from PIL import Image

from pdfeditor.actions import available, content, run
from pdfeditor.actions.base import NotSupported, Refused, StaleObject
from pdfeditor.actions.content import (
    AddImage,
    AddShape,
    AddText,
    DeleteObjects,
    ReplaceImage,
    ReplaceText,
    TransformObjects,
)
from pdfeditor.core.engine_lock import ENGINE_LOCK
from pdfeditor.core.session import DocumentSession
from pdfeditor.engine.base import Document
from pdfeditor.engine.registry import get_engine
from pdfeditor.model import platform as model_platform
from pdfeditor.model.color import Color
from pdfeditor.model.geometry import Matrix, Point, Rect
from pdfeditor.model.objects import (
    FontChoice,
    ObjectRef,
    ObjectType,
    PageObject,
    ShapeKind,
    ShapeSpec,
    TextStyle,
)
from pdfeditor.webapi.limits import MAX_IMAGE_BYTES
from pdfeditor.webapi.platform import WEB_PLATFORM
from tests.actions.conftest import Opener
from tests.hostcheck import record

# The registry's Busy test calls each action with these args (see test_registry.py). The values
# only have to type-check: the Busy check runs first.
BUSY_CASES: dict[str, object] = {
    "content.transform": TransformObjects((ObjectRef(0, "k", 0),), Matrix.translate(1, 1)),
    "content.replace_text": ReplaceText(ObjectRef(0, "k", 0), "x"),
    "content.add_text": AddText(0, Rect(0, 0, 10, 10), "x", TextStyle()),
    "content.add_image": AddImage(0, Rect(0, 0, 10, 10), b""),
    "content.add_shape": AddShape(0, ShapeSpec(ShapeKind.RECTANGLE, Rect(0, 0, 10, 10))),
    "content.delete": DeleteObjects((ObjectRef(0, "k", 0),)),
    "content.replace_image": ReplaceImage(ObjectRef(0, "k", 0), b""),
}


# -- helpers -------------------------------------------------------------------------------


def objects(s: DocumentSession, page: int = 0) -> list[PageObject]:
    with s.lock:
        return s.document.page(page).content_objects()


def refs(
    s: DocumentSession, page: int = 0, kind: ObjectType | None = None
) -> tuple[ObjectRef, ...]:
    """Refs to the page's objects (of one type, if given), at the page's current revision."""
    with s.lock:
        pg = s.document.page(page)
        revision = pg.revision
        found = pg.content_objects()
    return tuple(ObjectRef(page, o.key, revision) for o in found if kind is None or o.type is kind)


def texts(s: DocumentSession, page: int = 0) -> list[str]:
    return [o.text for o in objects(s, page) if o.type is ObjectType.TEXT]


def snapshot_of(s: DocumentSession, page: int = 0) -> list[tuple[ObjectType, str, Rect]]:
    return [(o.type, o.text, o.bbox) for o in objects(s, page)]


def png(color: tuple[int, int, int], size: tuple[int, int] = (60, 50)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


@contextmanager
def reopened(path: Path) -> Iterator[Document]:
    with ENGINE_LOCK:
        doc = get_engine("mupdf").open(path)
        try:
            yield doc
        finally:
            doc.close()


def assert_opens_everywhere(path: Path) -> None:
    """The saved file opens in pikepdf and page 0 renders in pypdfium2."""
    record("pages_at_least_pikepdf", path, minimum=1)
    record("render_pdfium", path, page=0, scale=1)


# -- labels, results and undo --------------------------------------------------------------


def test_transform_moves_text_and_undo_restores(open_copy: Opener) -> None:
    s = open_copy("mixed_content")
    before = snapshot_of(s)
    second = refs(s, 0, ObjectType.TEXT)[2]
    origin = next(o for o in objects(s) if o.key == second.key).bbox
    result = content.transform(s, TransformObjects((second,), Matrix.translate(0, 100)))
    assert result.label == "Move Text" and result.executed and result.value is None
    moved = next(o for o in objects(s) if o.text.startswith("A second"))
    assert moved.bbox.y0 == pytest.approx(origin.y0 + 100, abs=4)
    assert s.undo()
    assert snapshot_of(s) == before


def test_transform_labels_mixed_selections_as_objects(open_copy: Opener) -> None:
    s = open_copy("mixed_content")
    result = content.transform(s, TransformObjects(refs(s, 0), Matrix.translate(0, 5)))
    assert result.label == "Move Object"
    # The first move bumped the page revision, so the refs are picked again.
    result = content.transform(s, TransformObjects(refs(s, 0), Matrix.scale(1.0), resize=True))
    assert result.label == "Resize Object"


def test_resize_of_text_is_labelled_resize_text(open_copy: Opener) -> None:
    s = open_copy("mixed_content")
    heading = refs(s, 0, ObjectType.TEXT)[0]
    result = content.transform(s, TransformObjects((heading,), Matrix.scale(1.2), resize=True))
    assert result.label == "Resize Text"


def test_transform_image_shifts_its_bbox_exactly(open_copy: Opener) -> None:
    s = open_copy("mixed_content")
    (image,) = refs(s, 0, ObjectType.IMAGE)
    content.transform(s, TransformObjects((image,), Matrix.translate(-300, 350)))
    (moved,) = (o for o in objects(s) if o.type is ObjectType.IMAGE)
    assert moved.bbox == Rect(120, 430, 240, 530)


def test_replace_text_returns_the_font_and_undo_restores(open_copy: Opener) -> None:
    s = open_copy("mixed_content")
    before = snapshot_of(s)
    body = refs(s, 0, ObjectType.TEXT)[1]
    result = content.replace_text(s, ReplaceText(body, "Edited paragraph."))
    assert result.label == "Edit Text" and result.executed
    assert isinstance(result.value, FontChoice) and not result.value.substituted
    assert any("Edited paragraph." in t for t in texts(s))
    assert s.undo()
    assert snapshot_of(s) == before


def test_replace_text_in_a_subset_font_reports_substitution(open_copy: Opener) -> None:
    s = open_copy("subset_fonts")
    (block,) = refs(s, 0, ObjectType.TEXT)
    result = content.replace_text(s, ReplaceText(block, "Qwertyuiop XYZ 987"))
    assert isinstance(result.value, FontChoice) and result.value.substituted
    assert any("Qwertyuiop XYZ 987" in t for t in texts(s))


def test_add_text_blank_is_not_executed(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    result = content.add_text(s, AddText(0, Rect(300, 700, 550, 720), "   ", TextStyle()))
    assert result.label == "Add Text" and not result.executed and result.value is None
    assert not s.undo_stack.can_undo


def test_add_text_and_undo(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    before = snapshot_of(s)
    style = TextStyle(font="Courier", size=14, color=Color(0, 0, 1))
    result = content.add_text(
        s, AddText(0, Rect(300, 700, 550, 720), "New text box that wraps", style)
    )
    assert result.label == "Add Text" and result.executed
    assert isinstance(result.value, FontChoice) and result.value.name.startswith("Courier")
    assert any(t.startswith("New text box") for t in texts(s))
    assert s.undo()
    assert snapshot_of(s) == before


def test_add_image_and_undo(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    before = snapshot_of(s)
    result = content.add_image(s, AddImage(0, Rect(100, 100, 200, 200), png((0, 200, 0))))
    assert result.label == "Add Image" and result.executed and result.value is None
    assert [o.type for o in objects(s)].count(ObjectType.IMAGE) == 1
    assert s.undo()
    assert snapshot_of(s) == before


@pytest.mark.parametrize(
    ("spec", "label"),
    [
        (ShapeSpec(ShapeKind.RECTANGLE, Rect(100, 500, 200, 560)), "Add Rectangle"),
        (ShapeSpec(ShapeKind.ELLIPSE, Rect(100, 500, 200, 560)), "Add Ellipse"),
        (ShapeSpec(ShapeKind.LINE, start=Point(100, 600), end=Point(300, 600)), "Add Line"),
    ],
)
def test_add_shape_labels_and_undo(open_copy: Opener, spec: ShapeSpec, label: str) -> None:
    s = open_copy("text_multipage")
    before = snapshot_of(s)
    result = content.add_shape(s, AddShape(0, spec))
    assert result.label == label and result.executed and result.value is None
    assert [o.type for o in objects(s)].count(ObjectType.PATH) == 1
    assert s.undo()
    assert snapshot_of(s) == before


REFUSED_SHAPES = [
    pytest.param(ShapeSpec(ShapeKind.RECTANGLE, Rect(100, 500, 200, 560), width=0.0), id="width0"),
    pytest.param(
        ShapeSpec(ShapeKind.ELLIPSE, Rect(100, 500, 200, 560), width=100.0), id="width100"
    ),
    pytest.param(ShapeSpec(ShapeKind.RECTANGLE, Rect(100, 500, 100, 560)), id="empty_rect"),
    pytest.param(ShapeSpec(ShapeKind.ELLIPSE, Rect(200, 500, 100, 560)), id="flipped_box"),
    pytest.param(
        ShapeSpec(ShapeKind.LINE, start=Point(100, 600), end=Point(100, 600)), id="point_line"
    ),
    pytest.param(ShapeSpec(ShapeKind.RECTANGLE, Rect(math.nan, 500, 200, 560)), id="nan_box"),
    pytest.param(ShapeSpec(ShapeKind.ELLIPSE, Rect(100, 500, math.inf, 560)), id="inf_box"),
    pytest.param(
        ShapeSpec(ShapeKind.LINE, start=Point(100, math.nan), end=Point(300, 600)), id="nan_line"
    ),
    pytest.param(
        ShapeSpec(ShapeKind.LINE, start=Point(100, 600), end=Point(-math.inf, 600)),
        id="inf_line",
    ),
]


@pytest.mark.parametrize("spec", REFUSED_SHAPES)
def test_add_shape_refuses_bad_specs(open_copy: Opener, spec: ShapeSpec) -> None:
    s = open_copy("text_multipage")
    before = snapshot_of(s)
    with pytest.raises(Refused):
        content.add_shape(s, AddShape(0, spec))
    assert snapshot_of(s) == before
    assert not s.undo_stack.can_undo


def test_add_shape_redo_restores_it_at_a_new_revision(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    content.add_shape(s, AddShape(0, ShapeSpec(ShapeKind.RECTANGLE, Rect(100, 500, 200, 560))))
    with s.lock:
        added_at = s.document.page(0).revision
    added = snapshot_of(s)
    assert s.undo()
    with s.lock:
        # A web cache keyed by the revision the add reported must not be reused after an undo.
        undone_at = s.document.page(0).revision
        assert undone_at != added_at
    assert s.redo()
    with s.lock:
        redone_at = s.document.page(0).revision
    # The redo is a new revision as well: neither the add's nor the undo's may be reused.
    assert redone_at not in {added_at, undone_at}
    assert [o.type for o in objects(s)].count(ObjectType.PATH) == 1
    assert snapshot_of(s) == added


def test_delete_two_objects_is_counted(open_copy: Opener) -> None:
    s = open_copy("mixed_content")
    two = (refs(s, 0, ObjectType.TEXT)[0], refs(s, 0, ObjectType.IMAGE)[0])
    before = snapshot_of(s)
    result = content.delete(s, DeleteObjects(two))
    assert result.label == "Delete 2 Objects" and result.value == 2 and result.executed
    assert len(objects(s)) == len(before) - 2
    assert s.undo()
    assert snapshot_of(s) == before


def test_delete_one_object_is_singular(open_copy: Opener) -> None:
    s = open_copy("mixed_content")
    result = content.delete(s, DeleteObjects((refs(s, 0, ObjectType.PATH)[0],)))
    assert result.label == "Delete Object" and result.value == 1
    assert not [o for o in objects(s) if o.type is ObjectType.PATH]


def test_delete_across_pages_is_one_undo_step(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    first, second = refs(s, 0, ObjectType.TEXT)[0], refs(s, 1, ObjectType.TEXT)[0]
    before_p0, before_p1 = snapshot_of(s, 0), snapshot_of(s, 1)
    result = content.delete(s, DeleteObjects((first, second)))
    assert result.label == "Delete 2 Objects" and result.value == 2
    assert len(objects(s, 0)) == len(before_p0) - 1
    assert len(objects(s, 1)) == len(before_p1) - 1
    assert s.undo()
    assert not s.undo_stack.can_undo
    assert snapshot_of(s, 0) == before_p0 and snapshot_of(s, 1) == before_p1


def test_delete_nothing_is_not_executed(open_copy: Opener) -> None:
    s = open_copy("mixed_content")
    result = content.delete(s, DeleteObjects(()))
    assert result.value == 0 and not result.executed
    assert not s.undo_stack.can_undo


def test_delete_counts_a_key_named_twice_once(open_copy: Opener) -> None:
    s = open_copy("mixed_content")
    heading = refs(s, 0, ObjectType.TEXT)[0]
    before = snapshot_of(s)
    result = content.delete(s, DeleteObjects((heading, heading)))
    assert result.label == "Delete Object" and result.value == 1
    assert len(objects(s)) == len(before) - 1
    assert s.undo()
    assert snapshot_of(s) == before


def test_replace_image_and_undo(open_copy: Opener) -> None:
    s = open_copy("mixed_content")
    before = snapshot_of(s)
    (image,) = refs(s, 0, ObjectType.IMAGE)
    result = content.replace_image(s, ReplaceImage(image, png((0, 200, 0))))
    assert result.label == "Replace Image" and result.executed and result.value is None
    assert s.undo()
    assert snapshot_of(s) == before


# -- stale refs and refusals ---------------------------------------------------------------


def act_on_one_ref(name: str, s: DocumentSession, ref: ObjectRef) -> object:
    """Run the named ref-taking action on one object."""
    if name == "transform":
        return content.transform(s, TransformObjects((ref,), Matrix.translate(0, 5)))
    if name == "replace_text":
        return content.replace_text(s, ReplaceText(ref, "Stale edit"))
    if name == "delete":
        return content.delete(s, DeleteObjects((ref,)))
    if name == "replace_image":
        return content.replace_image(s, ReplaceImage(ref, png((0, 200, 0))))
    raise AssertionError(name)


# (action, the object type its ref points at)
REF_ACTIONS = [
    ("transform", ObjectType.TEXT),
    ("replace_text", ObjectType.TEXT),
    ("delete", ObjectType.TEXT),
    ("replace_image", ObjectType.IMAGE),
]


@pytest.mark.parametrize(("name", "kind"), REF_ACTIONS)
def test_ref_picked_before_another_edit_is_stale(
    open_copy: Opener, name: str, kind: ObjectType
) -> None:
    s = open_copy("mixed_content")
    old = refs(s, 0, kind)[0]
    content.add_shape(s, AddShape(0, ShapeSpec(ShapeKind.LINE, start=Point(1, 1), end=Point(9, 9))))
    before = snapshot_of(s)
    with pytest.raises(StaleObject, match="Page 1 changed after the object was selected"):
        act_on_one_ref(name, s, old)
    assert snapshot_of(s) == before
    # Only the shape is on the undo stack: the refused edit left nothing behind.
    assert s.undo()
    assert not s.undo_stack.can_undo


@pytest.mark.parametrize(("name", "kind"), REF_ACTIONS)
def test_ref_to_a_deleted_page_is_stale(open_copy: Opener, name: str, kind: ObjectType) -> None:
    s = open_copy("mixed_content")
    with s.lock:
        revision = s.document.page(0).revision
    gone = ObjectRef(99, "text:0", revision)  # no such page
    with pytest.raises(StaleObject):
        act_on_one_ref(name, s, gone)
    assert not s.undo_stack.can_undo


@pytest.mark.parametrize(
    "run_creation",
    [
        lambda s: content.add_text(s, AddText(99, Rect(0, 0, 50, 20), "Text", TextStyle())),
        lambda s: content.add_image(s, AddImage(99, Rect(0, 0, 50, 20), png((0, 0, 0)))),
        lambda s: content.add_shape(
            s, AddShape(99, ShapeSpec(ShapeKind.RECTANGLE, Rect(0, 0, 50, 20)))
        ),
    ],
    ids=["add_text", "add_image", "add_shape"],
)
def test_creation_on_a_missing_page_is_refused(open_copy: Opener, run_creation) -> None:
    s = open_copy("mixed_content")
    with s.lock:
        before = s.document.page(0).revision
    with pytest.raises(Refused, match="Page 100 doesn't exist"):
        run_creation(s)
    with s.lock:
        assert s.document.page(0).revision == before
    assert not s.undo_stack.can_undo


def test_transform_of_a_key_not_on_the_page_is_stale(open_copy: Opener) -> None:
    s = open_copy("mixed_content")
    with s.lock:
        revision = s.document.page(0).revision
    bogus = ObjectRef(0, "no-such-object", revision)
    with pytest.raises(StaleObject):
        content.transform(s, TransformObjects((bogus,), Matrix.translate(0, 10)))
    assert not s.undo_stack.can_undo


def test_transform_across_pages_is_refused_and_changes_nothing(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    on_page_0 = refs(s, 0, ObjectType.TEXT)[0]
    with s.lock:
        revision_1 = s.document.page(1).revision
    on_page_1 = ObjectRef(1, "any-key", revision_1)
    with pytest.raises(Refused, match="different pages"):
        content.transform(s, TransformObjects((on_page_0, on_page_1), Matrix.translate(0, 5)))
    assert not s.undo_stack.can_undo


# -- round trip: edit -> save -> reopen -> assert, and pikepdf / pypdfium2 ------------------


def test_round_trip_transform(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("mixed_content")
    second = refs(s, 0, ObjectType.TEXT)[2]
    origin = next(o for o in objects(s) if o.key == second.key).bbox
    content.transform(s, TransformObjects((second,), Matrix.translate(0, 100)))
    out = s.save(tmp_path / "moved.pdf")
    assert_opens_everywhere(out)
    with reopened(out) as doc:
        (moved,) = (o for o in doc.page(0).content_objects() if o.text.startswith("A second"))
    assert moved.bbox.y0 == pytest.approx(origin.y0 + 100, abs=4)
    record("text_contains_pdfium", out, page=0, text="A second paragraph")


def test_round_trip_replace_text(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("mixed_content")
    body = refs(s, 0, ObjectType.TEXT)[1]
    content.replace_text(s, ReplaceText(body, "Edited paragraph."))
    out = s.save(tmp_path / "replaced.pdf")
    assert_opens_everywhere(out)
    record("text_contains_pdfium", out, page=0, text="Edited paragraph.")
    with reopened(out) as doc:
        found = [o.text for o in doc.page(0).content_objects() if o.type is ObjectType.TEXT]
    assert any("Edited paragraph." in t for t in found)


def test_round_trip_add_text(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("text_multipage")
    content.add_text(
        s, AddText(0, Rect(300, 700, 550, 720), "Round trip text box", TextStyle(font="Courier"))
    )
    out = s.save(tmp_path / "added_text.pdf")
    assert_opens_everywhere(out)
    record("text_contains_pdfium", out, page=0, text="Round trip text box")
    with reopened(out) as doc:
        found = [o.text for o in doc.page(0).content_objects() if o.type is ObjectType.TEXT]
    assert any(t.startswith("Round trip text box") for t in found)


def test_round_trip_add_image(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("text_multipage")
    content.add_image(s, AddImage(0, Rect(100, 100, 200, 200), png((0, 200, 0))))
    out = s.save(tmp_path / "added_image.pdf")
    assert_opens_everywhere(out)
    record("pixel_green_pdfium", out, page=0, x=150, y=150)
    with reopened(out) as doc:
        assert [o.type for o in doc.page(0).content_objects()].count(ObjectType.IMAGE) == 1


def jpeg(color: tuple[int, int, int], size: tuple[int, int] = (60, 50)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="JPEG", quality=95)
    return buf.getvalue()


def test_add_image_redo_restores_it_at_a_new_revision(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    content.add_image(s, AddImage(0, Rect(100, 100, 200, 200), png((0, 200, 0))))
    with s.lock:
        added_at = s.document.page(0).revision
    added = snapshot_of(s)
    assert s.undo()
    with s.lock:
        undone_at = s.document.page(0).revision
    assert undone_at != added_at
    assert s.redo()
    with s.lock:
        redone_at = s.document.page(0).revision
    assert redone_at not in {added_at, undone_at}
    assert snapshot_of(s) == added


def test_add_image_keeps_the_aspect_inside_the_box(open_copy: Opener, tmp_path: Path) -> None:
    # A 60 x 50 picture in a 200 x 200 box is fitted to 200 x 166.7, centred: its top edge is at
    # y 316.7, so the strip above it stays blank, and the centre is green. rotated_pages page 0 has
    # only its heading (near the top) on the page, so the strip is blank.
    s = open_copy("rotated_pages")
    content.add_image(s, AddImage(0, Rect(100, 300, 300, 500), png((0, 200, 0))))
    out = s.save(tmp_path / "fitted_image.pdf")
    assert_opens_everywhere(out)
    record("pixel_green_pdfium", out, page=0, x=200, y=400)
    record("blank_region_pdfium", out, page=0, clip=[110, 305, 290, 312])


def test_add_image_stretches_when_keep_proportion_is_off(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("text_multipage")
    content.add_image(
        s, AddImage(0, Rect(100, 100, 300, 300), png((0, 200, 0)), keep_proportion=False)
    )
    out = s.save(tmp_path / "stretched_image.pdf")
    assert_opens_everywhere(out)
    record("pixel_green_pdfium", out, page=0, x=110, y=110)
    record("pixel_green_pdfium", out, page=0, x=290, y=290)


def test_round_trip_add_jpeg_is_passed_through(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("text_multipage")
    content.add_image(s, AddImage(0, Rect(100, 100, 300, 300), jpeg((255, 0, 0))))
    out = s.save(tmp_path / "added_jpeg.pdf")
    assert_opens_everywhere(out)
    record("pixel_red_pdfium", out, page=0, x=200, y=200)
    record("image_filter_pikepdf", out, page=0, filter="/DCTDecode")


def test_round_trip_add_image_on_rotated_page(open_copy: Opener, tmp_path: Path) -> None:
    # Two colours, left red and right blue, placed upright on a page with /Rotate 90.
    left_right = Image.new("RGB", (40, 20), (255, 0, 0))
    left_right.paste((0, 0, 255), (20, 0, 40, 20))
    buf = io.BytesIO()
    left_right.save(buf, format="PNG")
    s = open_copy("rotated_pages")  # page 1: /Rotate 90, no crop box
    content.add_image(s, AddImage(1, Rect(100, 100, 300, 200), buf.getvalue()))
    out = s.save(tmp_path / "rotated_image.pdf")
    assert_opens_everywhere(out)
    record("pixel_red_pdfium", out, page=1, x=150, y=150)
    record("pixel_blue_pdfium", out, page=1, x=250, y=150)


@pytest.mark.desktop_only  # a pixel check on a render the Pyodide run cannot make
@pytest.mark.xfail(
    strict=True,
    reason=(
        "Known engine bug (issue #537): on a page that is both rotated and cropped, added shapes"
        " and images land offset by the crop origin (PyMuPDF's transformation_matrix drops the"
        " crop offset). See docs/web/design/W6.7b-shapes.md section 2.3 and"
        " docs/web/design/W6.7b-s2-images.md section 6. Remove this xfail when the engine fix"
        " lands."
    ),
)
def test_image_on_rotated_cropped_page(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("off_page_text")  # page 1: /Rotate 90, CropBox (50, 50, 550, 750)
    content.add_image(s, AddImage(1, Rect(100, 100, 200, 160), png((200, 0, 0), (40, 20))))
    out = s.save(tmp_path / "rotated_cropped_image.pdf")
    record("pixel_red_pdfium", out, page=1, x=150, y=130)


def gif(size: tuple[int, int] = (60, 50)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, (0, 0, 200)).save(buf, format="GIF")
    return buf.getvalue()


def tiff(size: tuple[int, int] = (60, 50)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, (0, 0, 200)).save(buf, format="TIFF")
    return buf.getvalue()


def png_with_pixels(width: int, height: int) -> bytes:
    """A 1-bit PNG with ``width x height`` pixels: the file stays small, the header declares more
    pixels than the web's cap."""
    buf = io.BytesIO()
    Image.new("1", (width, height), 0).save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture
def web_platform() -> Iterator[None]:
    """The browser's image rules (formats and caps) for the test, then the desktop's again."""
    previous = model_platform.current()
    model_platform.configure(WEB_PLATFORM)
    try:
        yield
    finally:
        model_platform.configure(previous)


# Each refused image, with the words of the refusal. The data is built inside the test.
REFUSED_ON_THE_WEB = [
    pytest.param(gif, "PNG and JPEG", id="gif"),
    pytest.param(tiff, "PNG and JPEG", id="tiff"),
    pytest.param(lambda: b"", "not an image the editor can read", id="empty"),
    pytest.param(lambda: b"this is plainly not an image", "not an image the editor", id="garbage"),
    pytest.param(
        lambda: b"\x89PNG\r\n\x1a\n" + b"\0" * MAX_IMAGE_BYTES,
        "larger than 50 MB",
        id="too_many_bytes",
    ),
    pytest.param(
        lambda: png_with_pixels(5000, 5001), "more than 25 million pixels", id="too_many_pixels"
    ),
]


@pytest.mark.parametrize(("make", "message"), REFUSED_ON_THE_WEB)
def test_add_image_refuses_what_the_web_cannot_add(
    open_copy: Opener, web_platform: None, make: Callable[[], bytes], message: str
) -> None:
    s = open_copy("text_multipage")
    with s.lock:
        before = s.document.page(0).revision
    with pytest.raises(Refused, match=message):
        content.add_image(s, AddImage(0, Rect(100, 100, 200, 200), make()))
    with s.lock:
        assert s.document.page(0).revision == before
    assert not s.undo_stack.can_undo


def test_add_image_still_takes_a_gif_on_the_desktop(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    content.add_image(s, AddImage(0, Rect(100, 100, 200, 200), gif()))
    assert [o.type for o in objects(s)].count(ObjectType.IMAGE) == 1


def test_round_trip_add_shape(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("text_multipage")
    red = Color(1, 0, 0)
    content.add_shape(
        s,
        AddShape(0, ShapeSpec(ShapeKind.RECTANGLE, Rect(100, 500, 200, 560), stroke=red, fill=red)),
    )
    out = s.save(tmp_path / "added_shape.pdf")
    assert_opens_everywhere(out)
    record("pixel_red_pdfium", out, page=0, x=150, y=530)
    with reopened(out) as doc:
        assert [o.type for o in doc.page(0).content_objects()].count(ObjectType.PATH) == 1


# Each shape, the box its path must cover, and a clip on its outline and (for a box) its centre.
SHAPE_CASES = [
    pytest.param(
        ShapeKind.RECTANGLE,
        ShapeSpec(ShapeKind.RECTANGLE, Rect(100, 500, 200, 560), width=1.5),
        Rect(100, 500, 200, 560),
        [97, 527, 103, 533],
        [140, 520, 160, 540],
        id="rectangle",
    ),
    pytest.param(
        ShapeKind.ELLIPSE,
        ShapeSpec(ShapeKind.ELLIPSE, Rect(100, 500, 200, 560), width=1.5),
        Rect(100, 500, 200, 560),
        [97, 527, 103, 533],
        [140, 520, 160, 540],
        id="ellipse",
    ),
    pytest.param(
        ShapeKind.LINE,
        ShapeSpec(ShapeKind.LINE, start=Point(100, 600), end=Point(300, 640), width=1.5),
        Rect(100, 600, 300, 640),
        [197, 617, 203, 623],
        None,
        id="line",
    ),
]


@pytest.mark.parametrize(("kind", "spec", "box", "ink", "blank"), SHAPE_CASES)
def test_round_trip_add_shape_kinds(
    open_copy: Opener,
    tmp_path: Path,
    kind: ShapeKind,
    spec: ShapeSpec,
    box: Rect,
    ink: list[float],
    blank: list[float] | None,
) -> None:
    s = open_copy("text_multipage")
    content.add_shape(s, AddShape(0, spec))
    out = s.save(tmp_path / f"added_{kind.value}.pdf")
    assert_opens_everywhere(out)
    with reopened(out) as doc:
        paths = [o for o in doc.page(0).content_objects() if o.type is ObjectType.PATH]
    assert len(paths) == 1
    # The path covers the requested box to within 2 pt (a stroke may widen it).
    b = paths[0].bbox
    assert b.x0 <= box.x0 + 2 and b.y0 <= box.y0 + 2
    assert b.x1 >= box.x1 - 2 and b.y1 >= box.y1 - 2
    record("shape_operators_pikepdf", out, page=0, kind=kind.value)
    record("ink_region_pdfium", out, page=0, clip=ink)
    if blank is not None:
        record("blank_region_pdfium", out, page=0, clip=blank)


def test_round_trip_filled_shape_on_rotated_page(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("rotated_pages")
    red = Color(1, 0, 0)
    spec = ShapeSpec(ShapeKind.RECTANGLE, Rect(100, 100, 200, 160), stroke=red, fill=red)
    content.add_shape(s, AddShape(1, spec))  # /Rotate 90, no crop box
    out = s.save(tmp_path / "rotated_shape.pdf")
    assert_opens_everywhere(out)
    record("pixel_red_pdfium", out, page=1, x=150, y=130)


@pytest.mark.desktop_only  # a pixel check on a render the Pyodide run cannot make
def test_shape_on_rotated_cropped_page(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("off_page_text")  # page 1: /Rotate 90, CropBox (50, 50, 550, 750)
    red = Color(1, 0, 0)
    spec = ShapeSpec(ShapeKind.RECTANGLE, Rect(100, 100, 200, 160), stroke=red, fill=red)
    content.add_shape(s, AddShape(1, spec))
    out = s.save(tmp_path / "rotated_cropped_shape.pdf")
    record("pixel_red_pdfium", out, page=1, x=150, y=130)


# -- rotated and cropped pages (issue #537): the writer, the lister and the pixels must agree --


@pytest.mark.desktop_only  # pixel checks on renders the Pyodide run cannot make
@pytest.mark.parametrize("page", range(8))
def test_round_trip_shape_rotated_cropped(open_copy: Opener, tmp_path: Path, page: int) -> None:
    s = open_copy("rotated_cropped")
    red = Color(1, 0, 0)
    box = Rect(100, 100, 200, 160)
    content.add_shape(s, AddShape(page, ShapeSpec(ShapeKind.RECTANGLE, box, stroke=red, fill=red)))
    out = s.save(tmp_path / f"shape_{page}.pdf")
    assert_opens_everywhere(out)
    record("red_bbox_pdfium", out, page=page, expected=[100, 100, 200, 160], tol=2)
    with reopened(out) as doc:
        paths = [o for o in doc.page(page).content_objects() if o.type is ObjectType.PATH]
    assert len(paths) == 1
    b = paths[0].bbox
    assert [b.x0, b.y0, b.x1, b.y1] == pytest.approx([100, 100, 200, 160], abs=2)


@pytest.mark.desktop_only
@pytest.mark.parametrize("page", range(8))
def test_round_trip_resize_image_rotated_cropped(
    open_copy: Opener, tmp_path: Path, page: int
) -> None:
    """Scale the anchor image x2 about its top-left corner: the pixels and the lister agree."""
    s = open_copy("rotated_cropped")
    with s.lock:
        (image,) = (
            o for o in s.document.page(page).content_objects() if o.type is ObjectType.IMAGE
        )
    x0, y0, w, h = image.bbox.x0, image.bbox.y0, image.bbox.width, image.bbox.height
    scale_about_top_left = Matrix(2, 0, 0, 2, -x0, -y0)
    refs_now = refs(s, page, ObjectType.IMAGE)
    result = content.transform(s, TransformObjects(refs_now, scale_about_top_left, resize=True))
    assert result.executed
    out = s.save(tmp_path / f"resize_{page}.pdf")
    assert_opens_everywhere(out)
    record("green_bbox_pdfium", out, page=page, expected=[x0, y0, x0 + 2 * w, y0 + 2 * h], tol=2)
    with reopened(out) as doc:
        images = [o for o in doc.page(page).content_objects() if o.type is ObjectType.IMAGE]
    assert len(images) == 1
    b = images[0].bbox
    assert [b.x0, b.y0, b.x1, b.y1] == pytest.approx([x0, y0, x0 + 2 * w, y0 + 2 * h], abs=2)


def test_round_trip_replace_image(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("mixed_content")
    (image,) = refs(s, 0, ObjectType.IMAGE)  # its bbox is (420, 80, 540, 180)
    content.replace_image(s, ReplaceImage(image, png((0, 200, 0))))
    out = s.save(tmp_path / "replaced_image.pdf")
    assert_opens_everywhere(out)
    record("pixel_green_pdfium", out, page=0, x=480, y=130)
    with reopened(out) as doc:
        assert [o.type for o in doc.page(0).content_objects()].count(ObjectType.IMAGE) == 1


def test_inline_image_is_listed_but_cannot_be_replaced(open_copy: Opener) -> None:
    # A picture inside the page content (BI ... EI) has no XObject to swap: it is an IMAGE in the
    # object list, so it can be moved and deleted, but a replace says why it is refused.
    s = open_copy("inline_image")
    (picture,) = refs(s, 0, ObjectType.IMAGE)
    before = snapshot_of(s)
    with s.lock:
        before_revision = s.document.page(0).revision
    with pytest.raises(Refused, match="stored inside the page content") as refusal:
        content.replace_image(s, ReplaceImage(picture, png((0, 200, 0))))
    assert refusal.value.reason == "inline_image"
    assert snapshot_of(s) == before
    with s.lock:
        assert s.document.page(0).revision == before_revision
    assert not s.undo_stack.can_undo


def test_round_trip_delete(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("mixed_content")
    heading = refs(s, 0, ObjectType.TEXT)[0]
    content.delete(s, DeleteObjects((heading,)))
    out = s.save(tmp_path / "deleted.pdf")
    assert_opens_everywhere(out)
    record("text_lacks_pdfium", out, page=0, text="Mixed content heading")
    with reopened(out) as doc:
        found = [o.text for o in doc.page(0).content_objects() if o.type is ObjectType.TEXT]
    assert len(found) == 2 and not any(t.startswith("Mixed content") for t in found)


# -- capability and dispatch ----------------------------------------------------------------


def test_content_actions_need_the_content_edit_flag(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    edit_off = replace(get_engine().capabilities, content_edit=False)
    fake = cast(DocumentSession, SimpleNamespace(engine=SimpleNamespace(capabilities=edit_off)))
    spec = ShapeSpec(ShapeKind.RECTANGLE, Rect(100, 500, 200, 560))
    with pytest.raises(NotSupported, match="content_edit"):
        run(fake, "content.add_shape", AddShape(0, spec))
    assert "content.add_shape" not in available(fake)
    assert "content.add_shape" in available(s)
    assert not s.undo_stack.can_undo


# -- replace image (W6.7b slice 2b) --------------------------------------------------------


def image_bbox(s: DocumentSession, page: int = 0) -> Rect:
    """The bbox of the page's only image, in visible space."""
    (picture,) = (o for o in objects(s, page) if o.type is ObjectType.IMAGE)
    return picture.bbox


def page_revision(s: DocumentSession, page: int = 0) -> int:
    with s.lock:
        return int(s.document.page(page).revision)


def half_clear_png(size: tuple[int, int] = (60, 50)) -> bytes:
    """Green, with the left half fully transparent."""
    img = Image.new("RGBA", size, (0, 200, 0, 255))
    img.paste((0, 0, 0, 0), (0, 0, size[0] // 2, size[1]))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def test_replace_image_keeps_the_box_and_stretches_a_new_aspect(open_copy: Opener) -> None:
    s = open_copy("mixed_content")
    box = image_bbox(s)  # 120 x 100 points
    (picture,) = refs(s, 0, ObjectType.IMAGE)
    # 30 x 90 is 1:3, not the box's 6:5: it is stretched to fill the box, as on the desktop.
    content.replace_image(s, ReplaceImage(picture, png((0, 200, 0), size=(30, 90))))
    assert image_bbox(s) == box


def test_replace_image_refuses_a_gif_and_keeps_the_picture_on_the_web(
    open_copy: Opener, web_platform: None
) -> None:
    s = open_copy("mixed_content")
    (picture,) = refs(s, 0, ObjectType.IMAGE)
    before = snapshot_of(s)
    revision = page_revision(s)
    with pytest.raises(Refused, match="PNG and JPEG"):
        content.replace_image(s, ReplaceImage(picture, gif()))
    assert snapshot_of(s) == before
    assert page_revision(s) == revision
    assert not s.undo_stack.can_undo


@pytest.mark.parametrize(("make", "message"), REFUSED_ON_THE_WEB)
def test_replace_image_refuses_what_the_web_cannot_place(
    open_copy: Opener, web_platform: None, make: Callable[[], bytes], message: str
) -> None:
    s = open_copy("mixed_content")
    (picture,) = refs(s, 0, ObjectType.IMAGE)
    before = snapshot_of(s)
    with pytest.raises(Refused, match=message):
        content.replace_image(s, ReplaceImage(picture, make()))
    assert snapshot_of(s) == before
    assert not s.undo_stack.can_undo


def test_replace_image_still_takes_a_gif_on_the_desktop(open_copy: Opener) -> None:
    s = open_copy("mixed_content")
    (picture,) = refs(s, 0, ObjectType.IMAGE)
    result = content.replace_image(s, ReplaceImage(picture, gif()))
    assert result.executed and result.label == "Replace Image"


def test_replace_image_undo_and_redo_restore_each_picture(
    open_copy: Opener, tmp_path: Path
) -> None:
    s = open_copy("mixed_content")
    (picture,) = refs(s, 0, ObjectType.IMAGE)
    box = image_bbox(s)
    before = snapshot_of(s)
    revision = page_revision(s)
    content.replace_image(s, ReplaceImage(picture, png((255, 0, 0))))
    replaced_at = page_revision(s)
    assert replaced_at != revision
    assert s.undo()
    assert snapshot_of(s) == before
    assert s.redo()
    assert page_revision(s) not in {revision, replaced_at}
    out = s.save(tmp_path / "replace_redone.pdf")
    assert_opens_everywhere(out)
    x, y = round((box.x0 + box.x1) / 2), round((box.y0 + box.y1) / 2)
    record("pixel_red_pdfium", out, page=0, x=x, y=y)


def test_round_trip_replace_keeps_the_references_of_a_shared_picture(
    open_copy: Opener, tmp_path: Path
) -> None:
    """Both pages draw the one image XObject. The replace writes into that object, so both pages
    still name it and both show the new picture (the replace is global, as on the desktop)."""
    s = open_copy("shared_objects_resources")
    (picture,) = refs(s, 0, ObjectType.IMAGE)
    centres = []
    for page in (0, 1):
        box = image_bbox(s, page)
        centres.append((round((box.x0 + box.x1) / 2), round((box.y0 + box.y1) / 2)))
    content.replace_image(s, ReplaceImage(picture, png((0, 200, 0))))
    out = s.save(tmp_path / "replaced_shared.pdf")
    assert_opens_everywhere(out)
    record("shared_xobject_pikepdf", out, pages=[0, 1], xobject="Im1", width=60)
    for page, (x, y) in enumerate(centres):
        record("pixel_green_pdfium", out, page=page, x=x, y=y)


def test_round_trip_replace_with_alpha_keeps_the_transparency(
    open_copy: Opener, tmp_path: Path
) -> None:
    s = open_copy("mixed_content")
    (picture,) = refs(s, 0, ObjectType.IMAGE)
    box = image_bbox(s)
    content.replace_image(s, ReplaceImage(picture, half_clear_png()))
    out = s.save(tmp_path / "replaced_alpha.pdf")
    assert_opens_everywhere(out)
    record("image_has_smask_pikepdf", out, page=0)
    mid_y = round((box.y0 + box.y1) / 2)
    record("pixel_green_pdfium", out, page=0, x=round(box.x1) - 15, y=mid_y)
    # The transparent half shows the page behind it (white), not the old gradient.
    record(
        "blank_region_pdfium",
        out,
        page=0,
        clip=[box.x0 + 5, box.y0 + 5, box.x0 + 25, box.y1 - 5],
    )
