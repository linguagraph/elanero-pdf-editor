"""Opens the translation bubble for the selected text, and the consent before the first request
to a service (TR3). Owned by the main window, like the other controllers.

Nothing leaves the computer until the user has agreed and then chosen Translate. The agreement
is for one service, identified by its cache_id (a LibreTranslate server's address is part of
it), so changing the service asks again.
"""

from __future__ import annotations

import logging
import urllib.parse
from collections.abc import Callable
from typing import TYPE_CHECKING

from PySide6.QtCore import QCoreApplication, QUrl
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import QMessageBox, QWidget
from shiboken6 import isValid

from pdfeditor.model.annotations import AnnotationType
from pdfeditor.services.translation import make_translator
from pdfeditor.services.translation.base import ConfigError, TranslationError, Translator
from pdfeditor.ui.contextual import place
from pdfeditor.ui.tools import annotate
from pdfeditor.ui.translate_bubble import TranslateBubble

if TYPE_CHECKING:
    from pdfeditor.core.session import DocumentSession
    from pdfeditor.ui.main_window import MainWindow
    from pdfeditor.ui.view.document_view import DocumentView

log = logging.getLogger(__name__)


def _tr(text: str) -> str:
    return QCoreApplication.translate("TranslateController", text)


def ask_consent(parent: QWidget, service: str, privacy_url: str, recipient: str) -> bool:
    """The notice before the first request to a service. True if the user chose Translate.
    The privacy link opens in the browser and keeps the notice open."""
    box = QMessageBox(parent)
    box.setIcon(QMessageBox.Icon.Question)
    box.setWindowTitle(_tr("Translate Selected Text"))
    box.setText(_tr("Translate the selected text with {service}?").format(service=service))
    box.setInformativeText(
        _tr(
            "Only the text you selected is sent to {recipient}. It sees the text and your IP "
            "address. Nothing is sent until you choose Translate. You can turn this off in "
            "Preferences ▸ Translation."
        ).format(recipient=recipient)
    )
    accept = box.addButton(_tr("Translate"), QMessageBox.ButtonRole.AcceptRole)
    box.addButton(QMessageBox.StandardButton.Cancel)
    box.setDefaultButton(accept)
    privacy = box.addButton(_tr("Privacy Policy"), QMessageBox.ButtonRole.HelpRole)
    while True:
        box.exec()
        clicked = box.clickedButton()
        if clicked is privacy:
            QDesktopServices.openUrl(QUrl(privacy_url))
            continue
        return clicked is accept


def document_language(session: DocumentSession) -> str:
    """The document's language code, e.g. "en" for the catalog /Lang "en-US"; "" if none."""
    with session.lock:
        tag = session.document.accessibility_settings().language
    return tag.replace("_", "-").split("-")[0].lower() if tag else ""


def recipient_of(translator: Translator) -> str:
    """Who receives the text, in words the consent notice can use."""
    if translator.id == "libretranslate":
        host = urllib.parse.urlsplit(translator.homepage).netloc
        return f"the LibreTranslate server at {host} (its operator's privacy policy applies)"
    if translator.id == "azure":
        return "Microsoft Azure AI Translator"
    return translator.name


class TranslateController:
    def __init__(self, window: MainWindow) -> None:
        self.w = window
        # Replaceable (tests use fakes): builds the translator from the current settings.
        self.make_translator: Callable[[], Translator] = self._configured_translator
        # Replaceable too: the notice (parent, service name, privacy URL, recipient) -> agreed?
        self.confirm: Callable[[QWidget, str, str, str], bool] = ask_consent
        self._bubble: TranslateBubble | None = None
        window.tabs.currentChanged.connect(lambda _index: self.close_bubble())

    @property
    def bubble(self) -> TranslateBubble | None:
        """The bubble that is open (None once it has closed)."""
        # A bubble deletes itself once hidden, so the reference is checked before it's used.
        if self._bubble is not None and isValid(self._bubble):
            return self._bubble
        return None

    def _configured_translator(self) -> Translator:
        prefs = self.w.prefs
        return make_translator(prefs.translation_service, prefs.translation_config())

    def start(self, view: DocumentView | None = None) -> bool:
        """Translate the text selected in ``view`` (the current document by default).
        Returns False if nothing was opened (no selection, or the user declined)."""
        if view is None:
            view = self.w.current_view()
        if view is None or not view.has_selection():
            return False
        with view.session.lock:
            text = view.selected_text()
        if not text.strip():
            return False
        rect = view.selection_viewport_rect()
        if rect is None:
            return False
        try:
            translator = self.make_translator()
        except ConfigError as exc:
            log.info("translation not configured: %s", type(exc).__name__)
            self.w.open_preferences("Translation")  # fix the setting first, then ask
            return False
        except TranslationError as exc:
            self.w.notify(exc.message)
            return False
        if not self._consented(translator) and not self._agree(translator):
            return False
        self.close_bubble()
        language = document_language(view.session)

        def add_note(translation: str) -> bool:
            kind = AnnotationType.HIGHLIGHT
            return annotate.apply_markup(view, kind, "Add Note to Text", translation)

        bubble = TranslateBubble(
            self.w,
            text,
            self.make_translator,
            self.w.prefs,
            language,
            add_note,
            lambda: self.w.open_preferences("Translation"),
        )
        # Anything that moves the page or the selection closes the bubble. The bubble
        # disconnects itself when it is deleted.
        view.selection_changed.connect(bubble.dismiss)
        view.zoom_changed.connect(bubble.dismiss)
        view.pointer_pressed.connect(bubble.dismiss)
        view.verticalScrollBar().valueChanged.connect(bubble.dismiss)
        view.horizontalScrollBar().valueChanged.connect(bubble.dismiss)
        self._bubble = bubble
        viewport = view.viewport()
        bubble.adjustSize()
        top_left = place(bubble.size(), rect, viewport.rect())
        bubble.move(viewport.mapToGlobal(top_left))
        bubble.show()
        bubble.setFocus()
        return True

    def _consented(self, translator: Translator) -> bool:
        prefs = self.w.prefs
        return prefs.translation_enabled and prefs.translation_consented == translator.cache_id

    def _agree(self, translator: Translator) -> bool:
        """The notice for this service. Accepting records consent for it, so the next request
        to the same service (with the same server, for LibreTranslate) asks nothing."""
        if not self.confirm(
            self.w, translator.name, translator.privacy_url, recipient_of(translator)
        ):
            return False
        self.w.prefs.translation_enabled = True
        self.w.prefs.translation_consented = translator.cache_id
        return True

    def close_bubble(self) -> None:
        bubble = self.bubble
        self._bubble = None
        if bubble is not None:
            bubble.close()  # the bubble deletes itself once hidden
