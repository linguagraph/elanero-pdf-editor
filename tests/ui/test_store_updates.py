"""The Microsoft Store update indicator and install flow, with a fake backend (never the Store).

The window is a plain widget and the host a fake here; the real main window's close prompts and
its busy lock are checked in test_store_window."""

from __future__ import annotations

import os
import subprocess
import sys
import threading
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


class BlockingBackend(FakeBackend):
    """Holds each call until the test releases it, to keep a job in flight."""

    def __init__(self, pending: int = 0, result: InstallResult | None = None) -> None:
        super().__init__(pending, result)
        self.release = threading.Event()

    def pending_updates(self) -> int:
        self.release.wait(5)
        return super().pending_updates()

    def request_install(self, hwnd: int) -> InstallResult:
        self.release.wait(5)
        return super().request_install(hwnd)


class FakeHost:
    def __init__(
        self,
        confirm: bool = True,
        close_ok: bool = True,
        others: int = 0,
        close_after: bool = True,
    ) -> None:
        self.confirm_answer = confirm
        self.close_answer = close_ok  # the prompts before the install
        self.close_after_answer = close_after  # the close once the Store is done
        self.others = others
        self.confirms: list[str] = []
        self.close_prompts = 0
        self.closes = 0
        self.busy: list[bool] = []
        self.notes: list[tuple[str, str]] = []

    def notify(self, text: str, kind: str = "info") -> object:
        self.notes.append((text, kind))
        return None

    def confirm(self, title: str, text: str, action_label: str) -> bool:
        self.confirms.append(text)
        return self.confirm_answer

    def confirm_close(self) -> bool:
        self.close_prompts += 1
        return self.close_answer

    def close_after_update(self) -> bool:
        self.closes += 1
        return self.close_after_answer

    def set_update_busy(self, busy: bool) -> None:
        self.busy.append(busy)

    def other_windows(self) -> int:
        return self.others


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


def test_on_demand_check_while_one_runs_says_so(qtbot, window, prefs, packaged) -> None:  # type: ignore[no-untyped-def]
    host = FakeHost()
    backend = BlockingBackend(pending=0)
    controller = make(window, prefs, host, backend)
    controller.check()
    controller.check(on_demand=True)
    assert host.notes == [("A check is already running.", "info")]
    backend.release.set()
    wait_until(qtbot, lambda: controller._check_job is None)


def test_cancelled_close_prompt_aborts_the_install(window, prefs, packaged) -> None:  # type: ignore[no-untyped-def]
    host = FakeHost(confirm=True, close_ok=False)
    backend = FakeBackend(pending=1)
    controller = make(window, prefs, host, backend)
    controller.install()
    assert len(host.confirms) == 1 and host.close_prompts == 1
    assert backend.installs == []
    assert host.busy == []  # never locked: nothing was installed
    assert host.closes == 0


def test_declined_confirmation_asks_nothing_else(window, prefs, packaged) -> None:  # type: ignore[no-untyped-def]
    host = FakeHost(confirm=False)
    backend = FakeBackend(pending=1)
    make(window, prefs, host, backend).install()
    assert host.close_prompts == 0 and backend.installs == []


def test_confirmation_says_every_window_closes(window, prefs, packaged) -> None:  # type: ignore[no-untyped-def]
    host = FakeHost(confirm=False, others=0)
    make(window, prefs, host, FakeBackend(pending=1)).install()
    assert "closes every open Elanero window" in host.confirms[0]
    assert "other Elanero" not in host.confirms[0]

    host = FakeHost(confirm=False, others=1)
    make(window, prefs, host, FakeBackend(pending=1)).install()
    assert "One other Elanero window is open." in host.confirms[-1]
    assert "recovery copies" in host.confirms[-1]

    host = FakeHost(confirm=False, others=3)
    make(window, prefs, host, FakeBackend(pending=1)).install()
    assert "3 other Elanero windows are open." in host.confirms[-1]


def test_install_locks_the_window_then_asks_to_close(qtbot, window, prefs, packaged) -> None:  # type: ignore[no-untyped-def]
    host = FakeHost()
    backend = FakeBackend(pending=1)
    controller = make(window, prefs, host, backend)
    controller.install()
    wait_until(qtbot, lambda: host.closes == 1)
    assert backend.installs == [int(window.winId())]
    assert host.busy == [True, False]  # locked for the install, unlocked on the result


def test_refused_close_after_install_says_to_close(qtbot, window, prefs, packaged) -> None:  # type: ignore[no-untyped-def]
    host = FakeHost(close_after=False)  # the prompts pass, but the close is cancelled
    controller = make(window, prefs, host, FakeBackend(pending=1))
    controller.install()
    wait_until(qtbot, lambda: bool(host.notes))
    assert host.notes[-1] == ("Close Elanero to finish installing the update.", "info")


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
    assert host.closes == 0
    assert host.notes and host.notes[-1][1] == "error"
    assert host.busy == [True, False]


def test_cancelled_store_prompt_says_so_and_stays_open(qtbot, window, prefs, packaged) -> None:  # type: ignore[no-untyped-def]
    host = FakeHost()
    backend = FakeBackend(pending=1, result=InstallResult(InstallOutcome.CANCELLED))
    make(window, prefs, host, backend).install()
    wait_until(qtbot, lambda: bool(host.notes))
    assert host.notes[-1][0] == "The update was not installed."
    assert host.closes == 0


def test_closing_with_a_check_in_flight_raises_nothing(qtbot, window, prefs, packaged) -> None:  # type: ignore[no-untyped-def]
    host = FakeHost()
    backend = BlockingBackend(pending=2)
    controller = make(window, prefs, host, backend)
    controller.check(on_demand=True)
    controller.shutdown()  # the window is closing while the Store answers
    backend.release.set()
    qtbot.wait(300)  # the late result arrives; it must go nowhere
    assert controller.button.isHidden()
    assert host.notes == []  # a closing window reports nothing


def test_closing_with_a_failing_check_in_flight_raises_nothing(
    qtbot, window, prefs, packaged
) -> None:  # type: ignore[no-untyped-def]
    class Failing(BlockingBackend):
        def pending_updates(self) -> int:
            self.release.wait(5)
            raise OSError("no Store")

    host = FakeHost()
    backend = Failing()
    controller = make(window, prefs, host, backend)
    controller.check(on_demand=True)
    controller.shutdown()
    backend.release.set()
    qtbot.wait(300)
    assert host.notes == []


def test_schedule_starts_once_in_the_store_build(window, prefs, packaged) -> None:  # type: ignore[no-untyped-def]
    controller = make(window, prefs, FakeHost(), FakeBackend())
    controller.schedule()
    controller.schedule()
    assert controller._scheduled and controller._repeat.isActive()
    assert FIRST_CHECK_MS == 15_000
    assert controller._repeat.interval() == 24 * 60 * 60 * 1000


def test_shutdown_stops_the_daily_check(window, prefs, packaged) -> None:  # type: ignore[no-untyped-def]
    controller = make(window, prefs, FakeHost(), FakeBackend())
    controller.schedule()
    controller.shutdown()
    assert not controller._repeat.isActive()


def test_a_lone_instance_has_no_other_windows(tmp_path) -> None:  # type: ignore[no-untyped-def]
    from pdfeditor.ui.single_instance import InstanceSlot

    slot = InstanceSlot(root=tmp_path / "instances")
    try:
        assert slot.others_running() == 0
    finally:
        slot.release()


class TwoGates(FakeBackend):
    """Holds the check and the install separately, so a check can finish mid-install."""

    def __init__(self, pending: int = 0) -> None:
        super().__init__(pending)
        self.check_gate = threading.Event()
        self.install_gate = threading.Event()

    def pending_updates(self) -> int:
        self.check_gate.wait(5)
        return super().pending_updates()

    def request_install(self, hwnd: int) -> InstallResult:
        self.install_gate.wait(5)
        return super().request_install(hwnd)


def test_on_demand_check_during_an_install_says_so(qtbot, window, prefs, packaged) -> None:  # type: ignore[no-untyped-def]
    host = FakeHost()
    backend = BlockingBackend(pending=1)
    controller = make(window, prefs, host, backend)
    controller.install()
    controller.check(on_demand=True)
    assert host.notes == [("An update is installing.", "info")]
    backend.release.set()
    wait_until(qtbot, lambda: controller._install_job is None)


def test_a_check_result_mid_install_does_not_show_the_indicator(
    qtbot, window, prefs, packaged
) -> None:  # type: ignore[no-untyped-def]
    host = FakeHost()
    backend = TwoGates(pending=3)
    controller = make(window, prefs, host, backend)
    controller.check()
    controller.install()  # the install starts while the check is still running
    backend.check_gate.set()
    wait_until(qtbot, lambda: controller._check_job is None)
    assert controller.button.isHidden()  # the result came in during the install
    backend.install_gate.set()
    wait_until(qtbot, lambda: controller._install_job is None)


def _exited_process() -> subprocess.Popen[bytes]:
    process = subprocess.Popen([sys.executable, "-c", "pass"])
    process.wait()
    return process


def test_others_are_read_from_lock_files_without_taking_any_lock(
    tmp_path,
    monkeypatch,  # type: ignore[no-untyped-def]
) -> None:
    from PySide6.QtCore import QLockFile, QSysInfo

    from pdfeditor.ui.single_instance import InstanceSlot

    root = tmp_path / "instances"
    slot = InstanceSlot(root=root)  # our own slot, 0
    live = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    gone = _exited_process()
    host = QSysInfo.machineHostName()
    try:
        (root / "1.lock").write_text(f"{live.pid}\n{host}\npdfeditor\n", encoding="utf-8")
        (root / "2.lock").write_text(f"{gone.pid}\n{host}\npdfeditor\n", encoding="utf-8")

        def no_locking(self, *args):  # type: ignore[no-untyped-def]
            raise AssertionError("others_running must not take a lock")

        monkeypatch.setattr(QLockFile, "tryLock", no_locking)
        assert slot.others_running() == 1  # the live copy only; the stale file doesn't count
    finally:
        live.kill()
        live.wait()
        slot.release()


def test_pid_liveness() -> None:
    from pdfeditor.ui.single_instance import _pid_alive

    assert _pid_alive(os.getpid())
    assert not _pid_alive(_exited_process().pid)
