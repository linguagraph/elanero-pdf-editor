"""The four ways into the user guide (issue #119): F1 and Help > Elanero Help, the ribbon's "?"
button, the start page link and the About dialog's Documentation link. Each opens DOCS_URL
through ui/help.py; a browser that doesn't start shows the address instead."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from PySide6.QtCore import Qt, QUrl
from PySide6.QtGui import QAction, QDesktopServices, QKeySequence
from PySide6.QtWidgets import QLabel, QMenu, QToolButton, QWidget

from pdfeditor import DOCS_URL
from pdfeditor.ui import help as help_module
from pdfeditor.ui.dialogs.about import AboutDialog
from pdfeditor.ui.main_window import MainWindow
from pdfeditor.ui.shortcuts import action_id, command_actions

pytestmark = pytest.mark.gui


@pytest.fixture
def opened(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Record the URLs handed to the browser; no browser starts. Returns True (opened)."""
    urls: list[str] = []

    def fake_open(url: QUrl) -> bool:
        urls.append(url.toString())
        return True

    monkeypatch.setattr(QDesktopServices, "openUrl", staticmethod(fake_open))
    return urls


@pytest.fixture
def window(qtbot) -> Iterator[MainWindow]:
    w = MainWindow()
    qtbot.addWidget(w)
    w.resize(1400, 900)
    w.show()
    qtbot.waitExposed(w)
    yield w
    w.close()


def _help_menu(window: MainWindow) -> QMenu:
    menu = next(a.menu() for a in window.menu_bar.actions() if a.text() == "&Help")
    assert isinstance(menu, QMenu)
    return menu


def test_docs_url_builds_pages_from_the_site_root() -> None:
    assert help_module.docs_url() == DOCS_URL
    assert help_module.docs_url("signing/") == DOCS_URL + "signing/"
    assert help_module.docs_url("/signing/") == DOCS_URL + "signing/"


def test_open_docs_opens_the_guide_and_reports_success(opened: list[str]) -> None:
    assert help_module.open_docs() is True
    assert help_module.open_docs("translation/") is True
    assert opened == [DOCS_URL, DOCS_URL + "translation/"]


def test_f1_opens_the_guide_with_no_document(window: MainWindow, opened: list[str], qtbot) -> None:
    assert window.current_view() is None
    assert window.act_help.shortcut() == QKeySequence(Qt.Key.Key_F1)
    qtbot.keyClick(window, Qt.Key.Key_F1)
    assert opened == [DOCS_URL]


def test_help_menu_lists_the_guide_above_about(window: MainWindow) -> None:
    actions = _help_menu(window).actions()
    # Check for Updates is hidden outside the Store build, so only the visible items count.
    texts = [a.text() for a in actions if not a.isSeparator() and a.isVisible()]
    assert texts == ["Elanero &Help", "&About Elanero"]
    help_index = actions.index(window.act_help)
    assert actions[help_index + 1].isSeparator()
    assert actions.index(window.act_about) > help_index + 1


def test_help_menu_item_opens_the_guide(window: MainWindow, opened: list[str]) -> None:
    window.act_help.trigger()
    assert opened == [DOCS_URL]


def test_help_is_a_command_and_f1_is_not_used_elsewhere(window: MainWindow) -> None:
    """It shows in command search and the shortcut editor, and no other command has F1."""
    assert window.act_help in command_actions(window)
    assert action_id(window.act_help) == "help"
    f1 = QKeySequence(Qt.Key.Key_F1)
    holders = [
        a.text()
        for a in window.findChildren(QAction)
        if any(s == f1 for s in a.shortcuts()) and a.text()
    ]
    assert holders == ["Elanero &Help"]


def test_ribbon_question_mark_button_opens_the_guide(
    window: MainWindow, opened: list[str], qtbot
) -> None:
    button = window.ribbon.help_button
    assert isinstance(button, QToolButton)
    assert button.toolTip() == "Help (F1)"
    assert button.accessibleName() == "Help"
    assert button.isVisible()
    qtbot.mouseClick(button, Qt.MouseButton.LeftButton)
    assert opened == [DOCS_URL]


def test_ribbon_help_button_sits_between_search_and_the_chevron(window: MainWindow) -> None:
    ribbon = window.ribbon
    assert ribbon.search is not None
    assert ribbon.search.button.nextInFocusChain() is ribbon.help_button
    # Walking Tab from the search box reaches "?" before the chevron (other widgets of the
    # tab row may sit between them in Qt's chain; only the order matters here).
    walked: list[QWidget] = []
    widget = ribbon.search.button
    for _ in range(12):
        widget = widget.nextInFocusChain()
        walked.append(widget)
    assert walked.index(ribbon.help_button) < walked.index(ribbon.collapse_button)
    # Tab reaches it from the keyboard (a focus stop, not a click-only button).
    assert ribbon.help_button.focusPolicy() == Qt.FocusPolicy.TabFocus


def test_start_page_link_opens_the_guide(window: MainWindow, opened: list[str], qtbot) -> None:
    assert window.start_page.isVisible()
    link = window.start_page.guide_link
    assert link.text() == "Read the user guide"
    qtbot.mouseClick(link, Qt.MouseButton.LeftButton)
    assert opened == [DOCS_URL]


def test_about_documentation_link_opens_the_guide(qtbot, opened: list[str]) -> None:
    dialog = AboutDialog("", None)
    qtbot.addWidget(dialog)
    labels = [w for w in dialog.findChildren(QLabel) if "Documentation" in w.text()]
    assert len(labels) == 1
    label = labels[0]
    assert f'href="{DOCS_URL}"' in label.text()
    assert "Source code" in label.text() and "Privacy policy" in label.text()
    label.linkActivated.emit(DOCS_URL)
    assert opened == [DOCS_URL]


def test_about_source_and_privacy_links_go_to_the_browser_too(
    qtbot, monkeypatch: pytest.MonkeyPatch
) -> None:
    from pdfeditor import PRIVACY_URL, SOURCE_URL

    urls: list[str] = []
    monkeypatch.setattr(
        QDesktopServices,
        "openUrl",
        staticmethod(lambda url: urls.append(url.toString()) or True),
    )
    dialog = AboutDialog("", None)
    qtbot.addWidget(dialog)
    label = next(w for w in dialog.findChildren(QLabel) if "Documentation" in w.text())
    label.linkActivated.emit(SOURCE_URL)
    label.linkActivated.emit(PRIVACY_URL)
    assert urls == [SOURCE_URL, PRIVACY_URL]


def test_failed_open_shows_the_address(
    monkeypatch: pytest.MonkeyPatch, no_blocking_message_boxes: list[str]
) -> None:
    """No browser: the message names the address so the user can copy it."""
    monkeypatch.setattr(QDesktopServices, "openUrl", staticmethod(lambda _url: False))
    assert help_module.open_docs("ocr/") is False
    assert len(no_blocking_message_boxes) == 1
    assert DOCS_URL + "ocr/" in no_blocking_message_boxes[0]


def test_every_entry_point_reports_a_failed_open(
    window: MainWindow, monkeypatch: pytest.MonkeyPatch, no_blocking_message_boxes: list[str]
) -> None:
    monkeypatch.setattr(QDesktopServices, "openUrl", staticmethod(lambda _url: False))
    window.act_help.trigger()
    window.ribbon.help_button.click()
    window.start_page.guide_link.click()
    assert len(no_blocking_message_boxes) == 3
    assert all(DOCS_URL in text for text in no_blocking_message_boxes)
