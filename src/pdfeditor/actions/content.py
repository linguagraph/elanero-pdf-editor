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
from pdfeditor.engine.base import Document, EngineError
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
    """Raise StaleObject when a page changed since its objects were picked. Call under the lock.

    A page that no longer exists (deleted since the ref was made) is stale too.
    """
    for ref in refs:
        if not 0 <= ref.page < session.document.page_count:
            raise StaleObject(_stale_message(ref.page))
        try:
            revision = session.document.page(ref.page).revision
        except (IndexError, EngineError):
            raise StaleObject(_stale_message(ref.page)) from None
        if revision != ref.revision:
            raise StaleObject(_stale_message(ref.page))


def _check_page(session: DocumentSession, page: int) -> None:
    """Refuse a creation on a page that doesn't exist. Call under the lock."""
    if not 0 <= page < session.document.page_count:
        raise Refused(f"Page {page + 1} doesn't exist.")


_SHAPE_LABELS = {
    ShapeKind.RECTANGLE: "Add Rectangle",
    ShapeKind.ELLIPSE: "Add Ellipse",
    ShapeKind.LINE: "Add Line",
}

# The widest outline a shape may have, in points. Above it the stroke covers most of a small box.
MAX_SHAPE_WIDTH = 72.0


def _check_shape(spec: ShapeSpec) -> None:
    """Refuse a spec that would draw nothing, or an outline no one can see. The web sends untrusted
    input, and an empty box would still cost an undo snapshot. Coordinates off the page are not
    refused: a PDF may draw outside its crop box, and the web clamps before it sends."""
    if not 0 < spec.width <= MAX_SHAPE_WIDTH:
        raise Refused(f"A shape's line width must be above 0 and at most {MAX_SHAPE_WIDTH:g}.")
    if spec.kind is ShapeKind.LINE:
        if spec.start == spec.end:
            raise Refused("A line needs two different ends.")
        return
    box = spec.rect
    if box.x1 <= box.x0 or box.y1 <= box.y0:
        raise Refused("A rectangle or ellipse needs a box with area.")


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
    # One lock across the check and the edit, so nothing can change the page in between.
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
    label = "Edit Text"
    # One lock across the check and the edit, so nothing can change the page in between.
    with session.lock:
        _check_fresh(session, [ref])
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
    with session.lock:
        _check_page(session, args.page)
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
    with session.lock:
        _check_page(session, args.page)
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
    with session.lock:
        _check_page(session, args.page)
    _check_shape(args.spec)
    snapshot(session, label, lambda doc: doc.page(args.page).add_shape(args.spec))
    return ActionResult(label, None)


@action("content.delete", DeleteObjects, requires=("content_edit",))
def delete(session: DocumentSession, args: DeleteObjects) -> ActionResult[int]:
    """Delete the objects, one undo step across pages; the value is how many distinct objects
    were deleted (a key named twice is deleted once)."""
    ensure_idle(session)
    if not args.objects:
        return ActionResult("Delete 0 Objects", 0, executed=False)
    by_page: dict[int, list[str]] = {}
    for ref in args.objects:
        by_page.setdefault(ref.page, []).append(ref.key)
    unique = {page: list(dict.fromkeys(keys)) for page, keys in by_page.items()}
    count = sum(len(keys) for keys in unique.values())
    label = "Delete Object" if count == 1 else f"Delete {count} Objects"

    def op(doc: Document) -> None:
        for page, keys in unique.items():
            doc.page(page).delete_objects(keys)

    # One lock across the check and the edit, so nothing can change the page in between.
    with session.lock:
        _check_fresh(session, args.objects)
        snapshot(session, label, op)
    return ActionResult(label, count)


@action("content.replace_image", ReplaceImage, requires=("content_edit",))
def replace_image(session: DocumentSession, args: ReplaceImage) -> ActionResult[None]:
    ensure_idle(session)
    ref = args.object
    label = "Replace Image"
    # One lock across the check and the edit, so nothing can change the page in between.
    with session.lock:
        _check_fresh(session, [ref])
        snapshot(session, label, lambda doc: doc.page(ref.page).replace_image(ref.key, args.data))
    return ActionResult(label, None)
