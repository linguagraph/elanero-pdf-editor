"""Shapes > Shape Style: the desktop dialog, and the next shape drawn with the chosen style."""

from __future__ import annotations

import shutil
from pathlib import Path

import pikepdf
import pypdfium2 as pdfium
import pytest
from PySide6.QtCore import QPoint, Qt

from pdfeditor.model.color import Color
from pdfeditor.model.geometry import Point
from pdfeditor.ui.dialogs.shape_style import DEFAULT_SHAPE_STYLE, ShapeStyle, ShapeStyleDialog
from pdfeditor.ui.main_window import MainWindow
from pdfeditor.ui.tools import edit

pytestmark = [pytest.mark.gui, pytest.mark.desktop_only]

RED = Color(1, 0, 0)
BLUE = Color(0, 0, 1)


@pytest.fixture
def window(qtbot, monkeypatch: pytest.MonkeyPatch):
    # The style is class-level state: each test starts from the default, and gets it back after.
    monkeypatch.setattr(edit.AddShapeTool, "style", DEFAULT_SHAPE_STYLE)
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


def drag(qtbot, view, a: tuple[float, float], b: tuple[float, float], steps: int = 5) -> None:
    start, end = vp(view, *a), vp(view, *b)
    qtbot.mousePress(view.viewport(), Qt.MouseButton.LeftButton, pos=start)
    for i in range(1, steps + 1):
        qtbot.mouseMove(view.viewport(), pos=start + (end - start) * i / steps)
    qtbot.mouseRelease(view.viewport(), Qt.MouseButton.LeftButton, pos=end)


def test_shape_style_dialog_fill_and_width(qtbot) -> None:
    dialog = ShapeStyleDialog(ShapeStyle(stroke=RED, fill=None, width=4))
    qtbot.addWidget(dialog)
    assert dialog.outline.color == RED
    assert not dialog.fill_on.isChecked() and not dialog.fill.isEnabled()
    assert dialog.shape_style() == ShapeStyle(stroke=RED, fill=None, width=4)
    dialog.fill_on.setChecked(True)
    assert dialog.fill.isEnabled()
    dialog.fill.set(BLUE)
    dialog.line_width.setValue(6)
    assert dialog.shape_style() == ShapeStyle(stroke=RED, fill=BLUE, width=6)
    dialog.line_width.setValue(10_000)  # clamped to the engine's widest outline
    assert dialog.line_width.value() == pytest.approx(72.0)
    dialog.fill_on.setChecked(False)
    assert dialog.shape_style().fill is None


def test_shape_style_action_stores_the_style(qtbot, window: MainWindow, view) -> None:
    dialog = ShapeStyleDialog(edit.AddShapeTool.style, window)
    qtbot.addWidget(dialog)
    dialog.outline.set(RED)
    dialog.fill_on.setChecked(True)
    dialog.fill.set(BLUE)
    dialog.line_width.setValue(6)
    dialog.exec = lambda: 1  # the user presses OK
    assert window.edit.shape_style(dialog) is True
    assert edit.AddShapeTool.style == ShapeStyle(stroke=RED, fill=BLUE, width=6)


def test_next_shape_uses_the_chosen_style(qtbot, window: MainWindow, view, tmp_path: Path) -> None:
    dialog = ShapeStyleDialog(edit.AddShapeTool.style, window)
    qtbot.addWidget(dialog)
    dialog.outline.set(RED)
    dialog.fill_on.setChecked(True)
    dialog.fill.set(BLUE)
    dialog.line_width.setValue(6)
    dialog.exec = lambda: 1
    window.edit.shape_style(dialog)

    window.set_tool("add_ellipse")
    tool = view.tool
    assert isinstance(tool, edit.AddShapeTool)
    assert (tool.stroke, tool.fill, tool.width) == (RED, BLUE, 6.0)
    drag(qtbot, view, (300, 700), (400, 780))  # the ellipse's left edge is at x = 300, y = 740
    window.save()

    with pikepdf.open(view.session.path) as pdf:
        ops = [
            (str(op), [float(x) for x in operands])
            for operands, op in pikepdf.parse_content_stream(pdf.pages[0])
            if str(op) in {"RG", "rg", "w", "B", "b", "S", "s", "f", "F"}
        ]
    # The last colour and width set in the page are the new shape's (it is appended last).
    last = {name: args for name, args in ops}
    assert last["RG"] == [1.0, 0.0, 0.0]
    assert last["rg"] == [0.0, 0.0, 1.0]
    assert last["w"] == [6.0]
    assert ops[-1][0] == "B"  # outline and fill in one paint operator

    rendered = pdfium.PdfDocument(str(view.session.path))[0].render(scale=1).to_pil().convert("RGB")
    outline = rendered.getpixel((300, 740))
    inside = rendered.getpixel((350, 740))
    assert outline[0] > 200 and outline[2] < 80  # red outline on the left edge
    assert inside[2] > 200 and inside[0] < 80  # blue fill inside
