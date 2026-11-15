"""The Store update against the real main window: the install never closes a window over
unsaved edits, the window is locked while the Store works, and closing with a check in flight
is quiet. The Store is a fake backend here."""

from __future__ import annotations

import threading
from collections.abc import Callable
from pathlib import Path

import pytest
from PySide6.QtWidgets import QMessageBox

from pdfeditor import bundle
from pdfeditor.core.session import DocumentSession
from pdfeditor.services.store_updates import InstallOutcome, InstallResult
from pdfeditor.ui.main_window import MainWindow

pytestmark = pytest.mark.gui


class ScriptedBackend:
    """A fake Store. ``request_install`` waits until the test releases it."""

    def __init__(self, pending: int = 0, result: InstallResult | None = None) -> None:
        self.pending = pending
        self.result = result or InstallResult(InstallOutcome.INSTALLING)
        self.release = threading.Event()
        self.installs: list[int] = []

    def pending_updates(self) -> int:
        self.release.wait(5)
        return self.pending

    def request_install(self, hwnd: int) -> InstallResult:
        self.installs.append(hwnd)
        self.release.wait(5)
        return self.result


@pytest.fixture
def store(monkeypatch: pytest.MonkeyPatch) -> ScriptedBackend:
    """Packaged, with a fake Store behind the main window (set before the window exists, so the
    window never reaches the real WinRT backend)."""
    monkeypatch.setattr(bundle, "is_packaged", lambda: True)
    backend = ScriptedBackend()
    monkeypatch.setattr("pdfeditor.ui.store_updates.default_backend", lambda: backend)
    return backend


def window_with_document(qtbot, fixture_pdf: Callable[[str], Path]) -> MainWindow:  # type: ignore[no-untyped-def]
    window = MainWindow()
    qtbot.addWidget(window)
    window.resize(1000, 700)
    window.show()
    qtbot.waitExposed(window)
    window.open_path(fixture_pdf("text_multipage"))
    return window


def test_edits_made_during_the_install_are_asked_about(
    qtbot, monkeypatch, fixture_pdf, store
) -> None:  # type: ignore[no-untyped-def]
    window = window_with_document(qtbot, fixture_pdf)
    dirty = {"on": False}
    monkeypatch.setattr(DocumentSession, "is_dirty", property(lambda self: dirty["on"]))
    answers: list[QMessageBox.StandardButton] = [QMessageBox.StandardButton.Cancel]
    prompts: list[DocumentSession] = []

    def ask(session: DocumentSession) -> QMessageBox.StandardButton:
        prompts.append(session)
        return answers[-1]

    notes: list[str] = []
    monkeypatch.setattr(window, "ask_save_changes", ask)
    monkeypatch.setattr(window, "confirm", lambda *args: True)  # "Install and Close"
    monkeypatch.setattr(window, "notify", lambda text, *a, **k: notes.append(text))

    window.store_updates.install()  # the prompts pass: nothing is dirty yet
    assert not window.centralWidget().isEnabled()  # locked while the Store works

    dirty["on"] = True  # the document is edited while the install runs
    store.release.set()
    qtbot.waitUntil(lambda: bool(notes), timeout=5000)

    assert len(prompts) == 1, "the edit made during the install was not asked about"
    assert notes == ["Close Elanero to finish installing the update."]
    assert window.isVisible(), "cancelling the prompt must keep the window open"
    assert window.centralWidget().isEnabled()  # unlocked again

    answers.append(QMessageBox.StandardButton.Discard)  # now let the window go
    assert window.close()


def test_a_clean_window_closes_when_the_install_is_in(
    qtbot, fixture_pdf, store, monkeypatch
) -> None:  # type: ignore[no-untyped-def]
    window = window_with_document(qtbot, fixture_pdf)
    handle = int(window.winId())  # read while the window is open
    monkeypatch.setattr(window, "confirm", lambda *args: True)  # "Install and Close"
    window.store_updates.install()
    store.release.set()
    qtbot.waitUntil(lambda: not window.isVisible(), timeout=5000)
    assert store.installs == [handle]


def test_closing_with_a_check_in_flight_raises_nothing(qtbot, store) -> None:  # type: ignore[no-untyped-def]
    window = MainWindow()
    qtbot.addWidget(window)
    window.show()
    qtbot.waitExposed(window)
    window.store_updates.check()  # the Store is still answering (the fake blocks)
    assert window.close()
    assert window.store_updates._closed
    store.release.set()
    qtbot.wait(300)  # the late answer arrives after the window closed: no error, no toast


def test_busy_lock_is_released_after_a_failed_install(
    qtbot, fixture_pdf, store, monkeypatch
) -> None:  # type: ignore[no-untyped-def]
    store.result = InstallResult(InstallOutcome.FAILED, "boom")
    window = window_with_document(qtbot, fixture_pdf)
    monkeypatch.setattr(window, "confirm", lambda *args: True)
    opened: list[str] = []
    from PySide6.QtGui import QDesktopServices

    monkeypatch.setattr(QDesktopServices, "openUrl", lambda url: opened.append("x") or True)
    window.store_updates.install()
    store.release.set()
    qtbot.waitUntil(lambda: bool(opened), timeout=5000)
    assert window.centralWidget().isEnabled()
    assert window.isVisible()
    assert window.close()
