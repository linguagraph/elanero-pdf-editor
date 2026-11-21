"""Bookmark edits by flat index (W5.2 S1): results, undo, stale refusal and the round trip.

No Qt. The fixture ``outline`` has six pages and nine bookmarks, flat indices 0 to 8:

    0 Chapter 1 (p1)   1 Section 1.1 (p1)   2 Section 1.2 (p2)
    3 Chapter 2 (p3)   4 Section 2.1 (p3)   5 Section 2.2 (p4)
    6 Chapter 3 (p5)   7 Section 3.1 (p5)   8 Section 3.2 (p6)
"""

from __future__ import annotations

from pathlib import Path

import pytest

from pdfeditor.actions import REGISTRY, run
from pdfeditor.actions.base import InvalidArgs, Refused, StaleObject
from pdfeditor.actions.outline import (
    AddBookmark,
    DeleteBookmark,
    MoveBookmark,
    RenameBookmark,
    SetBookmarkDestination,
)
from pdfeditor.core.session import DocumentSession
from pdfeditor.model.outline import OutlineItem, flatten
from tests.actions.conftest import Opener
from tests.hostcheck import record

BASE = [
    (1, "Chapter 1"),
    (2, "Section 1.1"),
    (2, "Section 1.2"),
    (1, "Chapter 2"),
    (2, "Section 2.1"),
    (2, "Section 2.2"),
    (1, "Chapter 3"),
    (2, "Section 3.1"),
    (2, "Section 3.2"),
]

BUSY_CASES: dict[str, object] = {
    "outline.add": AddBookmark("Busy", 0),
    "outline.rename": RenameBookmark(0, "Chapter 1", "Busy"),
    "outline.delete": DeleteBookmark(0, "Chapter 1"),
    "outline.move": MoveBookmark(1, "Section 1.1", None, 0),
    "outline.set_destination": SetBookmarkDestination(0, "Chapter 1", 1),
}


def tree_of(session: DocumentSession) -> list[OutlineItem]:
    with session.lock:
        return session.document.outline()


def titles_of(session: DocumentSession) -> list[tuple[int, str]]:
    return [(level, item.title) for level, item in flatten(tree_of(session))]


def rows_of(session: DocumentSession) -> list[list[object]]:
    """``[level, title, page index]`` for every bookmark, the shape the host checks read."""
    return [
        [level, item.title, item.dest.page_index if item.dest else -1]
        for level, item in flatten(tree_of(session))
    ]


def close(session: DocumentSession) -> None:
    with session.lock:
        session.document.close()


# (name, args, the expected (level, title) list, the action's value)
CASES: list[tuple[str, object, list[tuple[int, str]], object]] = [
    (
        "add",
        AddBookmark("  Appendix  ", page=5, after=0),
        [*BASE[:3], (1, "Appendix"), *BASE[3:]],
        3,
    ),
    (
        "add_child",
        AddBookmark("Intro", page=0, after=0, as_child=True),
        [*BASE[:1], (2, "Intro"), *BASE[1:]],
        1,
    ),
    (
        "rename",
        RenameBookmark(3, "Chapter 2", "Part Two"),
        [*BASE[:3], (1, "Part Two"), *BASE[4:]],
        None,
    ),
    (
        "delete",
        DeleteBookmark(3, "Chapter 2"),
        BASE[:3] + BASE[6:],
        None,
    ),
    (
        "move",
        MoveBookmark(7, "Section 3.1", parent=0, position=2),
        [
            (1, "Chapter 1"),
            (2, "Section 1.1"),
            (2, "Section 1.2"),
            (2, "Section 3.1"),
            (1, "Chapter 2"),
            (2, "Section 2.1"),
            (2, "Section 2.2"),
            (1, "Chapter 3"),
            (2, "Section 3.2"),
        ],
        None,
    ),
    (
        "set_destination",
        SetBookmarkDestination(4, "Section 2.1", page=5, y=100.0),
        BASE,
        None,
    ),
]
CASE_IDS = [case[0] for case in CASES]
LABELS = {
    "add": "Add Bookmark",
    "add_child": "Add Bookmark",
    "rename": "Rename Bookmark",
    "delete": "Delete Bookmark",
    "move": "Move Bookmark",
    "set_destination": "Set Bookmark Destination",
}
NAMES = {
    "add": "outline.add",
    "add_child": "outline.add",
    "rename": "outline.rename",
    "delete": "outline.delete",
    "move": "outline.move",
    "set_destination": "outline.set_destination",
}


@pytest.mark.parametrize(("case", "args", "titles", "value"), CASES, ids=CASE_IDS)
def test_edit_then_undo_restores_the_bookmarks(
    open_copy: Opener, case: str, args: object, titles: list[tuple[int, str]], value: object
) -> None:
    s = open_copy("outline")
    before = tree_of(s)
    result = run(s, NAMES[case], args)
    assert result.label == LABELS[case] and result.executed
    assert result.value == value
    assert s.undo_stack.undo_label == LABELS[case]
    assert titles_of(s) == titles
    assert s.undo()
    assert tree_of(s) == before


@pytest.mark.parametrize(("case", "args", "titles", "value"), CASES, ids=CASE_IDS)
def test_edit_saves_and_reads_back_in_pikepdf_and_pdfium(
    open_copy: Opener,
    tmp_path: Path,
    case: str,
    args: object,
    titles: list[tuple[int, str]],
    value: object,
) -> None:
    s = open_copy("outline")
    run(s, NAMES[case], args)
    expected = rows_of(s)
    out = s.save(tmp_path / f"{case}.pdf")

    reopened = DocumentSession.open(out)
    try:
        assert titles_of(reopened) == titles
        assert rows_of(reopened) == expected
    finally:
        close(reopened)
    record("outline_pikepdf", out, expected=[[lvl, t] for lvl, t, _ in expected])
    record("outline_pdfium", out, rows=expected)
    record("page_count_pikepdf", out, pages=s.page_count)
    record("render_first_page_pdfium", out)


def test_set_destination_moves_the_page_and_point_and_clears_the_uri(open_copy: Opener) -> None:
    s = open_copy("outline")
    run(s, "outline.set_destination", SetBookmarkDestination(4, "Section 2.1", 5, 100.0))
    item = flatten(tree_of(s))[4][1]
    assert item.dest is not None and item.dest.page_index == 5
    assert item.dest.point is not None and item.dest.point.y == pytest.approx(100.0)
    assert item.uri is None


def test_add_places_the_sibling_after_the_whole_subtree(open_copy: Opener) -> None:
    s = open_copy("outline")
    run(s, "outline.add", AddBookmark("Tail", page=0, after=3))
    # Chapter 2 is index 3 and its children follow it; the sibling goes after them, not between.
    assert titles_of(s)[3:7] == [
        (1, "Chapter 2"),
        (2, "Section 2.1"),
        (2, "Section 2.2"),
        (1, "Tail"),
    ]
    assert titles_of(s)[7:] == [(1, "Chapter 3"), (2, "Section 3.1"), (2, "Section 3.2")]


def test_rename_to_the_same_title_is_a_no_op(open_copy: Opener) -> None:
    s = open_copy("outline")
    result = run(s, "outline.rename", RenameBookmark(0, "Chapter 1", "  Chapter 1 "))
    assert result.executed is False
    assert not s.undo_stack.can_undo


@pytest.mark.parametrize(
    "args",
    [
        RenameBookmark(3, "Chapter 2 (old)", "Part Two"),
        DeleteBookmark(3, "Section 1.1"),
        MoveBookmark(7, "Chapter 3", parent=0, position=0),
        SetBookmarkDestination(4, "Chapter 2", page=0),
        AddBookmark("Stale", page=0, after=3, expect_after="Chapter 2 (old)"),
    ],
    ids=["rename", "delete", "move", "set_destination", "add"],
)
def test_a_stale_position_is_refused_and_nothing_changes(open_copy: Opener, args: object) -> None:
    s = open_copy("outline")
    before = tree_of(s)
    name = {
        RenameBookmark: "outline.rename",
        DeleteBookmark: "outline.delete",
        MoveBookmark: "outline.move",
        SetBookmarkDestination: "outline.set_destination",
        AddBookmark: "outline.add",
    }[type(args)]
    with pytest.raises(StaleObject):
        run(s, name, args)
    assert tree_of(s) == before
    assert not s.undo_stack.can_undo


def test_a_move_into_its_own_subtree_is_refused(open_copy: Opener) -> None:
    s = open_copy("outline")
    with pytest.raises(InvalidArgs, match="own subtree"):
        run(s, "outline.move", MoveBookmark(0, "Chapter 1", parent=1, position=0))
    assert titles_of(s) == BASE


@pytest.mark.parametrize(
    ("name", "args"),
    [
        ("outline.add", AddBookmark("Out", page=6)),
        ("outline.add", AddBookmark("   ", page=0)),
        ("outline.add", AddBookmark("Off", page=0, after=99)),
        ("outline.add", AddBookmark("Child", page=0, as_child=True)),
        ("outline.add", AddBookmark("Infinite", page=0, after=0, y=float("inf"))),
        ("outline.rename", RenameBookmark(0, "Chapter 1", "x" * 1001)),
        ("outline.delete", DeleteBookmark(42, "Chapter 1")),
        ("outline.move", MoveBookmark(0, "Chapter 1", parent=None, position=99)),
        ("outline.set_destination", SetBookmarkDestination(0, "Chapter 1", 0, y=float("nan"))),
    ],
)
def test_bad_arguments_are_refused(open_copy: Opener, name: str, args: object) -> None:
    s = open_copy("outline")
    with pytest.raises(InvalidArgs):
        run(s, name, args)
    assert titles_of(s) == BASE
    assert not s.undo_stack.can_undo


def test_a_nesting_past_the_depth_cap_is_refused(open_copy: Opener) -> None:
    s = open_copy("outline")
    index = run(s, "outline.add", AddBookmark("Level 1", page=0)).value
    for level in range(2, 33):  # levels 2 to 32, each the first child of the one before
        child = AddBookmark(f"Level {level}", page=0, after=index, as_child=True)
        index = run(s, "outline.add", child).value
    with pytest.raises(Refused) as caught:
        run(s, "outline.add", AddBookmark("Level 33", page=0, after=index, as_child=True))
    assert caught.value.reason == "outline_too_deep"


def test_outline_actions_need_outline_write() -> None:
    for name in NAMES.values():
        assert REGISTRY[name].requires == ("outline_write",)


def test_add_with_expect_after_checks_the_entry_it_inserts_after(open_copy: Opener) -> None:
    s = open_copy("outline")
    run(s, "outline.add", AddBookmark("Matched", page=0, after=3, expect_after="Chapter 2"))
    assert titles_of(s)[6] == (1, "Matched")  # after Chapter 2 and its two sections, as before
    # Without expect_after the same add is unchanged; with it set but no ``after``, it is ignored.
    run(s, "outline.add", AddBookmark("Appended", page=0, expect_after="Anything"))
    assert titles_of(s)[-1] == (1, "Appended")


def test_add_at_a_view_offset_keeps_the_point_after_a_save(
    open_copy: Opener, tmp_path: Path
) -> None:
    s = open_copy("outline")
    index = run(s, "outline.add", AddBookmark("Mid", page=0, after=0, y=300.0)).value
    assert index == 3
    out = s.save(tmp_path / "view_offset.pdf")
    reopened = DocumentSession.open(out)
    try:
        item = flatten(tree_of(reopened))[index][1]
        assert item.dest is not None and item.dest.point is not None
        assert item.dest.point.y == pytest.approx(300.0)
    finally:
        close(reopened)
    record("outline_top_pikepdf", out, tops=[["Mid", 300.0]])
