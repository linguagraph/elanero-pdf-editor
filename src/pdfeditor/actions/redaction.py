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

UNKNOWN_MARK = "A redaction mark to apply no longer exists."
UNNAMED_MARK = (
    "Some of the selected marks come from another application and can't be applied one at a "
    "time. Choose “All redaction marks” instead."
)
DUPLICATE_NAME = "Two redaction marks share a name; apply all marks instead."

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
    """The marks named by ``refs``, in their order, each once.

    Refused when a name is empty, when it matches no mark, or when two marks on the page share it
    (the name can't pick one). The engine names a mark that has no /NM from its object number, so
    an empty name is only a caller's mistake; the refusal stays as the guard for that.
    """
    by_name: dict[tuple[int, str], list[AnnotationModel]] = {}
    for m in all_marks:
        if m.name:
            by_name.setdefault((m.page_index, m.name), []).append(m)
    chosen: list[AnnotationModel] = []
    seen: set[tuple[int, str]] = set()
    for ref in refs:
        key = (ref.page, ref.name)
        if not ref.name:
            raise Refused(UNNAMED_MARK)
        found = by_name.get(key, [])
        if not found:
            raise Refused(UNKNOWN_MARK)
        if len(found) > 1:
            raise Refused(DUPLICATE_NAME)
        if key not in seen:
            seen.add(key)
            chosen.append(found[0])
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
    execute_all(session, commands, args.label)  # raises Busy if the command didn't land
    added = tuple(MarkRef(c.model.page_index, c.model.name) for c in commands)
    return ActionResult(args.label, added)


@action("redaction.remove_marks", RemoveRedactionMarks, requires=("annotations_write",))
def remove_marks(session: DocumentSession, args: RemoveRedactionMarks) -> ActionResult[None]:
    """Delete the named marks: one undo step per page, labelled by how many pages changed.

    A name that matches no mark is ignored (it was removed already), so a stale selection
    doesn't push an empty undo step.
    """
    ensure_idle(session)
    with session.lock:
        present = {(m.page_index, m.name) for m in redaction_marks(session.document) if m.name}
    by_page: dict[int, dict[str, None]] = {}  # ordered sets: first-seen order per page
    for ref in args.marks:
        if (ref.page, ref.name) in present:
            by_page.setdefault(ref.page, {})[ref.name] = None
    commands: list[Command] = [
        DeleteAnnotationsCommand(page, list(names), "Remove Redaction Mark")
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
    for m in chosen:
        areas.setdefault(m.page_index, []).extend(mark_areas(m))
    selective = len(chosen) != len(all_marks)
    # the marks to burn, by (page, name); None when every mark is wanted
    wanted = None if args.marks is None else {(m.page_index, m.name) for m in chosen}
    options = args.options

    def operation(doc: Document) -> None:
        # Engine ids are read here, under the same lock as the apply, so they match the marks
        # the apply touches. Nothing is refused in here: the checks above have already run.
        ids_by_page: dict[int, list[int]] = {}
        for m in redaction_marks(doc):
            if wanted is not None and (m.page_index, m.name) not in wanted:
                continue
            if m.id is not None:
                ids_by_page.setdefault(m.page_index, []).append(m.id)
        for page, ids in ids_by_page.items():
            doc.page(page).apply_redactions(ids if selective else None, options)

    label = "Apply Redaction" if len(chosen) == 1 else f"Apply {len(chosen)} Redactions"
    snapshot(session, label, operation)
    session.require_full_save = True
    with session.lock:
        report = verify(session.document, areas, [m.overlay_text for m in chosen])
    return ActionResult(label, report)
