"""Content-editing actions (``content.*``): move, resize, edit text, add text, image and shapes,
delete objects and replace images (W1.3 §1).

Ported from the desktop's ``ui/tools/edit.py`` and ``ui/edit_controller.py``: the same Commands,
the same undo labels. Object refs carry the page revision they were picked at, so a web client
acting on a page that changed since then gets ``StaleObject`` instead of editing the wrong object.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from pdfeditor.actions import action
from pdfeditor.actions.base import (
    ActionResult,
    Refused,
    StaleObject,
    ensure_idle,
    snapshot,
)
from pdfeditor.core.session import DocumentSession
from pdfeditor.engine.base import Document
from pdfeditor.model.geometry import Matrix, Rect
from pdfeditor.model.objects import (
    FontChoice,
    ObjectRef,
    ObjectType,
    ShapeKind,
    ShapeSpec,
    TextStyle,
)
from pdfeditor.model.pages import ImageStamp

# -- argument types ------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class TransformObjects:
    """Move (or resize) objects on one page by ``matrix``, in visible page space."""

    objects: tuple[ObjectRef, ...]
    matrix: Matrix
    resize: bool = False


@dataclass(frozen=True, slots=True)
class ReplaceText:
    object: ObjectRef
    text: str
    style: TextStyle | None = None


@dataclass(frozen=True, slots=True)
class AddText:
    page: int
    rect: Rect
    text: str
    style: TextStyle


@dataclass(frozen=True, slots=True)
class AddImage:
    page: int
    rect: Rect
    data: bytes


@dataclass(frozen=True, slots=True)
class AddShape:
    page: int
    spec: ShapeSpec


@dataclass(frozen=True, slots=True)
class DeleteObjects:
    objects: tuple[ObjectRef, ...]


@dataclass(frozen=True, slots=True)
class ReplaceImage:
    object: ObjectRef
    data: bytes


# -- helpers -------------------------------------------------------------------------------


def _stale_message(page: int) -> str:
    return f"Page {page + 1} changed after the object was selected. Select it again."


def _check_fresh(session: DocumentSession, refs: Sequence[ObjectRef]) -> None:
    """Raise StaleObject when a page changed since its objects were picked. Call under the lock."""
    for ref in refs:
        if session.document.page(ref.page).revision != ref.revision:
            raise StaleObject(_stale_message(ref.page))


_SHAPE_LABELS = {
    ShapeKind.RECTANGLE: "Add Rectangle",
    ShapeKind.ELLIPSE: "Add Ellipse",
    ShapeKind.LINE: "Add Line",
}


# -- actions -------------------------------------------------------------------------------


@action("content.transform", TransformObjects, requires=("content_edit",))
def transform(session: DocumentSession, args: TransformObjects) -> ActionResult[None]:
    ensure_idle(session)
    verb = "Resize" if args.resize else "Move"
    if not args.objects:
        return ActionResult(f"{verb} Object", None, executed=False)
    pages = {ref.page for ref in args.objects}
    if len(pages) > 1:
        raise Refused("Objects on different pages can't be moved together.")
    (page,) = pages
    keys = [ref.key for ref in args.objects]
    with session.lock:
        _check_fresh(session, args.objects)
        types = {obj.key: obj.type for obj in session.document.page(page).content_objects()}
    if any(key not in types for key in keys):
        raise StaleObject(_stale_message(page))
    what = "Text" if all(types[key] is ObjectType.TEXT for key in keys) else "Object"
    label = f"{verb} {what}"
    snapshot(session, label, lambda doc: doc.page(page).transform_objects(keys, args.matrix))
    return ActionResult(label, None)


@action("content.replace_text", ReplaceText, requires=("content_edit",))
def replace_text(session: DocumentSession, args: ReplaceText) -> ActionResult[FontChoice | None]:
    ensure_idle(session)
    ref = args.object
    with session.lock:
        _check_fresh(session, [ref])
    label = "Edit Text"
    choice = snapshot(
        session,
        label,
        lambda doc: doc.page(ref.page).replace_text(ref.key, args.text, args.style),
    )
    return ActionResult(label, choice)


@action("content.add_text", AddText, requires=("content_edit",))
def add_text(session: DocumentSession, args: AddText) -> ActionResult[FontChoice | None]:
    ensure_idle(session)
    label = "Add Text"
    if not args.text.strip():
        return ActionResult(label, None, executed=False)
    choice = snapshot(
        session,
        label,
        lambda doc: doc.page(args.page).add_text(args.rect, args.text, args.style),
    )
    return ActionResult(label, choice)


@action("content.add_image", AddImage, requires=("content_edit",))
def add_image(session: DocumentSession, args: AddImage) -> ActionResult[None]:
    ensure_idle(session)
    label = "Add Image"
    snapshot(
        session,
        label,
        lambda doc: doc.page(args.page).stamp_image(ImageStamp(args.data, args.rect)),
    )
    return ActionResult(label, None)


@action("content.add_shape", AddShape, requires=("content_edit",))
def add_shape(session: DocumentSession, args: AddShape) -> ActionResult[None]:
    ensure_idle(session)
    label = _SHAPE_LABELS[args.spec.kind]
    snapshot(session, label, lambda doc: doc.page(args.page).add_shape(args.spec))
    return ActionResult(label, None)


@action("content.delete", DeleteObjects, requires=("content_edit",))
def delete(session: DocumentSession, args: DeleteObjects) -> ActionResult[int]:
    """Delete the objects, one undo step across pages; the value is how many were named."""
    ensure_idle(session)
    count = len(args.objects)
    label = "Delete Object" if count == 1 else f"Delete {count} Objects"
    if not args.objects:
        return ActionResult(label, 0, executed=False)
    with session.lock:
        _check_fresh(session, args.objects)
    by_page: dict[int, list[str]] = {}
    for ref in args.objects:
        by_page.setdefault(ref.page, []).append(ref.key)

    def op(doc: Document) -> None:
        for page, keys in by_page.items():
            doc.page(page).delete_objects(keys)

    snapshot(session, label, op)
    return ActionResult(label, count)


@action("content.replace_image", ReplaceImage, requires=("content_edit",))
def replace_image(session: DocumentSession, args: ReplaceImage) -> ActionResult[None]:
    ensure_idle(session)
    ref = args.object
    with session.lock:
        _check_fresh(session, [ref])
    label = "Replace Image"
    snapshot(session, label, lambda doc: doc.page(ref.page).replace_image(ref.key, args.data))
    return ActionResult(label, None)
