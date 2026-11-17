"""Content-editing actions on real documents: labels, results, undo, refusals and the round-trip
rule. Each action runs through ``DocumentSession`` with no Qt. Saved files must open in pikepdf
and render in pypdfium2 (independent implementations), not only in MuPDF.
"""

from __future__ import annotations

import io
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from typing import cast

import pikepdf
import pypdfium2 as pdfium
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
from tests.actions.conftest import Opener

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


def pdfium_text(path: Path) -> str:
    pd = pdfium.PdfDocument(path)
    try:
        return pd[0].get_textpage().get_text_range()
    finally:
        pd.close()


def pdfium_pixel(path: Path, x: int, y: int) -> tuple[int, int, int]:
    """Pixel of page 0 rendered at 72 dpi, so pixel (x, y) is visible-space point (x, y)."""
    pd = pdfium.PdfDocument(path)
    try:
        image = pd[0].render(scale=1).to_pil().convert("RGB")
        r, g, b = image.getpixel((x, y))
        return int(r), int(g), int(b)
    finally:
        pd.close()


def assert_opens_everywhere(path: Path) -> None:
    """The saved file opens in pikepdf and page 0 renders in pypdfium2."""
    with pikepdf.open(path) as pdf:
        assert len(pdf.pages) >= 1
    pd = pdfium.PdfDocument(path)
    try:
        pd[0].render(scale=1).to_pil()
    finally:
        pd.close()


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
    assert "A second paragraph" in pdfium_text(out)


def test_round_trip_replace_text(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("mixed_content")
    body = refs(s, 0, ObjectType.TEXT)[1]
    content.replace_text(s, ReplaceText(body, "Edited paragraph."))
    out = s.save(tmp_path / "replaced.pdf")
    assert_opens_everywhere(out)
    assert "Edited paragraph." in pdfium_text(out)
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
    assert "Round trip text box" in pdfium_text(out)
    with reopened(out) as doc:
        found = [o.text for o in doc.page(0).content_objects() if o.type is ObjectType.TEXT]
    assert any(t.startswith("Round trip text box") for t in found)


def test_round_trip_add_image(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("text_multipage")
    content.add_image(s, AddImage(0, Rect(100, 100, 200, 200), png((0, 200, 0))))
    out = s.save(tmp_path / "added_image.pdf")
    assert_opens_everywhere(out)
    r, g, b = pdfium_pixel(out, 150, 150)
    assert g > 150 and r < 80 and b < 80
    with reopened(out) as doc:
        assert [o.type for o in doc.page(0).content_objects()].count(ObjectType.IMAGE) == 1


def test_round_trip_add_shape(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("text_multipage")
    red = Color(1, 0, 0)
    content.add_shape(
        s,
        AddShape(0, ShapeSpec(ShapeKind.RECTANGLE, Rect(100, 500, 200, 560), stroke=red, fill=red)),
    )
    out = s.save(tmp_path / "added_shape.pdf")
    assert_opens_everywhere(out)
    r, g, b = pdfium_pixel(out, 150, 530)
    assert r > 200 and g < 80 and b < 80
    with reopened(out) as doc:
        assert [o.type for o in doc.page(0).content_objects()].count(ObjectType.PATH) == 1


def test_round_trip_replace_image(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("mixed_content")
    (image,) = refs(s, 0, ObjectType.IMAGE)  # its bbox is (420, 80, 540, 180)
    content.replace_image(s, ReplaceImage(image, png((0, 200, 0))))
    out = s.save(tmp_path / "replaced_image.pdf")
    assert_opens_everywhere(out)
    r, g, b = pdfium_pixel(out, 480, 130)
    assert g > 150 and r < 80 and b < 80
    with reopened(out) as doc:
        assert [o.type for o in doc.page(0).content_objects()].count(ObjectType.IMAGE) == 1


def test_round_trip_delete(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("mixed_content")
    heading = refs(s, 0, ObjectType.TEXT)[0]
    content.delete(s, DeleteObjects((heading,)))
    out = s.save(tmp_path / "deleted.pdf")
    assert_opens_everywhere(out)
    assert "Mixed content heading" not in pdfium_text(out)
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
