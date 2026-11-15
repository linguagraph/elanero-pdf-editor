"""Opens the user guide (docs/guide) in the browser: the one place that builds its URLs.

The guide is published online only, so when no browser opens, the message gives the address
to copy instead of failing silently.
"""

from __future__ import annotations

from PySide6.QtCore import QCoreApplication, QUrl
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import QMessageBox, QWidget

from pdfeditor import DOCS_URL


def docs_url(page: str = "") -> str:
    """The guide's address, or one of its pages (``page`` like ``"signing/"``)."""
    return DOCS_URL + page.lstrip("/")


def open_docs(page: str = "", parent: QWidget | None = None) -> bool:
    """Open the guide (or ``page`` of it) in the default browser. False, and a message with
    the address, when the browser couldn't be started."""
    url = docs_url(page)
    if QDesktopServices.openUrl(QUrl(url)):
        return True
    text = QCoreApplication.translate(
        "Help",
        "Elanero couldn't open your web browser. The user guide is at:\n\n{url}",
    ).format(url=url)
    title = QCoreApplication.translate("Help", "User Guide")
    QMessageBox.warning(parent, title, text)
    return False
