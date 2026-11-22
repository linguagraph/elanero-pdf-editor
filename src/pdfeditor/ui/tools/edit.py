"""Content-editing tools: edit objects (select/move/resize/delete, edit text in place), add text,
add image and add shapes. Every change is one undoable step (document snapshot)."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QMouseEvent
from PySide6.QtWidgets import QFileDialog, QGraphicsView

from pdfeditor.actions import content, edit_geometry
from pdfeditor.actions.base import ActionError, ActionResult, Busy
from pdfeditor.actions.content import (
    AddImage,
    AddShape,
    AddText,
    DeleteObjects,
    ReplaceText,
    TransformObjects,
)
from pdfeditor.actions.edit_geometry import HANDLE_PX, MIN_DRAG
from pdfeditor.engine.base import EngineError, UnsupportedFeature
from pdfeditor.model.geometry import Matrix, Point, Rect
from pdfeditor.model.objects import (
    FontChoice,
    ObjectRef,
    ObjectType,
    PageObject,
    ShapeKind,
    ShapeSpec,
    TextStyle,
)
from pdfeditor.ui.dialogs.shape_style import DEFAULT_SHAPE_STYLE, ShapeStyle
from pdfeditor.ui.tools.base import Tool
from pdfeditor.ui.view.text_editor import InlineTextEditor

if TYPE_CHECKING:
    from pdfeditor.ui.view.document_view import DocumentView

DEFAULT_TEXT_STYLE = TextStyle(font="Helvetica", size=12)
# Reports to the window (status bar / message box); replaced by the window at runtime.
notify: Callable[[str], None] = lambda message: None  # noqa: E731
error: Callable[[str], None] = lambda message: None  # noqa: E731


def object_ref(view: DocumentView, page: int, key: str) -> ObjectRef:
    """The desktop always acts on what it shows, so it passes the page's current revision."""
    return ObjectRef(page, key, view.session.document.page(page).revision)


def run_edit(view: DocumentView, act: Callable[[], ActionResult[Any]]) -> bool:
    """Run a content-editing action; report refusals instead of raising."""
    try:
        result = act()
    except Busy:
        return False  # the BLOCKED event has already told the user
    except (UnsupportedFeature, EngineError, ActionError) as exc:
        error(str(exc))
        return False
    choice = result.value
    if isinstance(choice, FontChoice) and choice.substituted:
        detail = f" (missing: {choice.missing})" if choice.missing else ""
        notify(
            "The document's font can't show this text in this style; "
            f"used {choice.name} instead{detail}."
        )
    return True


def _used(view: DocumentView, ok: bool) -> None:
    """Tell the window a creation tool finished (one-shot tools go back to Select)."""
    if ok:
        view.tool_used.emit()


def _scene_rect(r: QRectF) -> Rect:
    """A scene box as the shared geometry's rectangle (resizing and handles run in scene space)."""
    return Rect(r.left(), r.top(), r.right(), r.bottom())


class EditObjectsTool(Tool):
    """Acrobat's "Edit text & images": outlines every editable object on the page."""

    name = "edit"

    def __init__(self) -> None:
        # (page, objects, press point, handle index or None)
        self._drag: tuple[int, list[PageObject], Point, int | None] | None = None
        self._matrix: Matrix | None = None
        self._marquee: tuple[int, Point] | None = None
        self.editor: InlineTextEditor | None = None

    def activate(self, view: DocumentView) -> None:
        view.setDragMode(QGraphicsView.DragMode.NoDrag)
        view.set_object_outlines(True)
        view.clear_selection()
        view.set_annotation_selection([])

    def deactivate(self, view: DocumentView) -> None:
        if self.editor is not None:
            self.editor.commit()
        view.set_object_outlines(False)
        view.set_object_selection([])
        view.set_annotation_preview({})

    # -- hit testing ----------------------------------------------------------------------
    def _handle_at(self, view: DocumentView, scene: QPointF) -> tuple[int, PageObject, int] | None:
        by_page = view.selected_object_pages()
        if sum(len(v) for v in by_page.values()) != 1:
            return None
        page, (obj,) = next(iter(by_page.items()))
        box = _scene_rect(view.page_rect_to_scene(page, obj.bbox))
        tol = HANDLE_PX / max(view.transform().m11(), 0.01)
        index = edit_geometry.handle_at(box, Point(scene.x(), scene.y()), tol)
        return None if index is None else (page, obj, index)

    # -- mouse ----------------------------------------------------------------------------
    def press(self, view: DocumentView, event: QMouseEvent) -> bool:
        if event.button() != Qt.MouseButton.LeftButton:
            return False
        scene = view.mapToScene(event.position().toPoint())
        handle = self._handle_at(view, scene)
        if handle is not None:
            page, grabbed, index = handle
            self._drag = (page, [grabbed], view.scene_to_page(page, scene), index)
            return True
        hit = view.page_point_at(scene)
        obj = view.object_at(scene)
        if obj is None or hit is None:
            if hit is not None:
                self._marquee = (hit[0], hit[1])
            if not event.modifiers() & Qt.KeyboardModifier.ControlModifier:
                view.set_object_selection([])
            return True
        page = hit[0]
        key = (page, obj.key)
        current = list(view.selected_objects)
        if event.modifiers() & Qt.KeyboardModifier.ControlModifier:
            view.set_object_selection(
                [k for k in current if k != key] if key in current else [*current, key]
            )
            return True
        if key not in current:
            view.set_object_selection([key])
        movable = [o for o in view.selected_object_pages().get(page, []) if o.editable]
        if movable:
            self._drag = (page, movable, view.scene_to_page(page, scene), None)
        return True

    def move(self, view: DocumentView, event: QMouseEvent) -> bool:
        scene = view.mapToScene(event.position().toPoint())
        if self._drag is not None:
            page, objs, start, handle = self._drag
            now = view.scene_to_page(page, scene)
            if handle is None:
                self._matrix = Matrix.translate(now.x - start.x, now.y - start.y)
            else:
                self._matrix = self._resize_matrix(view, page, objs[0], handle, scene)
            view.set_annotation_preview({page: [o.bbox.transform(self._matrix) for o in objs]})
            return True
        if self._marquee is not None:
            page, a = self._marquee
            b = view.scene_to_page(page, scene)
            view.set_annotation_preview({page: [Rect.from_points([a, b])]})
            return True
        return False

    def _resize_matrix(
        self, view: DocumentView, page: int, obj: PageObject, handle: int, scene: QPointF
    ) -> Matrix:
        box = _scene_rect(view.page_rect_to_scene(page, obj.bbox))
        scene_box = edit_geometry.resize_box(box, handle, Point(scene.x(), scene.y()))
        new = Rect.from_points(
            [
                view.scene_to_page(page, QPointF(scene_box.x0, scene_box.y0)),
                view.scene_to_page(page, QPointF(scene_box.x1, scene_box.y1)),
            ]
        )
        return edit_geometry.fit_matrix(obj.bbox, new)

    def release(self, view: DocumentView, event: QMouseEvent) -> bool:
        view.set_annotation_preview({})
        if self._drag is not None:
            page, objs, _start, handle = self._drag
            m = self._matrix
            self._drag, self._matrix = None, None
            if m is None or (abs(m.e) < 0.5 and abs(m.f) < 0.5 and m.a == 1 and m.d == 1):
                return True
            moved = [o.bbox.transform(m) for o in objs]
            refs = tuple(object_ref(view, page, o.key) for o in objs)
            if run_edit(
                view,
                lambda: content.transform(
                    view.session, TransformObjects(refs, m, resize=handle is not None)
                ),
            ):
                self._reselect(view, page, moved)
            return True
        if self._marquee is not None:
            page, a = self._marquee
            self._marquee = None
            b = view.scene_to_page(page, view.mapToScene(event.position().toPoint()))
            if not edit_geometry.is_click(a, b):
                box = Rect.from_points([a, b])
                hits = edit_geometry.objects_in(view.page_objects(page), box)
                view.set_object_selection([(page, o.key) for o in hits])
            return True
        return False

    @staticmethod
    def _reselect(view: DocumentView, page: int, boxes: list[Rect]) -> None:
        """After an edit keys change: select the objects now closest to where they went."""
        keys = edit_geometry.reselect(view.page_objects(page), boxes)
        view.set_object_selection([(page, key) for key in keys])

    def double_click(self, view: DocumentView, event: QMouseEvent) -> bool:
        scene = view.mapToScene(event.position().toPoint())
        obj = view.object_at(scene)
        hit = view.page_point_at(scene)
        if obj is None or hit is None or obj.type is not ObjectType.TEXT:
            return obj is not None
        if not obj.editable:
            error(f"This text can't be edited: {obj.reason}.")
            return True
        self.edit_text(view, hit[0], obj)
        return True

    def edit_text(self, view: DocumentView, page: int, obj: PageObject) -> None:
        style = obj.style or DEFAULT_TEXT_STYLE
        k = view.transform().m11()

        def commit(text: str, new_style: TextStyle) -> None:
            self.editor = None
            run_edit(
                view,
                lambda: content.replace_text(
                    view.session, ReplaceText(object_ref(view, page, obj.key), text, new_style)
                ),
            )

        def cancel() -> None:
            self.editor = None

        with view.session.lock:
            font_data = view.session.document.page(page).font_program(style.font)
        self.editor = InlineTextEditor(
            view.viewport(), obj.text, style, k, commit, cancel, font_data
        )
        self.editor.follow(view, page, obj.bbox)

    def hover(self, view: DocumentView, event: QMouseEvent) -> None:
        scene = view.mapToScene(event.position().toPoint())
        if self._handle_at(view, scene) is not None:
            view.viewport().setCursor(Qt.CursorShape.SizeFDiagCursor)
            return
        obj = view.object_at(scene)
        if obj is None:
            view.viewport().unsetCursor()
        elif obj.type is ObjectType.TEXT:
            view.viewport().setCursor(
                Qt.CursorShape.IBeamCursor if obj.editable else Qt.CursorShape.ForbiddenCursor
            )
        else:
            view.viewport().setCursor(Qt.CursorShape.SizeAllCursor)


class _RectTool(Tool):
    """Drag out a rectangle on one page (click for a default size, or nothing when None)."""

    default_size: tuple[float, float] | None = (200.0, 40.0)

    def __init__(self) -> None:
        self._start: tuple[int, Point] | None = None

    def activate(self, view: DocumentView) -> None:
        view.setDragMode(QGraphicsView.DragMode.NoDrag)

    def hover(self, view: DocumentView, event: QMouseEvent) -> None:
        view.viewport().setCursor(Qt.CursorShape.CrossCursor)

    def press(self, view: DocumentView, event: QMouseEvent) -> bool:
        if event.button() != Qt.MouseButton.LeftButton:
            return False
        self._start = view.page_point_at(view.mapToScene(event.position().toPoint()))
        return self._start is not None

    def move(self, view: DocumentView, event: QMouseEvent) -> bool:
        if self._start is None:
            return False
        page, a = self._start
        b = view.scene_to_page(page, view.mapToScene(event.position().toPoint()))
        view.set_annotation_preview({page: [Rect.from_points([a, b])]})
        return True

    def release(self, view: DocumentView, event: QMouseEvent) -> bool:
        if self._start is None:
            return False
        page, a = self._start
        self._start = None
        view.set_annotation_preview({})
        b = view.scene_to_page(page, view.mapToScene(event.position().toPoint()))
        if abs(b.x - a.x) < MIN_DRAG and abs(b.y - a.y) < MIN_DRAG:
            if self.default_size is None:
                return True  # nothing to add; the tool stays active for the real drag
            w, h = self.default_size
            b = Point(a.x + w, a.y + h)
        bounds = view.page_rect(page)
        rect = Rect.from_points([a, b]).intersection(bounds)
        self.finish(view, page, rect, a, b)
        return True

    def finish(self, view: DocumentView, page: int, rect: Rect, a: Point, b: Point) -> None:
        raise NotImplementedError


class AddTextTool(_RectTool):
    name = "add_text"
    last_style = DEFAULT_TEXT_STYLE  # new text boxes start with the style used last

    def press(self, view: DocumentView, event: QMouseEvent) -> bool:
        """Clicking existing text edits that paragraph instead of starting a new text box."""
        if event.button() == Qt.MouseButton.LeftButton:
            scene = view.mapToScene(event.position().toPoint())
            obj = view.object_at(scene)
            hit = view.page_point_at(scene)
            if obj is not None and hit is not None and obj.type is ObjectType.TEXT and obj.editable:
                EditObjectsTool().edit_text(view, hit[0], obj)
                return True
        return super().press(view, event)

    def __init__(self) -> None:
        super().__init__()
        self.editor: InlineTextEditor | None = None
        self.style = AddTextTool.last_style

    def deactivate(self, view: DocumentView) -> None:
        if self.editor is not None:
            self.editor.commit()

    def finish(self, view: DocumentView, page: int, rect: Rect, a: Point, b: Point) -> None:
        def commit(text: str, style: TextStyle) -> None:
            self.editor = None
            self.style = AddTextTool.last_style = style  # the next box starts like this
            if text.strip():
                _used(
                    view,
                    run_edit(
                        view,
                        lambda: content.add_text(view.session, AddText(page, rect, text, style)),
                    ),
                )

        def cancel() -> None:
            self.editor = None

        self.editor = InlineTextEditor(
            view.viewport(), "", self.style, view.transform().m11(), commit, cancel
        )
        self.editor.follow(view, page, rect)


def ask_image(view: DocumentView) -> Path | None:
    chosen, _ = QFileDialog.getOpenFileName(
        view, "Add Image", "", "Images (*.png *.jpg *.jpeg *.tif *.tiff *.bmp *.gif *.webp)"
    )
    return Path(chosen) if chosen else None


class AddImageTool(_RectTool):
    name = "add_image"
    default_size = (200.0, 150.0)

    def finish(self, view: DocumentView, page: int, rect: Rect, a: Point, b: Point) -> None:
        path = ask_image(view)
        if path is None:
            return
        data = path.read_bytes()
        _used(
            view,
            run_edit(view, lambda: content.add_image(view.session, AddImage(page, rect, data))),
        )


class AddShapeTool(_RectTool):
    # A click adds nothing: a default-size shape would be committed under the pointer and the
    # tool would drop back to Select, so the next drag moved that shape instead of drawing one.
    default_size = None
    # The style of the shapes drawn next, set by Shapes > Shape Style. It is read when a shape is
    # drawn, not when the tool is armed, so a change applies to a tool that is already active.
    style: ShapeStyle = DEFAULT_SHAPE_STYLE

    def __init__(self, kind: ShapeKind) -> None:
        super().__init__()
        self.kind = kind
        self.name = f"add_{kind.value}"

    def finish(self, view: DocumentView, page: int, rect: Rect, a: Point, b: Point) -> None:
        style = AddShapeTool.style
        spec = ShapeSpec(
            self.kind,
            rect,
            a,
            b,
            style.stroke,
            None if self.kind is ShapeKind.LINE else style.fill,
            style.width,
        )
        _used(
            view,
            run_edit(view, lambda: content.add_shape(view.session, AddShape(page, spec))),
        )


def delete_selected(view: DocumentView) -> bool:
    by_page = view.selected_object_pages()
    if not by_page:
        return False
    refs = tuple(object_ref(view, page, o.key) for page, objs in by_page.items() for o in objs)
    view.set_object_selection([])
    return run_edit(view, lambda: content.delete(view.session, DeleteObjects(refs)))
