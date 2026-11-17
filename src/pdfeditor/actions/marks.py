"""Page-mark actions (``marks.*``): headers and footers, Bates numbers, watermarks, backgrounds
and removing them (W1.3 §1, "Page marks").

Ported from the desktop's ``ui/organize.py``: the same SnapshotCommand per change, the same
undo labels. The specs travel as the services' dataclasses (``HeaderFooter``, ``Watermark``), so
the settings each mark stores are rebuilt exactly as the dialog produced them. An action never
changes the spec it is given.
"""

from __future__ import annotations

from dataclasses import dataclass

from pdfeditor.actions import action
from pdfeditor.actions.base import ActionResult, ensure_idle, snapshot
from pdfeditor.core.session import DocumentSession
from pdfeditor.engine.base import Document
from pdfeditor.model.color import Color
from pdfeditor.model.pages import MarkKind
from pdfeditor.services import stamping
from pdfeditor.services.stamping import (
    MARK_NAMES,
    HeaderFooter,
    Watermark,
    apply_background,
    apply_header_footer,
    apply_watermark,
)

# -- argument types ------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class AddHeaderFooter:
    spec: HeaderFooter
    pages: tuple[int, ...]
    file_name: str = ""  # for <<file>>
    bates: bool = False  # Bates numbers are their own kind of mark
    replace_existing: bool = False  # "Update": remove the marks of this kind first


@dataclass(frozen=True, slots=True)
class AddWatermark:
    spec: Watermark
    pages: tuple[int, ...]
    replace_existing: bool = False


@dataclass(frozen=True, slots=True)
class AddBackground:
    color: Color
    opacity: float
    pages: tuple[int, ...]
    replace_existing: bool = False


@dataclass(frozen=True, slots=True)
class RemoveMarks:
    kind: MarkKind


# -- helpers --------------------------------------------------------------------------------


def _label(kind: MarkKind, replace_existing: bool) -> str:
    verb = "Update" if replace_existing else "Add"
    return f"{verb} {MARK_NAMES[kind]}"


# -- actions --------------------------------------------------------------------------------


@action("marks.header_footer", AddHeaderFooter, requires=("page_ops",), long=True)
def header_footer(session: DocumentSession, args: AddHeaderFooter) -> ActionResult[int]:
    """Stamp header/footer text (or Bates numbers); the value is how many text items were drawn."""
    ensure_idle(session)
    kind = MarkKind.BATES if args.bates else MarkKind.HEADER_FOOTER
    label = _label(kind, args.replace_existing)
    if not args.pages or not any(args.spec.texts.values()):
        return ActionResult(label, 0, executed=False)
    engine = session.engine

    def op(doc: Document) -> int:
        if args.replace_existing:
            stamping.remove_marks(engine, doc, [kind])
        return apply_header_footer(engine, doc, args.spec, list(args.pages), args.file_name, kind)

    return ActionResult(label, snapshot(session, label, op))


@action("marks.watermark", AddWatermark, requires=("page_ops",), long=True)
def watermark(session: DocumentSession, args: AddWatermark) -> ActionResult[None]:
    ensure_idle(session)
    label = _label(MarkKind.WATERMARK, args.replace_existing)
    if not args.pages:
        return ActionResult(label, None, executed=False)
    engine = session.engine

    def op(doc: Document) -> None:
        if args.replace_existing:
            stamping.remove_marks(engine, doc, [MarkKind.WATERMARK])
        apply_watermark(engine, doc, args.spec, list(args.pages))

    snapshot(session, label, op)
    return ActionResult(label, None)


@action("marks.background", AddBackground, requires=("page_ops",), long=True)
def background(session: DocumentSession, args: AddBackground) -> ActionResult[None]:
    ensure_idle(session)
    label = _label(MarkKind.BACKGROUND, args.replace_existing)
    if not args.pages:
        return ActionResult(label, None, executed=False)
    engine = session.engine

    def op(doc: Document) -> None:
        if args.replace_existing:
            stamping.remove_marks(engine, doc, [MarkKind.BACKGROUND])
        apply_background(doc, args.color, list(args.pages), args.opacity, engine)

    snapshot(session, label, op)
    return ActionResult(label, None)


@action("marks.remove", RemoveMarks, requires=("page_marks",), long=True)
def remove(session: DocumentSession, args: RemoveMarks) -> ActionResult[int]:
    """Remove every mark of the kind; the value is how many marked sections were removed."""
    ensure_idle(session)
    label = f"Remove {MARK_NAMES[args.kind]}"
    with session.lock:
        found = stamping.find_marks(session.engine, session.document, [args.kind])
    if args.kind not in found:
        return ActionResult(label, 0, executed=False)
    engine = session.engine
    removed = snapshot(session, label, lambda doc: stamping.remove_marks(engine, doc, [args.kind]))
    return ActionResult(label, removed)
