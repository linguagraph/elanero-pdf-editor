"""Comment actions on real documents: results, labels, undo, refusals, and the round-trip rule.

No Qt. The fixture ``annotations`` has six comments named ``fitz-A0`` to ``fitz-A5`` (a highlight,
a sticky note, a text box, a square, an ink stroke and a line). Saved files must open in pikepdf
and render in pypdfium2 (independent implementations), not only in MuPDF.
"""

from __future__ import annotations

import dataclasses
import shutil
from pathlib import Path

import pytest

from pdfeditor.actions import comments
from pdfeditor.actions.base import Busy, Refused, StaleObject
from pdfeditor.actions.comments import (
    AddAnnotations,
    DeleteAnnotations,
    ImportXfdf,
    PasteAnnotations,
    ReorderAnnotation,
    ReplyToAnnotation,
    RestyleAnnotations,
    SetAnnotationText,
    StyleField,
    TransformAnnotations,
    restyle_args,
)
from pdfeditor.core.commands import UpdateAnnotationCommand
from pdfeditor.core.commands.snapshot import SnapshotCommand
from pdfeditor.core.session import DocumentSession
from pdfeditor.model.annotations import (
    AnnotationModel,
    AnnotationType,
    AnnotRef,
    ReviewState,
    is_synthetic_name,
)
from pdfeditor.model.color import Color
from pdfeditor.model.geometry import Matrix, Point, Rect
from pdfeditor.services.xfdf import MAX_XFDF_BYTES, XfdfTooLarge, export_xfdf
from tests.actions.conftest import Opener, pretend_signed
from tests.hostcheck import record

# One minimal value per action; the Busy test in test_registry.py runs each one.
BUSY_CASES: dict[str, object] = {
    "annotations.add": AddAnnotations((), "Add Drawing"),
    "annotations.paste": PasteAnnotations((), 0),
    "annotations.transform": TransformAnnotations((), Matrix.identity(), False),
    "annotations.restyle": RestyleAnnotations((), StyleField.OPACITY, "Change Opacity"),
    "annotations.set_text": SetAnnotationText(AnnotRef(0, "fitz-A1"), "Edited"),
    "annotations.reply": ReplyToAnnotation(AnnotRef(0, "fitz-A1"), "Agreed", "Reviewer"),
    "annotations.reorder": ReorderAnnotation(AnnotRef(0, "fitz-A1"), True),
    "annotations.delete": DeleteAnnotations(()),
    "annotations.import_xfdf": ImportXfdf("<xfdf/>"),
}


# -- helpers --------------------------------------------------------------------------------


def ref(name: str, page: int = 0) -> AnnotRef:
    return AnnotRef(page, name)


def find(session: DocumentSession, name: str, page: int = 0) -> AnnotationModel:
    with session.lock:
        return next(a for a in session.document.page(page).annotations() if a.name == name)


TIGHT = 0.01  # points: the drift allowed for every comment type


def slack(model: AnnotationModel) -> float:
    return TIGHT


def state(session: DocumentSession, page: int = 0) -> list[tuple[object, ...]]:
    """Every comment on ``page`` as (name, contents, rect, color, opacity, slack), by name."""
    with session.lock:
        out = [
            (
                a.name,
                a.contents,
                (a.rect.x0, a.rect.y0, a.rect.x1, a.rect.y1),
                a.color,
                a.opacity,
                slack(a),
            )
            for a in session.document.page(page).annotations()
        ]
    return sorted(out, key=lambda row: str(row[0]))


def z_order(session: DocumentSession, page: int = 0) -> list[str]:
    with session.lock:
        p = session.document.page(page)
        names = {a.id: a.name for a in p.annotations()}
        return [names[i] for i in p.annotation_order() if i in names]


SQUARE_RECT = Rect(100, 500, 160, 540)


def new_square(rect: Rect = SQUARE_RECT, page: int = 0) -> AnnotationModel:
    return AnnotationModel(
        AnnotationType.SQUARE, page, rect, color=Color(0, 0, 1), border_width=1.5, contents="Box"
    )


def assert_rect(actual: Rect, expected: Rect, tol: float = TIGHT) -> None:
    got = (actual.x0, actual.y0, actual.x1, actual.y1)
    want = (expected.x0, expected.y0, expected.x1, expected.y1)
    assert got == pytest.approx(want, abs=tol)


def assert_same(actual: list[tuple[object, ...]], expected: list[tuple[object, ...]]) -> None:
    """Same comments with the same text and style; each rect within its row's slack."""
    assert [(r[0], r[1], r[3], r[4]) for r in actual] == [
        (r[0], r[1], r[3], r[4]) for r in expected
    ]
    for got, want in zip(actual, expected, strict=True):
        assert got[2] == pytest.approx(want[2], abs=want[5])


def assert_reads_everywhere(path: Path, pages: int) -> None:
    """The saved file opens in pikepdf and renders page 1 in pypdfium2."""
    record("page_count_pikepdf", path, pages=pages)
    record("page_count_pdfium", path, pages=pages)
    record("render_first_page_pdfium", path)


def reopen(path: Path) -> DocumentSession:
    return DocumentSession.open(path)


def close(session: DocumentSession) -> None:
    with session.lock:
        session.document.close()


# -- argument types -------------------------------------------------------------------------


def test_annot_ref_is_frozen_and_hashable() -> None:
    one = AnnotRef(0, "fitz-A0")
    assert {one: 1}[AnnotRef(0, "fitz-A0")] == 1
    with pytest.raises(dataclasses.FrozenInstanceError):
        one.page = 1  # type: ignore[misc]


def test_restyle_args_puts_the_value_in_its_slot() -> None:
    refs = (ref("fitz-A0"),)
    assert restyle_args(refs, "color", Color(0, 1, 0), "x").color == Color(0, 1, 0)
    assert restyle_args(refs, "fill", None, "x").color is None
    assert restyle_args(refs, "opacity", 0.5, "x").number == 0.5
    assert restyle_args(refs, "contents", "hi", "x").text == "hi"
    assert restyle_args(refs, "locked", True, "x").flag is True
    assert restyle_args(refs, "opacity", 1, "x", merge_key="k").merge_key == "k"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("color", 0.5),  # a number for a color
        ("opacity", Color(1, 0, 0)),  # a color for a number
        ("opacity", True),  # a bool is not a number here
        ("contents", 3),  # a number for text
        ("locked", "yes"),  # text for a flag
    ],
)
def test_restyle_args_rejects_the_wrong_kind(field: str, value: object) -> None:
    with pytest.raises(TypeError):
        restyle_args((ref("fitz-A0"),), field, value, "x")


# -- add and paste --------------------------------------------------------------------------


def test_add_one_comment(open_copy: Opener) -> None:
    s = open_copy("annotations")
    before = state(s)
    result = comments.add(s, AddAnnotations((new_square(),), "Add Drawing"))
    assert result.executed and result.label == "Add Drawing"
    assert len(result.value) == 1 and result.value[0].page == 0
    assert find(s, result.value[0].name).type is AnnotationType.SQUARE
    assert s.undo_stack.undo_label == "Add Drawing"
    assert len(state(s)) == len(before) + 1
    assert s.undo()
    assert_same(state(s), before)


def test_add_several_is_one_undo_step(open_copy: Opener) -> None:
    s = open_copy("annotations")
    before = state(s)
    models = (new_square(Rect(100, 500, 160, 540)), new_square(Rect(200, 500, 260, 540)))
    result = comments.add(s, AddAnnotations(models, "Add Drawing"))
    assert len(result.value) == 2 and len({r.name for r in result.value}) == 2
    assert s.undo_stack.undo_label == "Add Drawing"
    assert s.undo()
    assert not s.undo_stack.can_undo
    assert_same(state(s), before)


def test_add_nothing_is_not_executed(open_copy: Opener) -> None:
    s = open_copy("annotations")
    result = comments.add(s, AddAnnotations((), "Add Drawing"))
    assert not result.executed and result.value == ()
    assert not s.undo_stack.can_undo


def test_paste_keeps_an_off_page_comment_on_the_page(open_copy: Opener) -> None:
    s = open_copy("annotations")
    before = state(s)
    far = new_square(Rect(2000, 2000, 2050, 2030))
    result = comments.paste(s, PasteAnnotations((far,), 0))
    assert result.executed and result.label == "Paste Comment"
    pasted = find(s, result.value[0].name)
    # 12 pt offset, then moved onto the page origin plus 20 pt.
    assert pasted.rect.x0 == pytest.approx(20, abs=0.01)
    assert pasted.rect.y0 == pytest.approx(20, abs=0.01)
    assert s.undo_stack.undo_label == "Paste Comment"
    assert s.undo()
    assert_same(state(s), before)


def test_paste_in_page_offsets_by_12_and_resets_identity(open_copy: Opener) -> None:
    s = open_copy("annotations")
    source = find(s, "fitz-A0")  # a highlight: exact geometry, no square slack
    result = comments.paste(s, PasteAnnotations((source,), 0))
    pasted = find(s, result.value[0].name)
    assert_rect(pasted.rect, source.rect.translated(12, 12))
    assert pasted.name not in ("", "fitz-A0")  # a new /NM name, not the source's
    assert pasted.id != source.id  # the engine gave it a new object
    assert pasted.in_reply_to is None
    assert source.name == "fitz-A0"  # the caller's model is not mutated


def test_paste_a_reply_detaches_it_from_its_parent(open_copy: Opener) -> None:
    s = open_copy("annotations")
    reply = comments.reply(s, ReplyToAnnotation(ref("fitz-A1"), "Agreed", "Reviewer")).value
    reply_model = find(s, reply.name)
    assert reply_model.in_reply_to is not None
    comments.paste(s, PasteAnnotations((reply_model,), 0))
    pasted = [a for a in state_models(s) if a.contents == "Agreed" and a.name != reply.name]
    assert len(pasted) == 1 and pasted[0].in_reply_to is None


def state_models(session: DocumentSession, page: int = 0) -> list[AnnotationModel]:
    with session.lock:
        return list(session.document.page(page).annotations())


def test_paste_several_uses_the_plural_label(open_copy: Opener) -> None:
    s = open_copy("annotations")
    models = (new_square(Rect(100, 500, 160, 540)), new_square(Rect(200, 500, 260, 540)))
    result = comments.paste(s, PasteAnnotations(models, 0))
    assert result.label == "Paste Comments" and len(result.value) == 2
    assert s.undo_stack.undo_label == "Paste Comments"


# -- move, resize, restyle ------------------------------------------------------------------


def test_transform_move(open_copy: Opener) -> None:
    s = open_copy("annotations")
    before = find(s, "fitz-A3")
    result = comments.transform(
        s, TransformAnnotations((ref("fitz-A3"),), Matrix.translate(10, 20), False)
    )
    assert result.executed and result.label == "Move Comment" and result.value is None
    assert_rect(find(s, "fitz-A3").rect, before.rect.translated(10, 20), slack(before))
    assert s.undo_stack.undo_label == "Move Comment"
    assert s.undo()
    assert_rect(find(s, "fitz-A3").rect, before.rect, slack(before))


def test_transform_nudges_with_one_merge_key_are_one_undo_step(open_copy: Opener) -> None:
    """Held arrow keys send one transform per press under one key: undo takes them all back."""
    s = open_copy("annotations")
    before = find(s, "fitz-A3").rect
    for _ in range(3):
        comments.transform(
            s,
            TransformAnnotations(
                (ref("fitz-A3"),), Matrix.translate(1, 0), False, "nudge:0:fitz-A3"
            ),
        )
    assert_rect(find(s, "fitz-A3").rect, before.translated(3, 0), slack(find(s, "fitz-A3")))
    assert s.undo()
    assert_rect(find(s, "fitz-A3").rect, before, slack(find(s, "fitz-A3")))


def test_transform_of_a_missing_comment_changes_nothing(open_copy: Opener) -> None:
    s = open_copy("annotations")
    before = state(s)
    with pytest.raises(StaleObject):
        comments.transform(
            s,
            TransformAnnotations(
                (ref("fitz-A3"), ref("no-such-comment")), Matrix.translate(5, 5), False
            ),
        )
    assert_same(state(s), before)


def test_transform_highlight_and_ink_undo_is_exact(open_copy: Opener) -> None:
    s = open_copy("annotations")
    before = state(s)
    highlight, ink = find(s, "fitz-A0"), find(s, "fitz-A4")
    comments.transform(
        s, TransformAnnotations((ref("fitz-A0"), ref("fitz-A4")), Matrix.translate(10, 20), False)
    )
    assert_rect(find(s, "fitz-A0").rect, highlight.rect.translated(10, 20))
    assert_rect(find(s, "fitz-A4").rect, ink.rect.translated(10, 20))
    assert s.undo()
    assert_same(state(s), before)
    restored = find(s, "fitz-A4")
    for got, want in zip(restored.ink, ink.ink, strict=True):
        for p, q in zip(got, want, strict=True):
            assert (p.x, p.y) == pytest.approx((q.x, q.y), abs=TIGHT)


def test_transform_a_single_highlight_undo_is_exact(open_copy: Opener) -> None:
    s = open_copy("annotations")
    before = find(s, "fitz-A0")
    comments.transform(s, TransformAnnotations((ref("fitz-A0"),), Matrix.translate(10, 20), False))
    assert_rect(find(s, "fitz-A0").rect, before.rect.translated(10, 20))
    assert s.undo()
    assert_rect(find(s, "fitz-A0").rect, before.rect)


def test_resize_a_callout_keeps_its_leader_target(open_copy: Opener) -> None:
    from pdfeditor.model.annotations import callout_line

    s = open_copy("annotations")
    tip, box = Point(20, 300), Rect(100, 150, 300, 200)
    callout = AnnotationModel(
        AnnotationType.FREE_TEXT,
        0,
        box,
        contents="Callout",
        vertices=callout_line(tip, box),
    )
    added = comments.add(s, AddAnnotations((callout,), "Add Callout")).value[0]
    before = find(s, added.name)
    scale = Matrix.scale(2, 2)
    comments.transform(s, TransformAnnotations((added,), scale, True))
    after = find(s, added.name)
    # the tip (vertex 0) stays where it was; only the box follows the resize
    assert (after.vertices[0].x, after.vertices[0].y) == pytest.approx((tip.x, tip.y), abs=0.01)
    assert len(after.vertices) == len(before.vertices)
    assert_rect(after.rect, before.rect.transform(scale))
    assert s.undo_stack.undo_label == "Resize Comment"


def test_restyle_color_on_a_text_box_changes_its_text(open_copy: Opener) -> None:
    s = open_copy("annotations")
    before = find(s, "fitz-A2")
    result = comments.restyle(
        s, restyle_args((ref("fitz-A2"),), "color", Color(0, 0, 1), "Change Color")
    )
    assert result.executed and result.value == (ref("fitz-A2"),)
    after = find(s, "fitz-A2")
    assert after.text_color == Color(0, 0, 1)
    assert after.color == before.color
    assert s.undo()
    assert find(s, "fitz-A2").text_color == before.text_color


def test_restyle_fill_to_none_clears_the_stored_fill(open_copy: Opener) -> None:
    s = open_copy("annotations")
    comments.restyle(s, restyle_args((ref("fitz-A3"),), "fill", Color(1, 1, 0), "Change Fill"))
    comments.restyle(s, restyle_args((ref("fitz-A3"),), "fill", None, "Change Fill"))
    assert find(s, "fitz-A3").fill is None  # fails today: MuPDF keeps the old interior color


def test_restyle_fill_to_none_builds_a_command_with_no_fill(open_copy: Opener) -> None:
    s = open_copy("annotations")
    comments.restyle(s, restyle_args((ref("fitz-A3"),), "fill", Color(1, 1, 0), "Change Fill"))
    result = comments.restyle(s, restyle_args((ref("fitz-A3"),), "fill", None, "Change Fill"))
    assert result.executed and result.value == (ref("fitz-A3"),)
    assert s.undo_stack.undo_label == "Change Fill"
    top = s.undo_stack.top
    assert isinstance(top, UpdateAnnotationCommand)
    assert top.after.fill is None  # the step the undo stack holds carries the right model


def test_restyle_skips_a_locked_comment(open_copy: Opener) -> None:
    s = open_copy("annotations")
    comments.restyle(s, restyle_args((ref("fitz-A3"),), "locked", True, "Lock Comment"))
    locked_before = find(s, "fitz-A3")
    result = comments.restyle(
        s,
        restyle_args((ref("fitz-A0"), ref("fitz-A3")), "color", Color(0, 1, 0), "Change Color"),
    )
    assert result.value == (ref("fitz-A0"),)
    assert find(s, "fitz-A0").color == Color(0, 1, 0)
    assert find(s, "fitz-A3").color == locked_before.color


def test_restyle_nothing_to_change_is_not_executed(open_copy: Opener) -> None:
    s = open_copy("annotations")
    result = comments.restyle(s, restyle_args((ref("fitz-A0"),), "opacity", 1.0, "Change Opacity"))
    assert not result.executed and result.value == ()
    assert not s.undo_stack.can_undo


def test_restyle_merge_key_is_one_undo_step(open_copy: Opener) -> None:
    s = open_copy("annotations")
    key = "inspector:opacity"
    comments.restyle(
        s, restyle_args((ref("fitz-A0"),), "opacity", 0.5, "Change Opacity", merge_key=key)
    )
    comments.restyle(
        s, restyle_args((ref("fitz-A0"),), "opacity", 0.4, "Change Opacity", merge_key=key)
    )
    assert find(s, "fitz-A0").opacity == pytest.approx(0.4)
    assert s.undo()
    assert find(s, "fitz-A0").opacity == pytest.approx(1.0)
    assert not s.undo_stack.can_undo


# -- comments without /NM (issue #168) ------------------------------------------------------


def unnamed_names(session: DocumentSession, page: int = 0) -> list[str]:
    with session.lock:
        return [a.name for a in session.document.page(page).annotations()]


def test_set_text_on_the_second_unnamed_comment_changes_only_that_one(open_copy: Opener) -> None:
    s = open_copy("annotations_unnamed")
    first, second, third = unnamed_names(s)
    before = state(s)
    result = comments.set_text(s, SetAnnotationText(ref(second), "Edited"))
    assert result.executed
    assert find(s, second).contents == "Edited"
    assert find(s, first).contents == "Box one" and find(s, third).contents == "Note three"
    assert s.undo()
    assert_same(state(s), before)


def test_restyle_the_second_unnamed_comment_changes_only_that_one(open_copy: Opener) -> None:
    s = open_copy("annotations_unnamed")
    first, second, third = unnamed_names(s)
    before = {n: find(s, n) for n in (first, second, third)}
    result = comments.restyle(
        s, restyle_args((ref(second),), "color", Color(0, 1, 0), "Change Color")
    )
    assert result.executed and result.value == (ref(second),)
    assert find(s, second).color == Color(0, 1, 0)
    assert find(s, first).color == before[first].color
    assert find(s, third).color == before[third].color
    assert s.undo()
    assert find(s, second).color == before[second].color


def test_delete_the_second_unnamed_comment_and_undo_brings_it_back(open_copy: Opener) -> None:
    s = open_copy("annotations_unnamed")
    first, second, third = unnamed_names(s)
    before = state(s)
    result = comments.delete(s, DeleteAnnotations((ref(second),)))
    assert result.executed
    assert unnamed_names(s) == [first, third]
    assert s.undo()
    restored = [n for n in unnamed_names(s) if n not in (first, third)]
    assert len(restored) == 1 and restored[0].startswith("pdfeditor-")  # a real /NM now
    assert sorted(c[1] for c in state(s)) == sorted(c[1] for c in before)
    # the restored comment is addressable by its name again
    assert comments.set_text(s, SetAnnotationText(ref(restored[0]), "Back")).executed
    assert find(s, restored[0]).contents == "Back"


def test_undo_redo_cycles_keep_the_restored_comment_addressable(
    open_copy: Opener, tmp_path: Path
) -> None:
    """Delete the second unnamed comment, then undo/redo, then save and reopen: every name is
    distinct, none is a backend name, and the restored comment is found on each step."""
    s = open_copy("annotations_unnamed")
    first, second, third = unnamed_names(s)
    assert comments.delete(s, DeleteAnnotations((ref(second),))).executed
    assert s.undo()
    restored = next(n for n in unnamed_names(s) if n not in (first, third))
    assert s.redo()
    assert unnamed_names(s) == [first, third]
    assert s.undo()
    restored = next(n for n in unnamed_names(s) if n not in (first, third))
    assert comments.set_text(s, SetAnnotationText(ref(restored), "Once")).executed
    assert s.undo()  # the set_text goes; the restored comment stays
    assert find(s, restored).contents == "Box two"

    path = tmp_path / "saved.pdf"
    s.save(path)  # the open_copy session is closed by its fixture
    reopened = reopen(path)
    names = unnamed_names(reopened)
    assert len(names) == 3 and len(set(names)) == 3
    # a full save gives every comment a real /NM, so none is addressed by object number any more
    edited = next(a for a in reopened.document.page(0).annotations() if a.contents == "Box two")
    assert edited.name.startswith("pdfeditor-") and not is_synthetic_name(edited.name)
    assert_reads_everywhere(path, reopened.page_count)
    close(reopened)
    record("no_prefixed_names_pikepdf", path, prefix="#")


def test_undo_redo_of_a_delete_with_a_reply_keeps_both_linked(open_copy: Opener) -> None:
    s = open_copy("annotations_unnamed")
    parent_name = unnamed_names(s)[0]  # "Box one"
    assert comments.reply(s, ReplyToAnnotation(ref(parent_name), "Agreed", "Reviewer")).executed
    assert comments.delete(s, DeleteAnnotations((ref(parent_name),))).executed  # reply goes too
    for step in ("undo", "redo", "undo"):
        assert getattr(s, step)()
    with s.lock:
        models = s.document.page(0).annotations()
    parent = next(a for a in models if a.contents == "Box one")
    replies = [a for a in models if a.contents == "Agreed"]
    assert len(replies) == 1 and replies[0].in_reply_to == parent.id
    assert not is_synthetic_name(parent.name)


def test_xfdf_round_trip_of_unnamed_comments_writes_no_backend_names(
    open_copy: Opener, tmp_path: Path
) -> None:
    src = open_copy("annotations_unnamed")
    first = unnamed_names(src)[0]
    assert comments.reply(src, ReplyToAnnotation(ref(first), "Agreed", "Reviewer")).executed
    with src.lock:
        text = export_xfdf(src.document)
    assert 'name="#' not in text and 'inreplyto="#' not in text

    dst = open_copy("annotations_unnamed")
    with dst.lock:
        before_ids = {a.id for a in dst.document.page(0).annotations()}
    assert comments.import_xfdf(dst, ImportXfdf(text)).executed
    with dst.lock:
        models = dst.document.page(0).annotations()
    imported = [a for a in models if a.id not in before_ids]
    assert len(imported) == 4  # three comments and the reply
    assert len({a.name for a in models}) == len(models)  # every name distinct
    assert not any(is_synthetic_name(a.name) for a in imported)
    parent = next(a for a in imported if a.contents == "Box one")
    replies = [a for a in imported if a.contents == "Agreed"]
    assert len(replies) == 1 and replies[0].in_reply_to == parent.id

    out = tmp_path / "imported.pdf"
    dst.save(out)  # the open_copy session is closed by its fixture
    record("names_present_none_prefixed_pikepdf", out, prefix="#")
    assert_reads_everywhere(out, 2)


def test_undo_of_an_earlier_edit_finds_the_comment_a_delete_restored(open_copy: Opener) -> None:
    """An edit made before a delete keeps the comment's old synthetic name on the undo stack; the
    delete's undo re-creates the comment under a real name, and undoing the edit must still
    find it."""
    s = open_copy("annotations_unnamed")
    second = unnamed_names(s)[1]
    assert comments.set_text(s, SetAnnotationText(ref(second), "Edited")).executed
    assert comments.delete(s, DeleteAnnotations((ref(second),))).executed
    assert s.undo()
    assert s.undo()  # the edit, found through the name it had when it was made
    assert sorted(c[1] for c in state(s)) == ["Box one", "Box two", "Note three"]
    assert s.redo() and s.redo()
    assert sorted(a.contents for a in _page0(s)) == ["Box one", "Note three"]


def test_redo_of_a_reply_finds_its_parent_after_the_parent_was_restored(
    open_copy: Opener,
) -> None:
    s = open_copy("annotations_unnamed")
    parent = unnamed_names(s)[0]
    assert comments.reply(s, ReplyToAnnotation(ref(parent), "Agreed", "Reviewer")).executed
    assert comments.delete(s, DeleteAnnotations((ref(parent),))).executed  # parent and reply
    assert s.undo()  # both back; the parent has a real name now
    assert s.undo()  # the reply goes
    assert s.redo()  # the reply comes back, its parent is found by the name it was made with
    replies = [a for a in _page0(s) if a.contents == "Agreed"]
    parent_model = next(a for a in _page0(s) if a.contents == "Box one")
    assert len(replies) == 1 and replies[0].in_reply_to == parent_model.id


def _page0(session: DocumentSession) -> list[AnnotationModel]:
    with session.lock:
        return session.document.page(0).annotations()


# -- names across snapshots, saves and literal names (issue #168 follow-up) ----------------


def _contents(session: DocumentSession, page: int = 0) -> list[str]:
    with session.lock:
        return sorted(a.contents for a in session.document.page(page).annotations())


def test_snapshot_undo_then_delete_of_a_live_unnamed_comment_works(open_copy: Opener) -> None:
    """A snapshot edit, a delete of the second unnamed comment, both undone: the comment is
    unnamed again, so its name must resolve to itself, not to the name its undo gave it."""
    s = open_copy("annotations_unnamed")
    second = unnamed_names(s)[1]
    assert s.execute(SnapshotCommand("Edit", lambda d: None, s.snapshots))
    assert comments.delete(s, DeleteAnnotations((ref(second),))).executed
    assert s.undo() and s.undo()
    assert _contents(s) == ["Box one", "Box two", "Note three"]
    assert s.redo() and s.redo()  # the snapshot again, then the delete
    assert _contents(s) == ["Box one", "Note three"]
    assert s.undo() and s.undo()
    assert comments.delete(s, DeleteAnnotations((ref(second),))).executed
    assert _contents(s) == ["Box one", "Note three"]


def test_reply_after_snapshot_undo_links_to_the_live_comment(open_copy: Opener) -> None:
    s = open_copy("annotations_unnamed")
    second = unnamed_names(s)[1]
    assert s.execute(SnapshotCommand("Edit", lambda d: None, s.snapshots))
    assert comments.delete(s, DeleteAnnotations((ref(second),))).executed
    assert s.undo() and s.undo()
    assert comments.reply(s, ReplyToAnnotation(ref(second), "hi", "me")).executed
    with s.lock:
        models = s.document.page(0).annotations()
    target = next(a for a in models if a.contents == "Box two")
    reply = next(a for a in models if a.contents == "hi")
    assert reply.in_reply_to == target.id


def test_edit_before_a_full_save_undoes_and_redoes_after_it(open_copy: Opener) -> None:
    """A full save names every unnamed comment in the file; an edit made before the save still
    undoes onto the right comment, and redo works too."""
    s = open_copy("annotations_unnamed")
    second = unnamed_names(s)[1]
    assert comments.set_text(s, SetAnnotationText(ref(second), "Edited")).executed
    s.save()  # in place: a full save (no signatures)
    with s.lock:
        names_after = [a.name for a in s.document.page(0).annotations()]
    assert all(n.startswith("pdfeditor-") for n in names_after)
    assert _contents(s) == ["Box one", "Edited", "Note three"]
    assert s.undo()
    assert _contents(s) == ["Box one", "Box two", "Note three"]
    assert s.redo()
    assert _contents(s) == ["Box one", "Edited", "Note three"]


def test_full_save_gives_every_comment_a_real_name_in_the_file(
    open_copy: Opener, tmp_path: Path
) -> None:
    s = open_copy("annotations_unnamed")
    out = tmp_path / "named.pdf"
    s.save(out)
    record("comment_names_unique_pikepdf", out, count=3, avoid_prefix="#")
    assert_reads_everywhere(out, s.page_count)


def test_delete_then_full_save_then_undo_restores_the_right_comment(open_copy: Opener) -> None:
    s = open_copy("annotations_unnamed")
    second = unnamed_names(s)[1]
    assert comments.delete(s, DeleteAnnotations((ref(second),))).executed
    s.save()
    assert s.undo()
    assert _contents(s) == ["Box one", "Box two", "Note three"]
    restored = next(a.name for a in s.document.page(0).annotations() if a.contents == "Box two")
    assert comments.set_text(s, SetAnnotationText(ref(restored), "Again")).executed
    assert _contents(s) == ["Again", "Box one", "Note three"]  # sorted


def test_incremental_save_adds_no_names(open_copy: Opener, monkeypatch: pytest.MonkeyPatch) -> None:
    """A signed-looking document saved in place takes the incremental path, which must not give
    the unnamed comments names (their object numbers don't change there)."""
    s = open_copy("annotations_unnamed")
    pretend_signed(s, monkeypatch)
    before = s.path.read_bytes()
    s.save()
    assert s.path.read_bytes().startswith(before)  # appended, not rewritten
    record("comments_lack_names_pikepdf", s.path)
    with s.lock:
        assert all(a.name.startswith("#") for a in s.document.page(0).annotations())


def test_literal_hash_name_from_a_file_stays_addressable(fixture_pdf, tmp_path: Path) -> None:
    """A file whose /NM is literally "#123" keeps that name: find() checks /NM first."""
    path = tmp_path / "literal.pdf"
    shutil.copy2(fixture_pdf("comments_literal_hash_nm"), path)
    s = DocumentSession.open(path)
    try:
        assert "#123" in unnamed_names(s)
        assert comments.set_text(s, SetAnnotationText(ref("#123"), "Literal")).executed
        assert "Literal" in _contents(s)
    finally:
        with s.lock:
            s.document.close()


# -- text, replies, order -------------------------------------------------------------------


def test_set_text_unchanged_is_not_executed(open_copy: Opener) -> None:
    s = open_copy("annotations")
    result = comments.set_text(s, SetAnnotationText(ref("fitz-A1"), "A sticky note"))
    assert not result.executed
    assert not s.undo_stack.can_undo


def test_set_text_changes_and_undoes(open_copy: Opener) -> None:
    s = open_copy("annotations")
    before = state(s)
    result = comments.set_text(s, SetAnnotationText(ref("fitz-A1"), "Reworded"))
    assert result.executed and result.label == "Edit Comment Text"
    assert find(s, "fitz-A1").contents == "Reworded"
    assert s.undo()
    assert_same(state(s), before)


def test_set_text_refuses_a_locked_comment(open_copy: Opener) -> None:
    s = open_copy("annotations")
    comments.restyle(s, restyle_args((ref("fitz-A3"),), "locked", True, "Lock Comment"))
    with pytest.raises(Refused, match=r"This comment is locked."):
        comments.set_text(s, SetAnnotationText(ref("fitz-A3"), "Nope"))


def test_reply_then_status_reply(open_copy: Opener) -> None:
    s = open_copy("annotations")
    parent = find(s, "fitz-A1")
    reply = comments.reply(s, ReplyToAnnotation(ref("fitz-A1"), "Agreed", "Reviewer"))
    assert reply.label == "Reply" and reply.executed
    child = find(s, reply.value.name)
    assert child.in_reply_to == parent.id
    assert child.contents == "Agreed" and child.author == "Reviewer"
    assert s.undo_stack.undo_label == "Reply"

    status = comments.reply(
        s, ReplyToAnnotation(ref("fitz-A1"), "", "Reviewer", ReviewState.ACCEPTED)
    )
    assert status.label == "Set Status Accepted"
    status_child = find(s, status.value.name)
    assert status_child.state is ReviewState.ACCEPTED
    assert status_child.in_reply_to == parent.id
    assert s.undo()
    assert s.undo()
    assert reply.value.name not in {row[0] for row in state(s)}


def test_reorder_front_and_back(open_copy: Opener) -> None:
    s = open_copy("annotations")
    before = z_order(s)
    result = comments.reorder(s, ReorderAnnotation(ref("fitz-A0"), True))
    assert result.label == "Bring to Front"
    assert z_order(s)[-1] == "fitz-A0"
    assert s.undo()
    assert z_order(s) == before

    result = comments.reorder(s, ReorderAnnotation(ref("fitz-A5"), False))
    assert result.label == "Send to Back"
    assert z_order(s)[0] == "fitz-A5"
    assert s.undo()
    assert z_order(s) == before


# -- delete ---------------------------------------------------------------------------------


def test_delete_takes_the_reply_and_undo_brings_both_back(open_copy: Opener) -> None:
    s = open_copy("annotations")
    reply = comments.reply(s, ReplyToAnnotation(ref("fitz-A1"), "Agreed", "Reviewer")).value
    before_state = state(s)
    before_order = z_order(s)
    result = comments.delete(s, DeleteAnnotations((ref("fitz-A1"),)))
    assert result.executed and result.label == "Delete Comment"
    names = {row[0] for row in state(s)}
    assert "fitz-A1" not in names and reply.name not in names
    assert s.undo()
    assert_same(state(s), before_state)
    assert z_order(s) == before_order
    restored_parent = find(s, "fitz-A1")
    assert find(s, reply.name).in_reply_to == restored_parent.id


def test_delete_two_comments_on_one_page_says_comments(open_copy: Opener) -> None:
    s = open_copy("annotations")
    before = state(s)
    result = comments.delete(s, DeleteAnnotations((ref("fitz-A0"), ref("fitz-A3"))))
    assert result.label == "Delete Comments"
    assert s.undo_stack.undo_label == "Delete Comments"
    assert s.undo()
    assert_same(state(s), before)


def test_delete_skips_a_locked_comment_and_refuses_when_none_is_left(open_copy: Opener) -> None:
    s = open_copy("annotations")
    comments.restyle(s, restyle_args((ref("fitz-A0"),), "locked", True, "Lock Comment"))
    before = state(s)
    assert not comments.delete(s, DeleteAnnotations((ref("fitz-A0"),))).executed
    assert_same(state(s), before)
    # the unlocked comment in the same call is still deleted
    mixed = comments.delete(s, DeleteAnnotations((ref("fitz-A0"), ref("fitz-A3"))))
    assert mixed.executed and mixed.label == "Delete Comment"
    names = {row[0] for row in state(s)}
    assert "fitz-A0" in names and "fitz-A3" not in names


def test_delete_nothing_is_not_executed(open_copy: Opener) -> None:
    s = open_copy("annotations")
    result = comments.delete(s, DeleteAnnotations(()))
    assert not result.executed
    assert not s.undo_stack.can_undo


def test_stale_comment_is_refused(open_copy: Opener) -> None:
    s = open_copy("annotations")
    comments.delete(s, DeleteAnnotations((ref("fitz-A0"),)))
    with pytest.raises(StaleObject, match="fitz-A0 on page 1 no longer exists"):
        comments.set_text(s, SetAnnotationText(ref("fitz-A0"), "late"))
    with pytest.raises(StaleObject):
        comments.reorder(s, ReorderAnnotation(ref("fitz-A0"), True))
    with pytest.raises(StaleObject):
        comments.transform(s, TransformAnnotations((ref("fitz-A0"),), Matrix.identity(), False))


# -- import ---------------------------------------------------------------------------------


def test_import_xfdf_adds_comments_and_never_duplicates_names(open_copy: Opener) -> None:
    s = open_copy("annotations")
    with s.lock:
        text = export_xfdf(s.document, s.display_name)
    before = len(state(s))
    first = comments.import_xfdf(s, ImportXfdf(text))
    assert first.executed and first.label.startswith("Import ")
    assert first.value > 0
    assert len(state(s)) == before + first.value
    second = comments.import_xfdf(s, ImportXfdf(text))
    assert second.value == first.value
    names = [row[0] for row in state(s)]
    assert len(names) == len(set(names))


def test_import_with_no_comments_is_not_executed(open_copy: Opener) -> None:
    s = open_copy("annotations")
    empty = '<?xml version="1.0" encoding="UTF-8"?><xfdf xmlns="http://ns.adobe.com/xfdf/"/>'
    result = comments.import_xfdf(s, ImportXfdf(empty))
    assert not result.executed and result.value == 0
    assert not s.undo_stack.can_undo


@pytest.mark.parametrize(
    "text",
    [
        "<xfdf",  # malformed XML
        '<?xml version="1.0"?><!DOCTYPE xfdf [<!ENTITY a "b">]><xfdf/>',  # a DOCTYPE
        "<html/>",  # well-formed, but not XFDF
    ],
)
def test_import_refuses_what_is_not_xfdf(open_copy: Opener, text: str) -> None:
    s = open_copy("annotations")
    before = state(s)
    with pytest.raises(Refused, match="not valid XFDF") as info:
        comments.import_xfdf(s, ImportXfdf(text))
    assert info.value.code == "REFUSED"
    assert info.value.__cause__ is not None  # the parser's reason is kept on the cause
    assert state(s) == before
    assert not s.undo_stack.can_undo


def test_import_of_an_over_size_file_is_refused_and_changes_nothing(open_copy: Opener) -> None:
    s = open_copy("annotations")
    before = state(s)
    with pytest.raises(Refused, match="too large to import") as info:
        comments.import_xfdf(s, ImportXfdf("x" * (MAX_XFDF_BYTES + 1)))
    assert info.value.code == "REFUSED"
    assert isinstance(info.value.__cause__, XfdfTooLarge)  # the size check, before any parse
    assert state(s) == before
    assert not s.undo_stack.can_undo


# -- busy -----------------------------------------------------------------------------------


def test_busy_is_raised_before_any_change(open_copy: Opener) -> None:
    s = open_copy("annotations")
    s.begin_task("OCR")
    try:
        with pytest.raises(Busy, match="OCR"):
            comments.delete(s, DeleteAnnotations((ref("fitz-A0"),)))
    finally:
        s.end_task("OCR")
    assert not s.undo_stack.can_undo


# -- round trip: edit, save, reopen, assert, then the independent readers -------------------


def test_round_trip_comment_edits(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("annotations")
    added = comments.add(s, AddAnnotations((new_square(),), "Add Drawing")).value[0]
    comments.restyle(s, restyle_args((ref("fitz-A0"),), "color", Color(0, 1, 0), "Change Color"))
    reply = comments.reply(s, ReplyToAnnotation(ref("fitz-A1"), "Agreed", "Reviewer")).value
    comments.delete(s, DeleteAnnotations((ref("fitz-A5"),)))
    with s.lock:
        text = export_xfdf(s.document, s.display_name)
    comments.import_xfdf(s, ImportXfdf(text))

    out = s.save(tmp_path / "edited.pdf")
    reopened = reopen(out)
    try:
        with reopened.lock:
            names = {a.name for a in reopened.document.page(0).annotations()}
        assert added.name in names and reply.name in names and "fitz-A5" not in names
        assert find(reopened, "fitz-A0").color == Color(0, 1, 0)
        kept_on_page = len(names)
    finally:
        close(reopened)
    record("comment_count_pikepdf", out, count=kept_on_page)
    assert_reads_everywhere(out, s.page_count)
