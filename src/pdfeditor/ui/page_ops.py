"""Desktop helper for the page actions: reads the clipboard image (the actions take the bytes).

The page operations themselves live in ``pdfeditor.actions.pages``.
"""

from __future__ import annotations

from PySide6.QtCore import QBuffer, QIODevice
from PySide6.QtGui import QGuiApplication, QImage


def clipboard_image_png() -> bytes | None:
    image: QImage = QGuiApplication.clipboard().image()
    if image.isNull():
        return None
    buffer = QBuffer()
    buffer.open(QIODevice.OpenModeFlag.WriteOnly)
    image.save(buffer, "PNG")  # type: ignore[call-overload]  # stub lacks the QIODevice form
    return bytes(buffer.data().data())
