"""Page actions: delete, move, duplicate, rotate, insert, replace, crop and labels (W1.3 §1).

Ported from the desktop's ``ui/page_ops.py``: the same Commands, the same undo labels.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from pdfeditor.actions import action
from pdfeditor.actions.base import (
    ActionResult,
    Refused,
    ensure_idle,
    execute_all,
    plural,
    snapshot,
)
from pdfeditor.core.commands import SetPageLabelsCommand
from pdfeditor.core.session import DocumentSession
from pdfeditor.engine.base import Document, EngineError, PasswordCallback
from pdfeditor.model.geometry import Rect
from pdfeditor.model.pages import PageLabelRule
from pdfeditor.services.assembly import IMAGE_SUFFIXES
from pdfeditor.services.stamping import trimmed_rect

# -- argument types ------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class DeletePages:
    pages: tuple[int, ...]


@dataclass(frozen=True, slots=True)
class MovePages:
    pages: tuple[int, ...]
    before: int  # in the original numbering


@dataclass(frozen=True, slots=True)
class DuplicatePages:
    pages: tuple[int, ...]


@dataclass(frozen=True, slots=True)
class RotatePages:
    pages: tuple[int, ...]
    delta: int  # degrees; 90 is "Right", 270 or -90 is "Left"


@dataclass(frozen=True, slots=True)
class InsertBlankPage:
    at: int
    like_page: int | None = None  # takes its size from this page; the page before ``at`` if None


@dataclass(frozen=True, slots=True)
class InsertFile:
    """A PDF (its pages, all or ``pages``) or an image, given as bytes: the front end reads the
    file, so the name only decides between the two."""

    data: bytes
    name: str
    at: int
    pages: tuple[int, ...] | None = None
    password: str | None = None


@dataclass(frozen=True, slots=True)
class InsertImage:
    at: int
    data: bytes
    label: str = "Insert Image"


@dataclass(frozen=True, slots=True)
class ReplacePages:
    pages: tuple[int, ...]
    data: bytes
    source_pages: tuple[int, ...]
    password: str | None = None


@dataclass(frozen=True, slots=True)
class CropMargins:
    """Points trimmed from each visible edge of every page."""

    pages: tuple[int, ...]
    left: float
    top: float
    right: float
    bottom: float


@dataclass(frozen=True, slots=True)
class CropRect:
    pages: tuple[int, ...]
    rect: Rect  # visible space, the same rectangle for every page


@dataclass(frozen=True, slots=True)
class TrimWhiteMargins:
    pages: tuple[int, ...]
    padding: float = 12.0


@dataclass(frozen=True, slots=True)
class SetPageLabels:
    rules: tuple[PageLabelRule, ...]


# -- actions -------------------------------------------------------------------------------


@action("pages.delete", DeletePages, requires=("page_ops",))
def delete(session: DocumentSession, args: DeletePages) -> ActionResult[None]:
    ensure_idle(session)
    doomed = set(args.pages)
    with session.lock:
        keep = [i for i in range(session.page_count) if i not in doomed]
    if not keep:
        raise Refused("A document must keep at least one page.")
    label = f"Delete {plural(len(doomed))}"
    snapshot(session, label, lambda doc: doc.select_pages(keep))
    return ActionResult(label, None)


@action("pages.move", MovePages, requires=("page_ops",))
def move(session: DocumentSession, args: MovePages) -> ActionResult[tuple[int, ...]]:
    """Move the pages so they sit before ``before``; the value is their new indices."""
    ensure_idle(session)
    moving = sorted(set(args.pages))
    label = f"Move {plural(len(moving))}"
    with session.lock:
        count = session.page_count
    rest = [i for i in range(count) if i not in moving]
    insert_at = sum(1 for i in rest if i < args.before)
    order = rest[:insert_at] + moving + rest[insert_at:]
    if order == list(range(count)):
        return ActionResult(label, tuple(moving), executed=False)
    snapshot(session, label, lambda doc: doc.select_pages(order))
    return ActionResult(label, tuple(range(insert_at, insert_at + len(moving))))


@action("pages.duplicate", DuplicatePages, requires=("page_ops",))
def duplicate(session: DocumentSession, args: DuplicatePages) -> ActionResult[None]:
    ensure_idle(session)
    chosen = sorted(set(args.pages))
    label = f"Duplicate {plural(len(chosen))}"
    if not chosen:
        return ActionResult(label, None, executed=False)
    with session.lock:
        count = session.page_count
    last = chosen[-1]
    order = [*range(last + 1), *chosen, *range(last + 1, count)]
    snapshot(session, label, lambda doc: doc.select_pages(order))
    return ActionResult(label, None)


@action("pages.rotate", RotatePages, requires=("page_ops",))
def rotate(session: DocumentSession, args: RotatePages) -> ActionResult[None]:
    ensure_idle(session)
    chosen = sorted(set(args.pages))

    def op(doc: Document) -> None:
        for i in chosen:
            page = doc.page(i)
            page.set_rotation((page.rotation + args.delta) % 360)

    direction = "Right" if args.delta % 360 == 90 else "Left" if args.delta % 360 == 270 else ""
    label = f"Rotate {plural(len(chosen))} {direction}".strip()
    snapshot(session, label, op)
    return ActionResult(label, None)


@action("pages.insert_blank", InsertBlankPage, requires=("page_ops",))
def insert_blank(session: DocumentSession, args: InsertBlankPage) -> ActionResult[None]:
    ensure_idle(session)
    ref_index = args.like_page if args.like_page is not None else max(0, args.at - 1)
    with session.lock:
        ref = session.document.page(ref_index).rect
    label = "Insert Blank Page"
    snapshot(session, label, lambda doc: doc.insert_blank_page(args.at, ref.width, ref.height))
    return ActionResult(label, None)


@action("pages.insert_file", InsertFile, requires=("page_ops",))
def insert_file(
    session: DocumentSession,
    args: InsertFile,
    *,
    password_callback: PasswordCallback | None = None,
) -> ActionResult[int]:
    """Insert a PDF's pages or an image; the value is how many pages were inserted.

    ``password_callback`` is for the desktop, which asks only when the file is encrypted. It is
    not part of the arguments, so the registry never passes it.
    """
    ensure_idle(session)
    if Path(args.name).suffix.lower() in IMAGE_SUFFIXES:
        label = "Insert Image"
        snapshot(session, label, lambda doc: doc.insert_image_page(args.at, args.data))
        return ActionResult(label, 1)
    password = password_callback if password_callback is not None else args.password
    with session.lock:
        source = session.engine.open(args.data, password)
    try:
        with session.lock:
            chosen = list(range(source.page_count)) if args.pages is None else list(args.pages)
        label = f"Insert {plural(len(chosen))}"
        snapshot(session, label, lambda doc: doc.insert_pages(source, chosen, args.at))
        return ActionResult(label, len(chosen))
    finally:
        with session.lock:
            source.close()


@action("pages.insert_image", InsertImage, requires=("page_ops",))
def insert_image(session: DocumentSession, args: InsertImage) -> ActionResult[None]:
    ensure_idle(session)
    snapshot(session, args.label, lambda doc: doc.insert_image_page(args.at, args.data))
    return ActionResult(args.label, None)


@action("pages.replace", ReplacePages, requires=("page_ops",))
def replace(
    session: DocumentSession,
    args: ReplacePages,
    *,
    password_callback: PasswordCallback | None = None,
) -> ActionResult[None]:
    """Replace ``pages`` (a contiguous run is typical) with ``source_pages`` of ``data``."""
    ensure_idle(session)
    chosen = sorted(set(args.pages))
    source_pages = list(args.source_pages)
    password = password_callback if password_callback is not None else args.password
    with session.lock:
        source = session.engine.open(args.data, password)
    try:

        def op(doc: Document) -> None:
            doc.insert_pages(source, source_pages, chosen[0])
            shift = len(source_pages)
            keep = [
                i
                for i in range(doc.page_count)
                if not (chosen[0] + shift <= i and (i - shift) in chosen)
            ]
            doc.select_pages(keep)

        label = f"Replace {plural(len(chosen))}"
        snapshot(session, label, op)
        return ActionResult(label, None)
    finally:
        with session.lock:
            source.close()


@action("pages.crop_margins", CropMargins, requires=("page_ops",))
def crop_margins(session: DocumentSession, args: CropMargins) -> ActionResult[None]:
    ensure_idle(session)

    def op(doc: Document) -> None:
        for i in args.pages:
            r = doc.page(i).rect
            doc.page(i).set_crop(
                Rect(r.x0 + args.left, r.y0 + args.top, r.x1 - args.right, r.y1 - args.bottom)
            )

    label = f"Crop {plural(len(args.pages))}"
    snapshot(session, label, op)
    return ActionResult(label, None)


@action("pages.crop_rect", CropRect, requires=("page_ops",))
def crop_rect(session: DocumentSession, args: CropRect) -> ActionResult[None]:
    ensure_idle(session)

    def op(doc: Document) -> None:
        for i in args.pages:
            doc.page(i).set_crop(args.rect.intersection(doc.page(i).rect))

    label = f"Crop {plural(len(args.pages))}"
    snapshot(session, label, op)
    return ActionResult(label, None)


@action("pages.trim_white_margins", TrimWhiteMargins, requires=("page_ops",), long=True)
def trim_white_margins(session: DocumentSession, args: TrimWhiteMargins) -> ActionResult[int]:
    """Crop away white margins; the value is how many pages changed."""
    ensure_idle(session)
    label = "Remove White Margins"
    targets: dict[int, Rect] = {}
    with session.lock:
        for i in args.pages:
            rect = trimmed_rect(session.document, i, args.padding)
            if rect is not None:
                targets[i] = rect
    if not targets:
        return ActionResult(label, 0, executed=False)

    def op(doc: Document) -> None:
        for i, rect in targets.items():
            try:
                doc.page(i).set_crop(rect)
            except EngineError:
                continue

    snapshot(session, label, op)
    return ActionResult(label, len(targets))


@action("pages.set_labels", SetPageLabels)  # no capability flag: the desktop never checked one
def set_labels(session: DocumentSession, args: SetPageLabels) -> ActionResult[None]:
    ensure_idle(session)
    label = "Edit Page Labels"
    rules = list(args.rules)
    with session.lock:
        current = session.document.page_label_rules()
    if rules == current:
        return ActionResult(label, None, executed=False)
    execute_all(session, [SetPageLabelsCommand(rules)], label)
    return ActionResult(label, None)
