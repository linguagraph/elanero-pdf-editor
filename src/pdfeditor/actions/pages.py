"""Page actions: delete, move, duplicate, rotate, insert, replace, crop and labels (W1.3 §1).

Ported from the desktop's ``ui/page_ops.py``: the same Commands, the same undo labels.
"""

from __future__ import annotations

import math
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
from pdfeditor.engine.base import Document, EngineError, PasswordCallback, PasswordRequired
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


# Same limit as MAX_PASSWORD_ATTEMPTS in engine/mupdf/document.py. Not imported: that module
# imports PyMuPDF, which the actions layer must never load.
_PASSWORD_ATTEMPTS = 5


def _open_source(
    session: DocumentSession,
    data: bytes,
    password: str | None,
    password_callback: PasswordCallback | None,
) -> Document:
    """Open a source document. The callback (a modal dialog on the desktop) runs outside the
    engine lock, so background renders and jobs keep going while it is open."""
    if password_callback is None:
        with session.lock:
            return session.engine.open(data, password)
    try:
        with session.lock:
            return session.engine.open(data, None)
    except PasswordRequired:
        pass
    for attempt in range(1, _PASSWORD_ATTEMPTS + 1):
        candidate = password_callback(attempt)
        if candidate is None:
            break
        try:
            with session.lock:
                return session.engine.open(data, candidate)
        except PasswordRequired:
            continue
    raise PasswordRequired("document is password protected")


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
    source = _open_source(session, args.data, args.password, password_callback)
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
    # Refuse before opening the source, so bad input never asks for a password.
    if not chosen:
        raise Refused("Choose the pages to replace.", reason="invalid_pages")
    _check_pages(session, tuple(chosen))
    if not source_pages:
        raise Refused("Choose the source pages.", reason="invalid_source_pages")
    source = _open_source(session, args.data, args.password, password_callback)
    try:
        with session.lock:
            source_count = source.page_count
        for i in source_pages:
            if not 0 <= i < source_count:
                raise Refused(
                    f"Source page {i + 1} is not in the source document.",
                    reason="invalid_source_pages",
                )

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


# A crop narrower or shorter than this is refused: a page of under a point is never intended, and
# MuPDF would normalise an inverted box into a wrong strip (W4.11). Same value on the web.
_MIN_CROP_SIDE = 1.0


def _check_pages(session: DocumentSession, pages: tuple[int, ...]) -> None:
    with session.lock:
        count = session.page_count
    for i in pages:
        if not 0 <= i < count:
            raise Refused(f"Page {i + 1} is not in the document.", reason="invalid_pages")


def _check_crop_target(page: int, target: Rect) -> None:
    if target.width < _MIN_CROP_SIDE or target.height < _MIN_CROP_SIDE:
        raise Refused(
            f"Cropping page {page + 1} would leave less than {_MIN_CROP_SIDE:g} point.",
            reason="crop_too_large",
        )


@action("pages.crop_margins", CropMargins, requires=("page_ops",))
def crop_margins(session: DocumentSession, args: CropMargins) -> ActionResult[None]:
    ensure_idle(session)
    label = f"Crop {plural(len(args.pages))}"
    margins = (args.left, args.top, args.right, args.bottom)
    if any(not math.isfinite(m) or m < 0 for m in margins):
        raise Refused("Margins cannot be negative.", reason="invalid_margins")
    _check_pages(session, args.pages)
    if not args.pages or all(m == 0 for m in margins):
        return ActionResult(label, None, executed=False)

    # The targets are worked out before the snapshot, so an oversize margin is refused and
    # changes nothing (no undo step), rather than failing midway through the operation.
    targets: dict[int, Rect] = {}
    with session.lock:
        for i in args.pages:
            r = session.document.page(i).rect
            target = Rect(r.x0 + args.left, r.y0 + args.top, r.x1 - args.right, r.y1 - args.bottom)
            _check_crop_target(i, target)
            targets[i] = target

    def op(doc: Document) -> None:
        for i, target in targets.items():
            doc.page(i).set_crop(target)

    snapshot(session, label, op)
    return ActionResult(label, None)


@action("pages.crop_rect", CropRect, requires=("page_ops",))
def crop_rect(session: DocumentSession, args: CropRect) -> ActionResult[None]:
    ensure_idle(session)
    label = f"Crop {plural(len(args.pages))}"
    _check_pages(session, args.pages)
    if not args.pages:
        return ActionResult(label, None, executed=False)

    targets: dict[int, Rect] = {}
    with session.lock:
        for i in args.pages:
            target = args.rect.intersection(session.document.page(i).rect)
            _check_crop_target(i, target)
            targets[i] = target

    def op(doc: Document) -> None:
        for i, target in targets.items():
            doc.page(i).set_crop(target)

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


def _check_label_rules(rules: list[PageLabelRule], page_count: int) -> None:
    """Refuse a start off the document, a first number below 1, or two ranges on one start."""
    for rule in rules:
        if not 0 <= rule.start < page_count:
            raise Refused(f"Page {rule.start + 1} is not in the document.", reason="invalid_pages")
        if rule.first < 1:
            raise Refused("Start at must be 1 or more.", reason="invalid_label")
    starts = [rule.start for rule in rules]
    if len(set(starts)) != len(starts):
        raise Refused("Two label ranges start on the same page.", reason="duplicate_label_start")


@action("pages.set_labels", SetPageLabels)  # no capability flag: the desktop never checked one
def set_labels(session: DocumentSession, args: SetPageLabels) -> ActionResult[None]:
    ensure_idle(session)
    label = "Edit Page Labels"
    rules = sorted(args.rules, key=lambda rule: rule.start)
    with session.lock:
        _check_label_rules(rules, session.document.page_count)
        current = session.document.page_label_rules()
    if rules == current:
        return ActionResult(label, None, executed=False)
    execute_all(session, [SetPageLabelsCommand(rules)], label)
    return ActionResult(label, None)
