"""Bookmark edits for the web: add, rename, delete, move and set destination (W5.2 slice S1).

Each action addresses a bookmark by its flat index (its place in the depth-first list) and
checks ``expect_title``, so an out-of-date panel gets ``STALE_OBJECT`` instead of editing the
wrong entry. The edit runs on a copy of the tree and is committed as one ``SetOutlineCommand``,
so it has a real undo. The desktop keeps using ``document.set_outline`` with the whole tree.
"""

from __future__ import annotations

import copy
import math
from collections.abc import Callable
from dataclasses import dataclass
from typing import TypeVar

from pdfeditor.actions import action
from pdfeditor.actions.base import (
    ActionResult,
    InvalidArgs,
    Refused,
    StaleObject,
    ensure_idle,
    execute_all,
)
from pdfeditor.core.commands import SetOutlineCommand
from pdfeditor.core.session import DocumentSession
from pdfeditor.model.geometry import Point
from pdfeditor.model.outline import (
    MAX_OUTLINE_DEPTH,
    Destination,
    OutlineItem,
    OutlinePath,
    children_at,
    depth,
    entries,
)

T = TypeVar("T")
MAX_TITLE = 1000  # characters, after strip


# -- argument types ------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class AddBookmark:
    title: str
    page: int
    y: float | None = None  # points from the page top; None is the top of the page
    after: int | None = None  # flat index to insert after; None appends at the top level
    as_child: bool = False  # make it the first child of ``after`` instead of its next sibling


@dataclass(frozen=True, slots=True)
class RenameBookmark:
    index: int
    expect_title: str
    title: str


@dataclass(frozen=True, slots=True)
class DeleteBookmark:
    index: int
    expect_title: str  # removes the entry and its whole subtree


@dataclass(frozen=True, slots=True)
class MoveBookmark:
    index: int
    expect_title: str
    parent: int | None  # flat index of the new parent, read before the move; None is the top
    position: int  # the child slot under ``parent``, counted after the entry has left


@dataclass(frozen=True, slots=True)
class SetBookmarkDestination:
    index: int
    expect_title: str
    page: int
    y: float | None = None


# -- helpers --------------------------------------------------------------------------------


def _clean_title(title: str) -> str:
    stripped = title.strip()
    if not stripped or len(stripped) > MAX_TITLE:
        raise InvalidArgs(f"A bookmark title needs 1 to {MAX_TITLE} characters.")
    return stripped


def _check_page(page: int, pages: int) -> None:
    if not 0 <= page < pages:
        raise InvalidArgs(f"Page {page + 1} is not in the document.")


def _destination(page: int, y: float | None) -> Destination:
    if y is not None and not math.isfinite(y):
        raise InvalidArgs("The bookmark's y position must be a finite number.")
    return Destination(page, Point(0.0, y) if y is not None else None)


def _path_at(tree: list[OutlineItem], index: int) -> tuple[OutlinePath, OutlineItem]:
    found = entries(tree)
    if not 0 <= index < len(found):
        raise InvalidArgs(f"There is no bookmark at index {index}.")
    return found[index]


def _entry(
    tree: list[OutlineItem], index: int, expect_title: str
) -> tuple[OutlinePath, OutlineItem]:
    path, item = _path_at(tree, index)
    if item.title != expect_title:
        raise StaleObject("The bookmarks changed since they were read. Reload them.")
    return path, item


def _edit(
    session: DocumentSession, label: str, change: Callable[[list[OutlineItem], int], T]
) -> ActionResult[T]:
    """Apply ``change`` to a copy of the bookmarks and commit it as one undo step.

    ``change`` gets the copy and the page count and edits the copy in place. Nothing runs when
    the tree comes out the same, which is how a no-op rename reports ``executed=False``.
    """
    ensure_idle(session)
    with session.lock:
        doc = session.document
        old = doc.outline()
        pages = doc.page_count
    tree = copy.deepcopy(old)
    value = change(tree, pages)
    new_depth = depth(tree)
    if new_depth > MAX_OUTLINE_DEPTH and new_depth > depth(old):
        raise Refused(
            f"The bookmarks would be nested deeper than {MAX_OUTLINE_DEPTH} levels.",
            reason="outline_too_deep",
        )
    if tree == old:
        return ActionResult(label, value, executed=False)
    executed = execute_all(session, [SetOutlineCommand(tree, label)], label)
    return ActionResult(label, value, executed)


# -- actions --------------------------------------------------------------------------------


@action("outline.add", AddBookmark, requires=("outline_write",))
def add_bookmark(session: DocumentSession, args: AddBookmark) -> ActionResult[int]:
    """Insert a bookmark. The value is its flat index, so the panel can focus it."""
    title = _clean_title(args.title)

    def change(tree: list[OutlineItem], pages: int) -> int:
        _check_page(args.page, pages)
        item = OutlineItem(title, dest=_destination(args.page, args.y))
        if args.after is None:
            if args.as_child:
                raise InvalidArgs("A child bookmark needs a bookmark to be a child of.")
            tree.append(item)
            new_path: OutlinePath = (len(tree) - 1,)
        else:
            after_path, _ = _path_at(tree, args.after)
            if args.as_child:
                children_at(tree, after_path).insert(0, item)
                new_path = (*after_path, 0)
            else:
                # Next sibling: placed after the whole subtree, since children sit inside it.
                parent = after_path[:-1]
                slot = after_path[-1] + 1
                children_at(tree, parent).insert(slot, item)
                new_path = (*parent, slot)
        return next(i for i, (path, _) in enumerate(entries(tree)) if path == new_path)

    return _edit(session, "Add Bookmark", change)


@action("outline.rename", RenameBookmark, requires=("outline_write",))
def rename_bookmark(session: DocumentSession, args: RenameBookmark) -> ActionResult[None]:
    title = _clean_title(args.title)

    def change(tree: list[OutlineItem], pages: int) -> None:
        _, item = _entry(tree, args.index, args.expect_title)
        item.title = title

    return _edit(session, "Rename Bookmark", change)


@action("outline.delete", DeleteBookmark, requires=("outline_write",))
def delete_bookmark(session: DocumentSession, args: DeleteBookmark) -> ActionResult[None]:
    def change(tree: list[OutlineItem], pages: int) -> None:
        path, _ = _entry(tree, args.index, args.expect_title)
        children_at(tree, path[:-1]).pop(path[-1])

    return _edit(session, "Delete Bookmark", change)


@action("outline.move", MoveBookmark, requires=("outline_write",))
def move_bookmark(session: DocumentSession, args: MoveBookmark) -> ActionResult[None]:
    def change(tree: list[OutlineItem], pages: int) -> None:
        path, item = _entry(tree, args.index, args.expect_title)
        parent: OutlinePath = () if args.parent is None else _path_at(tree, args.parent)[0]
        if parent[: len(path)] == path:
            raise InvalidArgs("A bookmark cannot be moved into its own subtree.")
        # The target list is the tree's own list, so it stays valid while the entry leaves.
        target = children_at(tree, parent)
        children_at(tree, path[:-1]).pop(path[-1])
        if not 0 <= args.position <= len(target):
            raise InvalidArgs(f"Position {args.position} is outside the list.")
        target.insert(args.position, item)

    return _edit(session, "Move Bookmark", change)


@action("outline.set_destination", SetBookmarkDestination, requires=("outline_write",))
def set_bookmark_destination(
    session: DocumentSession, args: SetBookmarkDestination
) -> ActionResult[None]:
    def change(tree: list[OutlineItem], pages: int) -> None:
        _check_page(args.page, pages)
        dest = _destination(args.page, args.y)
        _, item = _entry(tree, args.index, args.expect_title)
        item.dest = dest
        item.uri = None  # a bookmark is either a page or a link, never both

    return _edit(session, "Set Bookmark Destination", change)
