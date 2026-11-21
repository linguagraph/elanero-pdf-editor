"""Bookmarks (outline), destinations and links."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from pdfeditor.model.color import Color
from pdfeditor.model.geometry import Point, Rect


@dataclass(frozen=True, slots=True)
class Destination:
    page_index: int
    point: Point | None = None  # top-left of the target view, in page space
    zoom: float | None = None


@dataclass(slots=True)
class OutlineItem:
    title: str
    dest: Destination | None = None
    uri: str | None = None
    children: list[OutlineItem] = field(default_factory=list)
    is_open: bool = False
    color: Color | None = None
    bold: bool = False
    italic: bool = False

    def walk(self, level: int = 1) -> list[tuple[int, OutlineItem]]:
        """Depth-first ``(level, item)`` pairs including self."""
        out = [(level, self)]
        for child in self.children:
            out.extend(child.walk(level + 1))
        return out


def flatten(items: list[OutlineItem]) -> list[tuple[int, OutlineItem]]:
    out: list[tuple[int, OutlineItem]] = []
    for item in items:
        out.extend(item.walk())
    return out


# An entry's path is the child index at each level, so its level is the path's length.
OutlinePath = tuple[int, ...]

# The deepest level an edit may create (W5.2). A file that is already deeper still loads and
# can be edited elsewhere; only an edit that goes deeper than this is refused.
MAX_OUTLINE_DEPTH = 32


def entries(items: list[OutlineItem]) -> list[tuple[OutlinePath, OutlineItem]]:
    """Every entry in list order (depth first), with its path. The position in this list is the
    flat index the web uses to address a bookmark. Iterative, so a deep chain cannot hit the
    recursion limit."""
    out: list[tuple[OutlinePath, OutlineItem]] = []
    stack: list[tuple[OutlinePath, OutlineItem]] = [
        ((i,), item) for i, item in reversed(list(enumerate(items)))
    ]
    while stack:
        path, item = stack.pop()
        out.append((path, item))
        stack.extend(((*path, i), child) for i, child in reversed(list(enumerate(item.children))))
    return out


def children_at(items: list[OutlineItem], parent: OutlinePath) -> list[OutlineItem]:
    """The live child list under ``parent`` (``()`` is the top level). It is the list the tree
    holds, so editing it edits the tree; the list object stays valid while siblings change."""
    level = items
    for index in parent:
        level = level[index].children
    return level


def depth(items: list[OutlineItem]) -> int:
    """The deepest level in the tree; 0 when it is empty."""
    return max((len(path) for path, _ in entries(items)), default=0)


class LinkKind(Enum):
    GOTO = "goto"  # internal page destination
    URI = "uri"
    GOTO_REMOTE = "gotor"  # another file
    LAUNCH = "launch"
    NAMED = "named"
    OTHER = "other"


@dataclass(frozen=True, slots=True)
class Link:
    rect: Rect
    kind: LinkKind
    dest: Destination | None = None
    uri: str = ""
    file: str = ""
    named: str = ""
