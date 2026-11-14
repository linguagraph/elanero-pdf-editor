"""The translation bubble: a small popup next to the selected text, with its translation (TR3).

The request runs as a :class:`Job`, so the window never waits for the network. The From and To
pickers translate again when they change. Copy and Add as note act on the result. Closing the
bubble (Esc, a click outside, a new selection) cancels a request that is still running, and a
late answer is then ignored.
"""

from __future__ import annotations

import html
import logging
from collections.abc import Callable

from PySide6.QtCore import QCoreApplication, QLocale, Qt
from PySide6.QtGui import QHideEvent, QKeyEvent
from PySide6.QtWidgets import (
    QApplication,
    QComboBox,
    QFrame,
    QHBoxLayout,
    QLabel,
    QPlainTextEdit,
    QProgressBar,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from pdfeditor.core.jobs import Cancelled
from pdfeditor.services.translation import translate_selection
from pdfeditor.services.translation.base import (
    COMMON_LANGUAGES,
    AuthError,
    ConfigError,
    Translation,
    TranslationError,
    Translator,
)
from pdfeditor.ui.jobs import Job
from pdfeditor.ui.settings import AppSettings
from pdfeditor.ui.style.tokens import METRICS

log = logging.getLogger(__name__)

WIDTH = 360
# The To language when the From language is the same: the first of these that differs.
FALLBACK_TARGETS = ("en", "de", "fr")

# What a job hands back: the request it answers, then the translation or the error (never both).
Answer = tuple[int, Translation | None, TranslationError | None]


def _tr(text: str) -> str:
    return QCoreApplication.translate("TranslateBubble", text)


def app_language(prefs: AppSettings) -> str:
    """The app's language code (the setting, else the system's), e.g. "de" for de_DE."""
    name = prefs.language or QLocale.system().name()
    return name.replace("-", "_").split("_")[0].lower()


def _needs_preferences(error: TranslationError) -> bool:
    return isinstance(error, AuthError | ConfigError)


class TranslateBubble(QFrame):
    def __init__(
        self,
        parent: QWidget,
        text: str,
        make_translator: Callable[[], Translator],
        prefs: AppSettings,
        document_language: str,
        add_note: Callable[[str], bool],
        open_preferences: Callable[[], None],
    ) -> None:
        super().__init__(parent, Qt.WindowType.Popup | Qt.WindowType.FramelessWindowHint)
        self.setObjectName("TranslateBubble")
        self.setAccessibleName(_tr("Translation"))
        self.setFrameShape(QFrame.Shape.StyledPanel)
        self.setAutoFillBackground(True)
        self.setFixedWidth(WIDTH)
        self._text = text
        self._prefs = prefs
        self._add_note = add_note
        self._job: Job | None = None
        self._request = 0  # which request the bubble is waiting for
        self._translation: str | None = None

        self.busy = QProgressBar(self)
        self.busy.setRange(0, 0)  # busy until the first answer
        self.busy.setTextVisible(False)
        self.busy.setFixedHeight(4)
        self.busy.setAccessibleName(_tr("Translating"))
        self.result = QPlainTextEdit(self)
        self.result.setReadOnly(True)  # selectable and copyable, not editable
        self.result.setAccessibleName(_tr("Translation text"))
        self.result.setPlaceholderText(_tr("Translating…"))
        self.result.setMinimumHeight(METRICS.space(12))
        self.result.setMaximumHeight(METRICS.space(28))
        self.error = QLabel(self)
        self.error.setWordWrap(True)
        self.error.setVisible(False)
        self.preferences_button = QPushButton(_tr("Open Preferences…"), self)
        self.preferences_button.setVisible(False)
        self.preferences_button.clicked.connect(lambda _checked=False: open_preferences())
        self.from_combo = QComboBox(self)
        self.from_combo.setAccessibleName(_tr("From language"))
        self.to_combo = QComboBox(self)
        self.to_combo.setAccessibleName(_tr("To language"))
        self.copy_button = QPushButton(_tr("Copy"), self)
        self.copy_button.setEnabled(False)
        self.copy_button.clicked.connect(lambda _checked=False: self.copy())
        self.note_button = QPushButton(_tr("Add as note"), self)
        self.note_button.setEnabled(False)
        self._note_tip = _tr("Highlight the selected text, with the translation as its note")
        self.note_button.setToolTip(self._note_tip)
        self.note_button.clicked.connect(lambda _checked=False: self.add_as_note())
        self.attribution = QLabel(self)
        self.attribution.setOpenExternalLinks(True)
        self.attribution.setProperty("role", "caption")

        try:
            self._translator: Translator | None = make_translator()
        except TranslationError as exc:
            self._translator = None
            self._show_message(exc.message, preferences=_needs_preferences(exc))
        self._build_pickers(document_language)
        self._layout()
        self.from_combo.currentIndexChanged.connect(self._on_from_changed)
        self.to_combo.currentIndexChanged.connect(self._on_to_changed)
        self._translate()

    # -- layout and pickers ---------------------------------------------------------------
    def _layout(self) -> None:
        pickers = QHBoxLayout()
        pickers.setSpacing(METRICS.space(2))
        pickers.addWidget(QLabel(_tr("From"), self))
        pickers.addWidget(self.from_combo, 1)
        pickers.addWidget(QLabel(_tr("To"), self))
        pickers.addWidget(self.to_combo, 1)
        buttons = QHBoxLayout()
        buttons.setSpacing(METRICS.space(2))
        buttons.addWidget(self.copy_button)
        buttons.addWidget(self.note_button)
        buttons.addStretch(1)
        footer = QHBoxLayout()
        footer.addWidget(self.attribution, 1)
        footer.addWidget(self.preferences_button)
        column = QVBoxLayout(self)
        column.setContentsMargins(*([METRICS.space(3)] * 4))
        column.setSpacing(METRICS.space(2))
        column.addWidget(self.busy)
        column.addWidget(self.result)
        column.addWidget(self.error)
        column.addLayout(pickers)
        column.addLayout(buttons)
        column.addLayout(footer)

    def _build_pickers(self, document_language: str) -> None:
        translator = self._translator
        languages = translator.languages() if translator is not None else COMMON_LANGUAGES
        detects = translator.detects_source if translator is not None else False
        if translator is not None:
            self.attribution.setText(
                _tr("Translated by {service}").format(
                    service=f'<a href="{html.escape(translator.homepage)}">'
                    f"{html.escape(translator.name)}</a>"
                )
            )
        names = sorted(languages.items(), key=lambda item: item[1])
        if detects:
            self.from_combo.addItem(_tr("Detect language"), "")
        for code, name in names:
            self.from_combo.addItem(name, code)
            self.to_combo.addItem(name, code)
        if not detects:
            # The service can't detect the language, so start from the best guess: the
            # document's own language, then the one used last time.
            self._select(
                self.from_combo,
                [document_language, self._prefs.translation_last_source, "en"],
            )
        self._select(
            self.to_combo,
            [self._prefs.translation_target, app_language(self._prefs), "en"],
        )
        source = str(self.from_combo.currentData() or "")
        if not detects and source and self.to_combo.currentData() == source:
            # Translating into the language it's already in does nothing: pick another.
            # The preferred ones first, then whatever the service offers (a server's own list
            # may have neither English nor these); the first that differs from the source.
            offered = [str(self.to_combo.itemData(i)) for i in range(self.to_combo.count())]
            for code in [*FALLBACK_TARGETS, *offered]:
                if code and code != source and self.to_combo.findData(code) >= 0:
                    self._select(self.to_combo, [code])
                    break

    @staticmethod
    def _select(combo: QComboBox, candidates: list[str]) -> None:
        for code in candidates:
            index = combo.findData(code) if code else -1
            if index >= 0:
                combo.setCurrentIndex(index)
                return

    def _on_from_changed(self, _index: int) -> None:
        code = str(self.from_combo.currentData() or "")
        if code:
            self._prefs.translation_last_source = code
        self._translate()

    def _on_to_changed(self, _index: int) -> None:
        code = str(self.to_combo.currentData() or "")
        if code:
            self._prefs.translation_target = code
        self._translate()

    # -- running the request --------------------------------------------------------------
    def is_busy(self) -> bool:
        return self._job is not None

    def translation(self) -> str | None:
        return self._translation

    def _translate(self) -> None:
        self._cancel()
        translator = self._translator
        target = str(self.to_combo.currentData() or "")
        if translator is None or not target:
            return
        source = str(self.from_combo.currentData() or "") or None
        self.error.setVisible(False)
        self.preferences_button.setVisible(False)
        self.result.setPlaceholderText(_tr("Translating…"))
        self.result.clear()
        self._translation = None
        self.copy_button.setEnabled(False)
        self.note_button.setEnabled(False)
        self.busy.setVisible(True)
        text = self._text
        self._request += 1
        request = self._request

        def work(job: Job) -> Answer:
            try:
                translation = translate_selection(translator, text, source, target, job.token)
            except Cancelled:
                raise
            except TranslationError as exc:
                return request, None, exc
            return request, translation, None

        # Bound methods, not lambdas: Qt drops these connections when the bubble is deleted.
        job = Job(work, label="Translate selected text")
        job.finished.connect(self._on_answer)
        job.failed.connect(self._on_failed)
        self._job = job
        job.start()

    def _cancel(self) -> None:
        job, self._job = self._job, None
        if job is not None:
            job.cancel()
        self.busy.setVisible(False)

    def _on_answer(self, answer: object) -> None:
        if self._job is None or not isinstance(answer, tuple):
            return  # cancelled: the bubble closed, or a newer request replaced this one
        request, translation, error = answer
        if request != self._request:
            return
        self._job = None
        self.busy.setVisible(False)
        if translation is not None:
            self._show_text(translation.text)
        elif error is not None:
            if error.partial:  # the chunks that did translate before the failure
                self._show_text(error.partial, partial=True)
            self._show_message(error.message, preferences=_needs_preferences(error))
        self.result.setPlaceholderText("")

    def _show_text(self, text: str, partial: bool = False) -> None:
        self._translation = text
        self.result.setPlainText(text)
        self.copy_button.setEnabled(True)
        # A note is the whole translation: a part of one would be misleading as a note.
        self.note_button.setEnabled(not partial)
        self.note_button.setToolTip(
            _tr("Only part of the text was translated") if partial else self._note_tip
        )

    def _on_failed(self, _message: str) -> None:
        if self._job is None:
            return
        self._job = None
        self.busy.setVisible(False)
        self._show_message(_tr("The translation failed. Try again."))

    def _show_message(self, text: str, preferences: bool = False) -> None:
        self.error.setText(text)
        self.error.setVisible(True)
        self.preferences_button.setVisible(preferences)
        self.result.setPlaceholderText("")

    # -- actions --------------------------------------------------------------------------
    def copy(self) -> None:
        if self._translation is not None:
            QApplication.clipboard().setText(self._translation)

    def add_as_note(self) -> None:
        if self._translation is None:
            return
        if self._add_note(self._translation):
            self.close()
        else:
            self._show_message(_tr("Select the text again to add the note."))

    def dismiss(self, *_args: object) -> None:
        """Close the bubble (a slot for the page's signals, which may pass arguments)."""
        self.close()

    def hideEvent(self, event: QHideEvent) -> None:
        self._cancel()  # closing never leaves a request running
        super().hideEvent(event)
        self.deleteLater()  # a closed bubble is not reused: the controller makes a new one

    def keyPressEvent(self, event: QKeyEvent) -> None:
        if event.key() == Qt.Key.Key_Escape:
            self.close()
            return
        super().keyPressEvent(event)
