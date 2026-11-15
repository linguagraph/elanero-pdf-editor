"""The Microsoft Store update indicator and install flow, with a fake backend (never the Store).

The window is a plain widget and the host a fake: the real main window's close prompts are
checked in test_main_window; here the install's own decisions are what matter."""

from __future__ import annotations

from collections.abc import Callable

import pytest
from PySide6.QtCore import QSettings
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import QWidget

from pdfeditor import bundle
from pdfeditor.services.store_updates import InstallOutcome, InstallResult
from pdfeditor.ui.settings import AppSettings
from pdfeditor.ui.store_updates import FIRST_CHECK_MS, StoreUpdates

pytestmark = pytest.mark.gui

STORE_URL = "ms-windows-store://pdp/?PFN=Publisher.Elanero_abc123"


class FakeBackend:
    def __init__(self, pending: int = 0, result: InstallResult | None = None) -> None:
        self.pending = pending
        self.result = result or InstallResult(InstallOutcome.INSTALLING)
        self.checks = 0
        self.installs: list[int] = []

    def pending_updates(self) -> int:
        self.checks += 1
        return self.pending

    def request_install(self, hwnd: int) -> InstallResult:
        self.installs.append(hwnd)
        return self.result


class FakeHost:
    def __init__(self, confirm: bool = True, close_ok: bool = True) -> None:
        self.confirm_answer = confirm
        self.close_answer = close_ok
        self.confirms = 0
        self.close_prompts = 0
        self.closed_for_update = 0
        self.notes: list[tuple[str, str]] = []

    def notify(self, text: str, kind: str = "info") -> object:
        self.notes.append((text, kind))
        return None

    def confirm(self, title: str, text: str, action_label: str) -> bool:
        self.confirms += 1
        return self.confirm_answer

    def confirm_close(self) -> bool:
        self.close_prompts += 1
        return self.close_answer

    def close_for_update(self) -> None:
        self.closed_for_update += 1


@pytest.fixture
def packaged(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(bundle, "is_packaged", lambda: True)


@pytest.fixture
def window(qtbot) -> QWidget:  # type: ignore[no-untyped-def]
    widget = QWidget()
    qtbot.addWidget(widget)
    return widget


@pytest.fixture
def prefs(tmp_path) -> AppSettings:  # type: ignore[no-untyped-def]
    return AppSettings(QSettings(str(tmp_path / "store.ini"), QSettings.Format.IniFormat))


def make(
    window: QWidget,
    prefs: AppSettings,
    host: FakeHost,
    backend: FakeBackend | None,
) -> StoreUpdates:
    return StoreUpdates(window, prefs, host, backend=backend)


def wait_until(qtbot, condition: Callable[[], bool]) -> None:  # type: ignore[no-untyped-def]
    qtbot.waitUntil(condition, timeout=5000)


def test_indicator_is_hidden_outside_the_store_build(window, prefs, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setattr(bundle, "is_packaged", lambda: False)
    controller = make(window, prefs, FakeHost(), FakeBackend(pending=3))
    controller.set_pending(3)
    assert controller.button.isHidden()
    controller.schedule()  # not the Store build: nothing is scheduled
    assert not controller._scheduled


def test_indicator_follows_the_pending_count(window, prefs, packaged) -> None:  # type: ignore[no-untyped-def]
    controller = make(window, prefs, FakeHost(), FakeBackend())
    assert controller.button.isHidden()  # hidden by default
    controller.set_pending(0)
    assert controller.button.isHidden()
    controller.set_pending(2)
    assert not controller.button.isHidden()
    assert controller.button.accessibleName()
    assert "Microsoft Store" in controller.button.toolTip()


def test_automatic_check_is_off_with_the_setting(window, prefs, packaged) -> None:  # type: ignore[no-untyped-def]
    prefs.check_store_updates = False
    backend = FakeBackend(pending=4)
    controller = make(window, prefs, FakeHost(), backend)
    controller._automatic_check()
    assert backend.checks == 0
    assert controller.button.isHidden()


def test_automatic_check_shows_the_indicator(qtbot, window, prefs, packaged) -> None:  # type: ignore[no-untyped-def]
    backend = FakeBackend(pending=1)
    controller = make(window, prefs, FakeHost(), backend)
    controller._automatic_check()
    wait_until(qtbot, lambda: not controller.button.isHidden())
    assert backend.checks == 1


def test_on_demand_check_reports_up_to_date(qtbot, window, prefs, packaged) -> None:  # type: ignore[no-untyped-def]
    host = FakeHost()
    controller = make(window, prefs, host, FakeBackend(pending=0))
    controller.check(on_demand=True)
    wait_until(qtbot, lambda: bool(host.notes))
    assert host.notes[-1] == ("Elanero is up to date.", "success")
    assert controller.button.isHidden()


def test_failed_check_is_not_reported_as_up_to_date(qtbot, window, prefs, packaged) -> None:  # type: ignore[no-untyped-def]
    class Broken(FakeBackend):
        def pending_updates(self) -> int:
            raise OSError("no Store")

    host = FakeHost()
    controller = make(window, prefs, host, Broken())
    controller.check(on_demand=True)
    wait_until(qtbot, lambda: bool(host.notes))
    assert host.notes[-1][1] == "error"


def test_cancelled_close_prompt_aborts_the_install(window, prefs, packaged) -> None:  # type: ignore[no-untyped-def]
    host = FakeHost(confirm=True, close_ok=False)
    backend = FakeBackend(pending=1)
    controller = make(window, prefs, host, backend)
    controller.install()
    assert host.confirms == 1 and host.close_prompts == 1
    assert backend.installs == []
    assert host.closed_for_update == 0


def test_declined_confirmation_asks_nothing_else(window, prefs, packaged) -> None:  # type: ignore[no-untyped-def]
    host = FakeHost(confirm=False)
    backend = FakeBackend(pending=1)
    make(window, prefs, host, backend).install()
    assert host.close_prompts == 0 and backend.installs == []


def test_successful_install_closes_the_window_without_asking_again(
    qtbot,
    window,
    prefs,
    packaged,  # type: ignore[no-untyped-def]
) -> None:
    host = FakeHost()
    backend = FakeBackend(pending=1)
    controller = make(window, prefs, host, backend)
    controller.install()
    wait_until(qtbot, lambda: host.closed_for_update == 1)
    assert backend.installs == [int(window.winId())]


def test_failed_install_opens_the_store_page(qtbot, window, prefs, packaged, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    opened: list[str] = []
    monkeypatch.setattr(
        QDesktopServices, "openUrl", lambda url: opened.append(url.toString()) or True
    )
    monkeypatch.setattr("pdfeditor.ui.store_updates.store_page_url", lambda: STORE_URL)
    host = FakeHost()
    backend = FakeBackend(pending=1, result=InstallResult(InstallOutcome.FAILED, "boom"))
    make(window, prefs, host, backend).install()
    wait_until(qtbot, lambda: bool(opened))
    assert opened == [STORE_URL]
    assert host.closed_for_update == 0
    assert host.notes and host.notes[-1][1] == "error"


def test_cancelled_store_prompt_says_so_and_stays_open(qtbot, window, prefs, packaged) -> None:  # type: ignore[no-untyped-def]
    host = FakeHost()
    backend = FakeBackend(pending=1, result=InstallResult(InstallOutcome.CANCELLED))
    make(window, prefs, host, backend).install()
    wait_until(qtbot, lambda: bool(host.notes))
    assert host.notes[-1][0] == "The update was not installed."
    assert host.closed_for_update == 0


def test_schedule_starts_once_in_the_store_build(window, prefs, packaged) -> None:  # type: ignore[no-untyped-def]
    controller = make(window, prefs, FakeHost(), FakeBackend())
    controller.schedule()
    controller.schedule()
    assert controller._scheduled and controller._repeat.isActive()
    assert FIRST_CHECK_MS == 15_000
    assert controller._repeat.interval() == 24 * 60 * 60 * 1000
