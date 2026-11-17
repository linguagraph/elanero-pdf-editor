"""Desktop helpers around the page actions: the clipboard image and the snapshot runner.

The page operations themselves live in ``pdfeditor.actions.pages``.
"""

from __future__ import annotations

from collections.abc import Callable

from PySide6.QtCore import QBuffer, QIODevice
from PySide6.QtGui import QGuiApplication, QImage

from pdfeditor.actions.base import snapshot
from pdfeditor.core.session import DocumentSession
from pdfeditor.engine.base import Document


def run(session: DocumentSession, label: str, operation: Callable[[Document], None]) -> None:
    # Goes away in slice (d): its remaining callers are the page-mark code in organize.py.
    snapshot(session, label, operation)


def clipboard_image_png() -> bytes | None:
    image: QImage = QGuiApplication.clipboard().image()
    if image.isNull():
        return None
    buffer = QBuffer()
    buffer.open(QIODevice.OpenModeFlag.WriteOnly)
    image.save(buffer, "PNG")  # type: ignore[call-overload]  # stub lacks the QIODevice form
    return bytes(buffer.data().data())
