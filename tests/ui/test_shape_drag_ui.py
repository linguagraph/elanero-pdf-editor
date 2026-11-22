"""Shape tools in Edit mode: the drag preview must stay on screen and the committed shape must
match the drag (issue #601)."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from PySide6.QtCore import QPoint, Qt

from pdfeditor.model.geometry import Point, Rect
from pdfeditor.model.objects import ObjectType
from pdfeditor.ui.main_window import MainWindow

pytestmark = [pytest.mark.gui, pytest.mark.desktop_only]

SHAPE_TOOLS = ("add_rectangle", "add_ellipse", "add_line")
TOL = 2.0  # points: the stroke widens the committed path's bounding box a little


@pytest.fixture
def window(qtbot):
    w = MainWindow()
    w.resize(1200, 900)
    w.show()
    qtbot.waitExposed(w)
    yield w
    for view in w.views():
        view.session.undo_stack.set_clean()
    w.close()
    w.deleteLater()


@pytest.fixture
def view(window: MainWindow, fixture_pdf, tmp_path: Path):
    path = tmp_path / "doc.pdf"
    shutil.copy2(fixture_pdf("mixed_content"), path)
    v = window.open_path(path)
    v.set_zoom(1.0)
    v.go_to_page(0, record=False)
    return v


def vp(view, x: float, y: float) -> QPoint:
    return view.mapFromScene(view.page_point_to_scene(0, Point(x, y)))


def page_pt(view, pos: QPoint) -> Point:
    point = view.page_point_at(view.mapToScene(pos))
    assert point is not None
    return point[1]


def path_boxes(view) -> list[Rect]:
    return [o.bbox for o in view.page_objects(0) if o.type is ObjectType.PATH]


def close(r: Rect, expected: Rect, tol: float = TOL) -> bool:
    return (
        abs(r.x0 - expected.x0) <= tol
        and abs(r.y0 - expected.y0) <= tol
        and abs(r.x1 - expected.x1) <= tol
        and abs(r.y1 - expected.y1) <= tol
    )


@pytest.mark.parametrize("tool", SHAPE_TOOLS)
def test_drag_preview_stays_visible_and_commits_the_drawn_shape(
    qtbot, window: MainWindow, view, tool: str
) -> None:
    window.set_tool(tool)
    before = len(path_boxes(view))
    start, end = vp(view, 100, 600), vp(view, 400, 700)
    a = page_pt(view, start)
    qtbot.mousePress(view.viewport(), Qt.MouseButton.LeftButton, pos=start)
    steps = 6
    for i in range(1, steps + 1):
        pos = start + (end - start) * i / steps
        qtbot.mouseMove(view.viewport(), pos=pos)
        previews = view.annotation_preview.get(0, [])
        assert len(previews) == 1, f"no preview at drag step {i}"
        assert close(previews[0], Rect.from_points([a, page_pt(view, pos)]), tol=1.0)
    expected = Rect.from_points([a, page_pt(view, end)])
    qtbot.mouseRelease(view.viewport(), Qt.MouseButton.LeftButton, pos=end)

    assert view.annotation_preview == {}
    boxes = path_boxes(view)
    assert len(boxes) == before + 1
    assert any(close(b, expected) for b in boxes), (expected, boxes)


@pytest.mark.parametrize("tool", SHAPE_TOOLS)
def test_plain_click_adds_nothing_and_keeps_the_shape_tool(
    qtbot, window: MainWindow, view, tool: str
) -> None:
    window.set_tool(tool)
    before = len(path_boxes(view))
    qtbot.mouseClick(view.viewport(), Qt.MouseButton.LeftButton, pos=vp(view, 100, 600))
    assert len(path_boxes(view)) == before
    assert view.annotation_preview == {}
    assert window.current_tool == tool


def test_drag_after_a_click_draws_the_shape_with_the_tool_still_active(
    qtbot, window: MainWindow, view
) -> None:
    window.set_tool("add_rectangle")
    qtbot.mouseClick(view.viewport(), Qt.MouseButton.LeftButton, pos=vp(view, 100, 600))
    before = len(path_boxes(view))
    start, end = vp(view, 100, 600), vp(view, 400, 700)
    a = page_pt(view, start)
    qtbot.mousePress(view.viewport(), Qt.MouseButton.LeftButton, pos=start)
    qtbot.mouseMove(view.viewport(), pos=end)
    assert view.annotation_preview.get(0)
    qtbot.mouseRelease(view.viewport(), Qt.MouseButton.LeftButton, pos=end)
    boxes = path_boxes(view)
    assert len(boxes) == before + 1
    assert any(close(b, Rect.from_points([a, page_pt(view, end)])) for b in boxes), boxes
