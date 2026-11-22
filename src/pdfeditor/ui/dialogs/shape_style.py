"""The style of the shapes drawn next (Shapes > Shape Style): one outline, one optional fill and one
line width for all three shape tools. The desktop and the web version share this rule: a line is
never filled, and a shape always has an outline, so it is never invisible."""

from __future__ import annotations

from dataclasses import dataclass

from PySide6.QtWidgets import QCheckBox, QDoubleSpinBox, QWidget

from pdfeditor.actions.content import MAX_SHAPE_WIDTH
from pdfeditor.model.color import BLACK, Color
from pdfeditor.ui.color_picker import ColorButton
from pdfeditor.ui.dialogs.base import FormDialog, add_row

# The narrowest outline the engine accepts is just above zero; a tenth of a point is still visible.
MIN_SHAPE_WIDTH = 0.1
DEFAULT_FILL = Color(0.85, 0.92, 1.0)


@dataclass(frozen=True)
class ShapeStyle:
    stroke: Color = BLACK
    fill: Color | None = None  # None: no fill
    width: float = 1.5


DEFAULT_SHAPE_STYLE = ShapeStyle()


class ShapeStyleDialog(FormDialog):
    def __init__(self, style: ShapeStyle, parent: QWidget | None = None) -> None:
        super().__init__(
            "Shape Style",
            "Sets the shapes you draw next. A line is never filled.",
            parent,
        )
        self.outline = ColorButton(style.stroke, self, "Outline colour")
        self.fill_on = QCheckBox("Fill the shape")
        self.fill_on.setChecked(style.fill is not None)
        self.fill = ColorButton(style.fill or DEFAULT_FILL, self, "Fill colour")
        self.fill.setEnabled(self.fill_on.isChecked())
        self.fill_on.toggled.connect(self.fill.setEnabled)
        self.line_width = QDoubleSpinBox()
        self.line_width.setRange(MIN_SHAPE_WIDTH, MAX_SHAPE_WIDTH)
        self.line_width.setDecimals(1)
        self.line_width.setSingleStep(0.5)
        self.line_width.setSuffix(" pt")
        self.line_width.setValue(style.width)
        form = self.add_form()
        add_row(form, "Outline colour:", self.outline)
        add_row(form, "Fill:", self.fill_on)
        add_row(form, "Fill colour:", self.fill)
        add_row(
            form,
            "Line width:",
            self.line_width,
            f"From {MIN_SHAPE_WIDTH:g} to {MAX_SHAPE_WIDTH:g} pt.",
        )

    def shape_style(self) -> ShapeStyle:
        return ShapeStyle(
            stroke=self.outline.color,
            fill=self.fill.color if self.fill_on.isChecked() else None,
            width=self.line_width.value(),
        )
