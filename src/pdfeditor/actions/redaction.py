"""Redaction actions (``redaction.*``): mark, unmark and apply, with a leak check (W1.3 §1).

Ported from the desktop's ``ui/protect_controller.py``: the same Commands, the same undo labels.
Marks are named by their page and /NM name (:class:`MarkRef`); engine object ids stay in here.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

from pdfeditor.actions import action
from pdfeditor.actions.base import ActionResult, Refused, ensure_idle, execute_all, snapshot
from pdfeditor.core.commands import AddAnnotationCommand, Command, DeleteAnnotationsCommand
from pdfeditor.core.session import DocumentSession
from pdfeditor.engine.base import Document
from pdfeditor.model.annotations import AnnotationModel
from pdfeditor.model.geometry import Rect
from pdfeditor.model.redaction import MarkRef, RedactionArea, RedactOptions
from pdfeditor.services.redaction import (
    MarkStyle,
    VerificationReport,
    mark_areas,
    mark_for_area,
    redaction_marks,
    verify,
)

# -- argument types ------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class MarkForRedaction:
    areas: tuple[RedactionArea, ...]
    style: MarkStyle = field(default_factory=MarkStyle)
    author: str = ""
    label: str = "Mark for Redaction"


@dataclass(frozen=True, slots=True)
class RemoveRedactionMarks:
    marks: tuple[MarkRef, ...]


@dataclass(frozen=True, slots=True)
class ApplyRedactions:
    marks: tuple[MarkRef, ...] | None = None  # None: every mark in the document
    options: RedactOptions = field(default_factory=RedactOptions)


# -- helpers -------------------------------------------------------------------------------


def _chosen_marks(
    all_marks: Sequence[AnnotationModel], refs: Sequence[MarkRef]
) -> list[AnnotationModel]:
    """The marks named by ``refs``, in their order, each once. An unnamed or unknown mark is
    refused: it can't be told apart from the others."""
    by_name = {(m.page_index, m.name): m for m in all_marks if m.name}
    chosen: list[AnnotationModel] = []
    seen: set[tuple[int, str]] = set()
    for ref in refs:
        key = (ref.page, ref.name)
        mark = by_name.get(key) if ref.name else None
        if mark is None:
            raise Refused("A redaction mark to apply no longer exists.")
        if key not in seen:
            seen.add(key)
            chosen.append(mark)
    return chosen


# -- actions -------------------------------------------------------------------------------


@action("redaction.mark", MarkForRedaction, requires=("annotations_write",))
def mark(session: DocumentSession, args: MarkForRedaction) -> ActionResult[tuple[MarkRef, ...]]:
    """Add one mark per area, as one undo step; the value names the marks added."""
    ensure_idle(session)
    if not args.areas:
        return ActionResult(args.label, (), executed=False)
    commands: list[AddAnnotationCommand] = []
    for area in args.areas:
        model = mark_for_area(area.page, area.rect, args.style, args.author)
        if area.quads:
            model.quads = area.quads
        if area.text:
            model.contents = area.text
        commands.append(AddAnnotationCommand(model, args.label))
    execute_all(session, commands, args.label)
    added = tuple(MarkRef(c.model.page_index, c.model.name) for c in commands)
    return ActionResult(args.label, added)


@action("redaction.remove_marks", RemoveRedactionMarks, requires=("annotations_write",))
def remove_marks(session: DocumentSession, args: RemoveRedactionMarks) -> ActionResult[None]:
    """Delete the named marks: one undo step per page, labelled by how many pages changed."""
    ensure_idle(session)
    by_page: dict[int, list[str]] = {}
    for ref in args.marks:
        by_page.setdefault(ref.page, []).append(ref.name)
    commands: list[Command] = [
        DeleteAnnotationsCommand(page, names, "Remove Redaction Mark")
        for page, names in by_page.items()
    ]
    label = "Remove Redaction Mark" if len(commands) == 1 else "Remove Redaction Marks"
    ran = execute_all(session, commands, "Remove Redaction Marks")
    return ActionResult(label, None, executed=ran)


@action("redaction.apply", ApplyRedactions, requires=("redact",), long=True)
def apply(session: DocumentSession, args: ApplyRedactions) -> ActionResult[VerificationReport]:
    """Burn the chosen marks into the content, then check nothing readable is left under them."""
    ensure_idle(session)
    with session.lock:
        all_marks = redaction_marks(session.document)
    chosen = all_marks if args.marks is None else _chosen_marks(all_marks, args.marks)
    if not chosen:
        raise Refused("There are no redaction marks to apply.")

    areas: dict[int, list[Rect]] = {}
    by_page: dict[int, list[int]] = {}
    for m in chosen:
        areas.setdefault(m.page_index, []).extend(mark_areas(m))
        if m.id is not None:
            by_page.setdefault(m.page_index, []).append(m.id)
    selective = len(chosen) != len(all_marks)
    options = args.options

    def operation(doc: Document) -> None:
        for page, ids in by_page.items():
            doc.page(page).apply_redactions(ids if selective else None, options)

    label = "Apply Redaction" if len(chosen) == 1 else f"Apply {len(chosen)} Redactions"
    snapshot(session, label, operation)
    session.require_full_save = True
    with session.lock:
        report = verify(session.document, areas, [m.overlay_text for m in chosen])
    return ActionResult(label, report)
