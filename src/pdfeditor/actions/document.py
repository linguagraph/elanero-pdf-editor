"""Document actions (``document.set_metadata``, ``document.set_outline``) and
``annotations.flatten`` (W1.3 §1, "Document" and the flatten row of "Comments").

``annotations.flatten`` lives here rather than in ``comments.py`` so that the comment and
document slices own separate modules (W1.3 §2).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from pdfeditor.actions import action
from pdfeditor.actions.base import ActionResult, current_name, ensure_idle, execute_all, snapshot
from pdfeditor.core.commands import SetMetadataCommand, SetOutlineCommand
from pdfeditor.core.session import DocumentSession
from pdfeditor.engine.base import Document
from pdfeditor.model.annotations import AnnotRef
from pdfeditor.model.metadata import Metadata
from pdfeditor.model.outline import OutlineItem

# -- argument types ------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class SetMetadata:
    metadata: Metadata


@dataclass(frozen=True, slots=True)
class SetOutline:
    items: tuple[OutlineItem, ...]
    label: str = ""  # the undo label; "Edit Bookmarks" when empty


@dataclass(frozen=True, slots=True)
class FlattenAnnotations:
    refs: tuple[AnnotRef, ...] | None = None  # None: every comment in the document


# -- helpers --------------------------------------------------------------------------------


def _resolve(doc: Document, refs: Sequence[AnnotRef]) -> dict[int, list[int]]:
    """The engine ids of the named comments, by page. Unknown names are skipped. A name from
    before a full save resolves to the comment's current /NM (call with the lock held)."""
    by_page: dict[int, list[int]] = {}
    for ref in refs:
        if not 0 <= ref.page < doc.page_count:
            continue
        name = current_name(doc, ref.page, ref.name)
        for model in doc.page(ref.page).annotations():
            if model.name == name:
                if model.id is not None:
                    by_page.setdefault(ref.page, []).append(model.id)
                break
    return by_page


# -- actions --------------------------------------------------------------------------------


@action("document.set_metadata", SetMetadata, requires=("metadata_write",))
def set_metadata(session: DocumentSession, args: SetMetadata) -> ActionResult[None]:
    ensure_idle(session)
    command = SetMetadataCommand(args.metadata)
    with session.lock:
        unchanged = args.metadata == session.document.metadata()
    if unchanged:
        return ActionResult(command.label, None, executed=False)
    executed = execute_all(session, [command], command.label)
    return ActionResult(command.label, None, executed)


@action("document.set_outline", SetOutline, requires=("outline_write",))
def set_outline(session: DocumentSession, args: SetOutline) -> ActionResult[None]:
    """Replace the bookmarks. Always runs: the bookmarks panel commits after every change."""
    ensure_idle(session)
    command = SetOutlineCommand(list(args.items), args.label or None)
    executed = execute_all(session, [command], command.label)
    return ActionResult(command.label, None, executed)


@action("annotations.flatten", FlattenAnnotations, requires=("annotations_flatten",), long=True)
def flatten(session: DocumentSession, args: FlattenAnnotations) -> ActionResult[int]:
    """Burn comments into their pages; the value is how many were flattened.

    ``refs`` None burns every comment, as "Flatten All Comments" always has (its confirmation
    is the desktop's, and it runs even when nothing is left to burn). Otherwise only the named
    comments go, and nothing runs when none of them can be found."""
    ensure_idle(session)
    if args.refs is None:
        label = "Flatten Comments"
        flattened = snapshot(session, label, _flatten_everything)
        return ActionResult(label, flattened)

    label = "Flatten Comment"  # singular even for several, as the desktop has always said
    with session.lock:
        by_page = _resolve(session.document, args.refs)
    if not by_page:
        return ActionResult(label, 0, executed=False)

    def op(doc: Document) -> int:
        return sum(doc.page(p).flatten_annotations(ids) for p, ids in by_page.items())

    return ActionResult(label, snapshot(session, label, op))


def _flatten_everything(doc: Document) -> int:
    return sum(doc.page(i).flatten_annotations() for i in range(doc.page_count))
