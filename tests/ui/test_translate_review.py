"""Review follow-ups for the translation bubble: a slow answer for an old language is ignored, a
late answer after close is dropped, a closed bubble schedules its deletion, a failure part way
keeps the translated part, configuration errors offer Preferences, consent is per service, and
right-clicks on the selected text (and not elsewhere, nor on a comment) open its menu."""

from __future__ import annotations

import threading
from collections.abc import Iterator
from typing import Any

import pytest
from PySide6.QtCore import QPoint
from PySide6.QtGui import QContextMenuEvent

from pdfeditor.core.jobs import CancelToken
from pdfeditor.services import translation as tr
from pdfeditor.services.text import TextPos, TextSelection
from pdfeditor.services.translation.base import (
    ConfigError,
    OfflineError,
    Translation,
)
from pdfeditor.services.translation.libretranslate import LibreTranslateTranslator
from pdfeditor.ui.main_window import MainWindow
from pdfeditor.ui.translate_controller import recipient_of
from pdfeditor.ui.view.document_view import DocumentView

pytestmark = pytest.mark.gui


class Fake:
    id = "fake"
    cache_id = "fake"
    name = "Fake Service"
    homepage = "https://fake.example/"
    privacy_url = "https://fake.example/privacy"
    detects_source = False
    max_request_bytes = 4000
    max_text_chars = 10_000

    def __init__(self) -> None:
        self.calls: list[tuple[str, str | None, str]] = []
        self.error: Exception | None = None

    def languages(self) -> dict[str, str]:
        return {"en": "English", "fr": "French", "de": "German"}

    def translate(
        self, text: str, source: str | None, target: str, token: CancelToken | None = None
    ) -> Translation:
        self.calls.append((text, source, target))
        if self.error is not None:
            raise self.error
        return Translation(f"[{target}] {text}", None, self.id)

    def test_connection(self, token: CancelToken | None = None) -> None:
        return None


class Gated(Fake):
    """Answers "fr" only when the test lets it: a slow request."""

    def __init__(self) -> None:
        super().__init__()
        self.gate = threading.Event()
        self.reached_gate = threading.Event()

    def translate(
        self, text: str, source: str | None, target: str, token: CancelToken | None = None
    ) -> Translation:
        self.calls.append((text, source, target))
        if target == "fr":
            self.reached_gate.set()
            self.gate.wait(10)
            if token is not None:
                token.check()  # a cancelled request stops here, as the real ones do
        return Translation(f"[{target}] {text}", None, self.id)


@pytest.fixture(autouse=True)
def fresh_cache() -> None:
    tr.clear_cache()


@pytest.fixture
def window(qtbot) -> Iterator[MainWindow]:
    w = MainWindow()
    w.resize(1280, 860)
    w.show()
    qtbot.waitExposed(w)
    w.prefs.translation_enabled = True
    w.prefs.translation_consented = "fake"
    w.prefs.translation_target = "fr"
    w.prefs.translation_last_source = ""
    yield w
    for view in w.views():
        view.session.undo_stack.set_clean()
    w.close()
    w.deleteLater()


def select(view: DocumentView, end: int = 20) -> None:
    view.set_selection(TextSelection(TextPos(0, 0), TextPos(0, end)))


def open_bubble(window: MainWindow, view: DocumentView, translator: Any) -> Any:
    window.translate.make_translator = lambda: translator
    assert window.translate.start(view)
    bubble = window.translate.bubble
    assert bubble is not None
    return bubble


def wait_idle(qtbot, bubble: Any) -> None:
    qtbot.waitUntil(lambda: not bubble.is_busy(), timeout=5000)


# -- races and late answers --------------------------------------------------------------------


def test_a_slow_answer_for_an_earlier_target_is_ignored(qtbot, window, fixture_pdf) -> None:
    view = window.open_path(fixture_pdf("text_multipage"))
    select(view)
    fake = Gated()
    bubble = open_bubble(window, view, fake)  # the target starts as French, which is slow
    assert fake.reached_gate.wait(5)
    bubble.to_combo.setCurrentIndex(bubble.to_combo.findData("de"))  # German answers first
    wait_idle(qtbot, bubble)
    assert bubble.result.toPlainText().startswith("[de]")
    fake.gate.set()  # the French answer arrives after the German one
    qtbot.wait(200)
    assert bubble.result.toPlainText().startswith("[de]")
    assert (bubble.translation() or "").startswith("[de]")


def test_an_answer_after_close_is_dropped(qtbot, window, fixture_pdf) -> None:
    view = window.open_path(fixture_pdf("text_multipage"))
    select(view)
    fake = Gated()
    bubble = open_bubble(window, view, fake)
    assert fake.reached_gate.wait(5)
    bubble.close()
    assert not bubble.is_busy()  # closing cancelled the request
    fake.gate.set()
    qtbot.wait(200)
    assert bubble.translation() is None


def test_a_closed_bubble_schedules_its_deletion(qtbot, window, fixture_pdf, monkeypatch) -> None:
    view = window.open_path(fixture_pdf("text_multipage"))
    select(view)
    bubble = open_bubble(window, view, Fake())
    wait_idle(qtbot, bubble)
    scheduled: list[int] = []
    monkeypatch.setattr(bubble, "deleteLater", lambda: scheduled.append(1))
    bubble.close()
    assert scheduled == [1]


# -- partial results and errors ------------------------------------------------------------------


def test_a_failure_part_way_keeps_the_translated_part(qtbot, window, fixture_pdf) -> None:
    class Flaky(Fake):
        max_request_bytes = 20

        def translate(self, text, source, target, token=None):  # type: ignore[no-untyped-def]
            self.calls.append((text, source, target))
            if len(self.calls) > 1:
                raise OfflineError("Connection lost. Try again.")
            return Translation(f"[{text}] ", None, self.id)

    view = window.open_path(fixture_pdf("text_multipage"))
    select(view, 120)
    bubble = open_bubble(window, view, Flaky())
    wait_idle(qtbot, bubble)
    assert bubble.error.isVisible()
    assert "Connection lost" in bubble.error.text()
    assert bubble.result.toPlainText().startswith("[")
    assert bubble.copy_button.isEnabled()


def test_a_configuration_error_offers_preferences(qtbot, window, fixture_pdf) -> None:
    view = window.open_path(fixture_pdf("text_multipage"))
    select(view)
    fake = Fake()
    fake.error = ConfigError("Add your DeepL API key in Preferences ▸ Translation.")
    bubble = open_bubble(window, view, fake)
    wait_idle(qtbot, bubble)
    assert bubble.error.isVisible()
    assert bubble.preferences_button.isVisible()


def test_the_target_defaults_to_a_language_other_than_the_source(
    qtbot, window, fixture_pdf
) -> None:
    window.prefs.translation_target = "en"
    window.prefs.translation_last_source = "en"
    view = window.open_path(fixture_pdf("text_multipage"))
    select(view)
    bubble = open_bubble(window, view, Fake())
    wait_idle(qtbot, bubble)
    assert bubble.from_combo.currentData() == "en"
    assert bubble.to_combo.currentData() == "de"  # the first of en, de, fr that differs


def test_translating_into_the_same_language_says_so(qtbot, window, fixture_pdf) -> None:
    window.prefs.translation_last_source = "en"
    view = window.open_path(fixture_pdf("text_multipage"))
    select(view)
    bubble = open_bubble(window, view, Fake())
    wait_idle(qtbot, bubble)
    bubble.to_combo.setCurrentIndex(bubble.to_combo.findData("en"))
    wait_idle(qtbot, bubble)
    assert bubble.error.isVisible()
    assert "already in that language" in bubble.error.text()
    assert bubble.translation() is None


# -- consent per service -------------------------------------------------------------------------


def test_consent_for_one_service_does_not_cover_another(qtbot, window, fixture_pdf) -> None:
    window.prefs.translation_consented = "mymemory"
    view = window.open_path(fixture_pdf("text_multipage"))
    select(view)
    window.translate.make_translator = lambda: Fake()
    asked: list[tuple[Any, ...]] = []
    window.translate.confirm = lambda *args: asked.append(args) or False
    assert window.translate.start(view) is False
    assert len(asked) == 1
    assert asked[0][1] == "Fake Service"


def test_agreeing_records_the_service_identity(qtbot, window, fixture_pdf) -> None:
    window.prefs.translation_consented = ""
    view = window.open_path(fixture_pdf("text_multipage"))
    select(view)
    window.translate.make_translator = lambda: Fake()
    window.translate.confirm = lambda *_args: True
    assert window.translate.start(view)
    assert window.prefs.translation_consented == "fake"
    assert window.prefs.translation_enabled is True


def test_libretranslate_without_a_server_opens_preferences_instead_of_asking(
    window, fixture_pdf, monkeypatch
) -> None:
    window.prefs.translation_enabled = False
    window.prefs.translation_service = "libretranslate"
    window.prefs.libretranslate_url = ""
    view = window.open_path(fixture_pdf("text_multipage"))
    select(view)
    opened: list[str] = []
    monkeypatch.setattr(window, "open_preferences", lambda category="": opened.append(category))
    asked: list[object] = []
    window.translate.confirm = lambda *args: asked.append(args) or True
    assert window.translate.start(view) is False
    assert opened == ["Translation"]
    assert asked == []


def test_the_notice_for_a_libretranslate_server_names_the_server() -> None:
    translator = LibreTranslateTranslator("https://lt.example.org")
    recipient = recipient_of(translator)
    assert "lt.example.org" in recipient
    assert "operator's privacy policy applies" in recipient
    assert translator.privacy_url == tr.PRIVACY_NOTICE_URL


# -- selection context menu ---------------------------------------------------------------------


def first_line_center(view: DocumentView) -> QPoint:
    """The middle of the selection's first line box (the bounding box's middle can fall in the
    gap between two lines)."""
    first = view._selection_rects_for(0)[0]
    return view.viewport_rect([(0, first)]).center()


def capture_text_menu(window: MainWindow, view: DocumentView, shown: list[QPoint]) -> None:
    """Record the text menu's requests instead of showing the (modal) menu."""
    view.text_context_menu.disconnect(window.text_menu)
    view.text_context_menu.connect(lambda pos: shown.append(pos))


def _context_event(view: DocumentView, at: QPoint) -> QContextMenuEvent:
    """A right-click at ``at`` (viewport pixels), as the view receives it."""
    # A QAbstractScrollArea delivers the position in viewport coordinates.
    return QContextMenuEvent(QContextMenuEvent.Reason.Mouse, at, view.viewport().mapToGlobal(at))


def test_right_click_on_the_selected_text_opens_the_text_menu(window, fixture_pdf) -> None:
    view = window.open_path(fixture_pdf("text_multipage"))
    select(view)
    shown: list[QPoint] = []
    capture_text_menu(window, view, shown)
    inside = first_line_center(view)
    view.contextMenuEvent(_context_event(view, inside))
    assert len(shown) == 1


def test_right_click_elsewhere_does_not_open_the_text_menu(window, fixture_pdf) -> None:
    view = window.open_path(fixture_pdf("text_multipage"))
    select(view)
    shown: list[QPoint] = []
    capture_text_menu(window, view, shown)
    view.contextMenuEvent(_context_event(view, QPoint(2, 2)))
    assert shown == []


def test_a_comment_under_the_pointer_keeps_its_own_menu(window, fixture_pdf, monkeypatch) -> None:
    view = window.open_path(fixture_pdf("text_multipage"))
    select(view)
    shown: list[QPoint] = []
    capture_text_menu(window, view, shown)
    monkeypatch.setattr(view, "annotation_at", lambda _scene: object())
    view.contextMenuEvent(_context_event(view, first_line_center(view)))
    assert shown == []


def test_selection_hit_test_uses_the_text_not_the_bounds(window, fixture_pdf) -> None:
    view = window.open_path(fixture_pdf("text_multipage"))
    select(view)
    assert view.selection_contains(first_line_center(view))
    assert not view.selection_contains(QPoint(2, 2))


def test_a_partial_result_cannot_be_added_as_a_note(qtbot, window, fixture_pdf) -> None:
    class Flaky(Fake):
        max_request_bytes = 20

        def translate(self, text, source, target, token=None):  # type: ignore[no-untyped-def]
            self.calls.append((text, source, target))
            if len(self.calls) > 1:
                raise OfflineError("Connection lost. Try again.")
            return Translation(f"[{text}] ", None, self.id)

    view = window.open_path(fixture_pdf("text_multipage"))
    select(view, 120)
    bubble = open_bubble(window, view, Flaky())
    wait_idle(qtbot, bubble)
    assert bubble.translation()  # the part that translated is shown and copyable
    assert bubble.copy_button.isEnabled()
    assert not bubble.note_button.isEnabled()
    assert bubble.note_button.toolTip() == "Only part of the text was translated"
