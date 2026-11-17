"""The translation bubble (TR3): consent, the result, Copy, Add as note (one undo step), errors,
Esc and cancellation, the pickers, and closing on a new selection. A fake translator stands in
for the services, so no test touches the network."""

from __future__ import annotations

import threading
import time
from collections.abc import Iterator
from typing import Any

import pytest
from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication

from pdfeditor.core.jobs import Cancelled, CancelToken
from pdfeditor.model.annotations import AnnotationModel, AnnotationType
from pdfeditor.services import translation as tr
from pdfeditor.services.text import TextPos, TextSelection
from pdfeditor.services.translation.base import (
    AuthError,
    ServiceError,
    Translation,
    TranslationError,
)
from pdfeditor.ui.main_window import MainWindow
from pdfeditor.ui.translate_bubble import TranslateBubble
from pdfeditor.ui.view.document_view import DocumentView

pytestmark = [pytest.mark.gui, pytest.mark.desktop_only]


class FakeTranslator:
    id = "fake"
    name = "Fake Service"
    homepage = "https://fake.example/"
    privacy_url = "https://fake.example/privacy"
    detects_source = True
    max_request_bytes = 4000
    max_text_chars = 10_000
    cache_id = "fake"

    def __init__(
        self, reply: str = "Bonjour le monde", error: TranslationError | None = None
    ) -> None:
        self.reply = reply
        self.error = error
        self.block = False  # when True, translate waits until cancelled
        self.calls: list[tuple[str, str | None, str]] = []
        self.started = threading.Event()
        self.cancel_seen = threading.Event()

    def languages(self) -> dict[str, str]:
        return {"en": "English", "fr": "French", "de": "German"}

    def translate(
        self, text: str, source: str | None, target: str, token: CancelToken | None = None
    ) -> Translation:
        self.calls.append((text, source, target))
        if self.block:
            self.started.set()
            for _ in range(1000):
                try:
                    if token is not None:
                        token.check()
                except Cancelled:
                    self.cancel_seen.set()
                    raise
                time.sleep(0.005)
        if self.error is not None:
            raise self.error
        return Translation(self.reply, "en" if source is None else None, self.id)

    def test_connection(self, token: CancelToken | None = None) -> None:
        return None


@pytest.fixture(autouse=True)
def fresh_cache() -> None:
    tr.clear_cache()


@pytest.fixture
def window(qtbot) -> Iterator[MainWindow]:
    w = MainWindow()
    w.resize(1280, 860)
    w.show()
    qtbot.waitExposed(w)
    w.prefs.translation_enabled = True  # the consent step has its own test
    w.prefs.translation_consented = FakeTranslator.cache_id
    w.prefs.translation_target = "fr"
    w.prefs.translation_last_source = ""
    yield w
    for view in w.views():
        view.session.undo_stack.set_clean()
    w.close()
    w.deleteLater()


def select_words(view: DocumentView, page: int = 0, start: int = 0, end: int = 20) -> None:
    view.set_selection(TextSelection(TextPos(page, start), TextPos(page, end)))


def page_notes(view: DocumentView) -> list[AnnotationModel]:
    return view.page_annotations(0)


def wait_for_result(qtbot, bubble: TranslateBubble) -> None:
    qtbot.waitUntil(lambda: not bubble.is_busy(), timeout=5000)


def open_bubble(window: MainWindow, view: DocumentView, fake: FakeTranslator) -> TranslateBubble:
    window.translate.make_translator = lambda: fake
    assert window.translate.start(view)
    bubble = window.translate.bubble
    assert bubble is not None
    return bubble


def test_declining_the_notice_sends_nothing(qtbot, window, fixture_pdf) -> None:
    view = window.open_path(fixture_pdf("text_multipage"))
    window.prefs.translation_enabled = False
    fake = FakeTranslator()
    window.translate.make_translator = lambda: fake
    asked: list[tuple[str, str]] = []

    def cancel(_parent: Any, service: str, privacy: str, recipient: str) -> bool:
        asked.append((service, privacy))
        assert recipient == "Fake Service"
        return False

    window.translate.confirm = cancel
    select_words(view)
    assert window.translate.start(view) is False
    assert asked == [("Fake Service", "https://fake.example/privacy")]
    assert fake.calls == []
    assert window.translate.bubble is None
    assert window.prefs.translation_enabled is False


def test_accepting_the_notice_enables_translation_and_translates(
    qtbot, window, fixture_pdf
) -> None:
    view = window.open_path(fixture_pdf("text_multipage"))
    window.prefs.translation_enabled = False
    fake = FakeTranslator()
    window.translate.make_translator = lambda: fake
    window.translate.confirm = lambda *_args: True
    select_words(view)
    assert window.translate.start(view)
    assert window.prefs.translation_enabled is True
    bubble = window.translate.bubble
    assert bubble is not None
    wait_for_result(qtbot, bubble)
    assert bubble.result.toPlainText() == "Bonjour le monde"
    assert fake.calls and fake.calls[0][1] is None  # the service detects, so Detect was used


def test_bubble_shows_translation_and_attribution(qtbot, window, fixture_pdf) -> None:
    view = window.open_path(fixture_pdf("text_multipage"))
    select_words(view)
    bubble = open_bubble(window, view, FakeTranslator())
    wait_for_result(qtbot, bubble)
    assert bubble.result.toPlainText() == "Bonjour le monde"
    assert "Fake Service" in bubble.attribution.text()
    assert "https://fake.example/" in bubble.attribution.text()
    assert bubble.copy_button.isEnabled()
    assert bubble.note_button.isEnabled()
    assert bubble.from_combo.currentData() == ""  # Detect language
    assert bubble.to_combo.currentData() == "fr"  # the remembered target


def test_copy_puts_the_translation_on_the_clipboard(qtbot, window, fixture_pdf) -> None:
    view = window.open_path(fixture_pdf("text_multipage"))
    select_words(view)
    bubble = open_bubble(window, view, FakeTranslator("Copié ici"))
    wait_for_result(qtbot, bubble)
    qtbot.mouseClick(bubble.copy_button, Qt.MouseButton.LeftButton)
    assert QApplication.clipboard().text() == "Copié ici"


def test_add_as_note_is_one_highlight_and_undoable(qtbot, window, fixture_pdf) -> None:
    view = window.open_path(fixture_pdf("text_multipage"))
    select_words(view)
    bubble = open_bubble(window, view, FakeTranslator("La note traduite"))
    wait_for_result(qtbot, bubble)
    bubble.note_button.click()
    assert not bubble.isVisible()  # the bubble's job is done
    notes = [a for a in page_notes(view) if a.type is AnnotationType.HIGHLIGHT]
    assert len(notes) == 1
    assert notes[0].contents == "La note traduite"
    assert view.session.undo_stack.undo_label == "Add Note to Text"
    window.undo()
    assert not [a for a in page_notes(view) if a.type is AnnotationType.HIGHLIGHT]


def test_service_errors_are_shown_inline(qtbot, window, fixture_pdf) -> None:
    view = window.open_path(fixture_pdf("text_multipage"))
    select_words(view)
    bubble = open_bubble(window, view, FakeTranslator(error=ServiceError("Try again later.")))
    wait_for_result(qtbot, bubble)
    assert bubble.error.isVisible()
    assert bubble.error.text() == "Try again later."
    assert not bubble.preferences_button.isVisible()
    assert not bubble.copy_button.isEnabled()


def test_a_bad_key_offers_preferences(qtbot, window, fixture_pdf, monkeypatch) -> None:
    view = window.open_path(fixture_pdf("text_multipage"))
    select_words(view)
    opened: list[str] = []
    monkeypatch.setattr(window, "open_preferences", lambda category="": opened.append(category))
    bubble = open_bubble(window, view, FakeTranslator(error=AuthError("Bad key.")))
    wait_for_result(qtbot, bubble)
    assert bubble.error.text() == "Bad key."
    assert bubble.preferences_button.isVisible()
    bubble.preferences_button.click()
    assert opened == ["Translation"]


def test_escape_closes_and_cancels_the_running_request(qtbot, window, fixture_pdf) -> None:
    view = window.open_path(fixture_pdf("text_multipage"))
    select_words(view)
    fake = FakeTranslator()
    fake.block = True
    bubble = open_bubble(window, view, fake)
    assert bubble.is_busy()
    assert fake.started.wait(5)
    qtbot.keyClick(bubble, Qt.Key.Key_Escape)
    assert not bubble.isVisible()
    assert not bubble.is_busy()
    assert fake.cancel_seen.wait(5)  # the worker saw the cancellation and stopped


def test_changing_the_target_translates_again(qtbot, window, fixture_pdf) -> None:
    view = window.open_path(fixture_pdf("text_multipage"))
    select_words(view)
    fake = FakeTranslator()
    bubble = open_bubble(window, view, fake)
    wait_for_result(qtbot, bubble)
    bubble.to_combo.setCurrentIndex(bubble.to_combo.findData("de"))
    wait_for_result(qtbot, bubble)
    assert [target for _text, _source, target in fake.calls] == ["fr", "de"]
    assert window.prefs.translation_target == "de"


def test_non_detecting_service_starts_from_the_last_source(qtbot, window, fixture_pdf) -> None:
    view = window.open_path(fixture_pdf("text_multipage"))
    select_words(view)
    window.prefs.translation_last_source = "de"
    fake = FakeTranslator()
    fake.detects_source = False
    bubble = open_bubble(window, view, fake)
    wait_for_result(qtbot, bubble)
    assert bubble.from_combo.currentData() == "de"
    assert fake.calls[0][1] == "de"


def test_a_new_selection_closes_the_bubble(qtbot, window, fixture_pdf) -> None:
    view = window.open_path(fixture_pdf("text_multipage"))
    select_words(view)
    bubble = open_bubble(window, view, FakeTranslator())
    wait_for_result(qtbot, bubble)
    select_words(view, end=5)
    assert not bubble.isVisible()
    assert window.translate.bubble is None or not window.translate.bubble.isVisible()


def test_empty_selection_opens_nothing(window, fixture_pdf) -> None:
    view = window.open_path(fixture_pdf("text_multipage"))
    window.translate.make_translator = lambda: FakeTranslator()
    view.clear_selection()
    assert window.translate.start(view) is False
    assert window.translate.bubble is None


def test_the_text_bar_has_a_translate_button(window, fixture_pdf) -> None:
    view = window.open_path(fixture_pdf("text_multipage"))
    select_words(view)
    assert window.contextual.translate_button.accessibleName() == "Translate"
    assert window.contextual.translate_button.toolTip() == "Translate the selected text"


def test_the_bubble_is_a_popup_with_a_name(qtbot, window, fixture_pdf) -> None:
    view = window.open_path(fixture_pdf("text_multipage"))
    select_words(view)
    bubble = open_bubble(window, view, FakeTranslator())
    wait_for_result(qtbot, bubble)
    assert bubble.windowFlags() & Qt.WindowType.Popup
    assert bubble.accessibleName() == "Translation"
    assert isinstance(bubble, TranslateBubble)
