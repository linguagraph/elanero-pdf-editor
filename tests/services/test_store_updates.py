"""Microsoft Store updates: the service is headless and every WinRT failure becomes a safe result.

A fake :class:`StoreBackend` stands in for the Store. The WinRT backend is tested against a fake
``winrt`` module put in ``sys.modules``, so these tests never reach the real Store, whatever
Windows they run on."""

from __future__ import annotations

import sys
import types

import pytest

from pdfeditor.services import store_updates as su
from pdfeditor.services.store_updates import (
    InstallOutcome,
    InstallResult,
    WinRTStoreBackend,
    check_updates,
    install_update,
    store_page_url,
)

pytestmark = pytest.mark.desktop_only


class FakeBackend:
    def __init__(self, pending: int = 0, result: InstallResult | None = None) -> None:
        self.pending = pending
        self.result = result or InstallResult(InstallOutcome.INSTALLING)
        self.installs: list[int] = []

    def pending_updates(self) -> int:
        return self.pending

    def request_install(self, hwnd: int) -> InstallResult:
        self.installs.append(hwnd)
        return self.result


class RaisingBackend:
    def pending_updates(self) -> int:
        raise OSError("no Store here")

    def request_install(self, hwnd: int) -> InstallResult:
        raise OSError("no Store here")


def test_check_reports_the_pending_count() -> None:
    assert check_updates(FakeBackend(pending=2)) == 2
    assert check_updates(FakeBackend(pending=0)) == 0


def test_a_failed_check_is_unknown_not_up_to_date(caplog: pytest.LogCaptureFixture) -> None:
    assert check_updates(RaisingBackend()) is None
    assert "update check failed" in caplog.text


def test_a_failed_install_is_a_result_not_an_exception() -> None:
    result = install_update(RaisingBackend(), 1234)
    assert result.outcome is InstallOutcome.FAILED
    assert "no Store here" in result.message


def test_install_passes_the_window_handle_through() -> None:
    backend = FakeBackend(result=InstallResult(InstallOutcome.CANCELLED))
    assert install_update(backend, 77).outcome is InstallOutcome.CANCELLED
    assert backend.installs == [77]


def test_store_page_url_names_the_package_family(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(su, "package_family_name", lambda: "Publisher.App_abc123")
    assert store_page_url() == "ms-windows-store://pdp/?PFN=Publisher.App_abc123"


def test_store_page_url_without_a_package_opens_the_store_home(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(su, "package_family_name", lambda: None)
    assert store_page_url() == "ms-windows-store://home"


def _fake_winrt(monkeypatch: pytest.MonkeyPatch, context: object) -> None:
    """Put a stand-in ``winrt.windows.services.store`` (and interop) in ``sys.modules``."""

    class StoreContext:
        @staticmethod
        def get_default() -> object:
            return context

    class StorePackageUpdateState:
        COMPLETED = 3
        CANCELED = 4

    store = types.ModuleType("winrt.windows.services.store")
    store.StoreContext = StoreContext  # type: ignore[attr-defined]
    store.StorePackageUpdateState = StorePackageUpdateState  # type: ignore[attr-defined]
    interop = types.ModuleType("winrt.runtime.interop")
    interop.initialize_with_window = lambda obj, hwnd: None  # type: ignore[attr-defined]
    for name, module in {
        "winrt": types.ModuleType("winrt"),
        "winrt.runtime": types.ModuleType("winrt.runtime"),
        "winrt.runtime.interop": interop,
        "winrt.windows": types.ModuleType("winrt.windows"),
        "winrt.windows.services": types.ModuleType("winrt.windows.services"),
        "winrt.windows.services.store": store,
    }.items():
        monkeypatch.setitem(sys.modules, name, module)


class _Context:
    def __init__(self, updates: list[object], state: int = 3) -> None:
        self.updates = updates
        self.state = state

    async def get_app_and_optional_store_package_updates_async(self) -> list[object]:
        return self.updates

    async def request_download_and_install_store_package_updates_async(
        self, updates: list[object]
    ) -> object:
        return types.SimpleNamespace(overall_state=self.state)


def test_winrt_backend_counts_updates(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_winrt(monkeypatch, _Context(updates=[object(), object()]))
    assert WinRTStoreBackend().pending_updates() == 2


def test_winrt_backend_install_maps_the_store_state(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_winrt(monkeypatch, _Context(updates=[object()], state=3))
    assert WinRTStoreBackend().request_install(5).outcome is InstallOutcome.INSTALLING
    _fake_winrt(monkeypatch, _Context(updates=[object()], state=4))
    assert WinRTStoreBackend().request_install(5).outcome is InstallOutcome.CANCELLED
    _fake_winrt(monkeypatch, _Context(updates=[object()], state=5))
    assert WinRTStoreBackend().request_install(5).outcome is InstallOutcome.FAILED


def test_winrt_backend_with_no_update_fails_the_install(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_winrt(monkeypatch, _Context(updates=[]))
    assert WinRTStoreBackend().request_install(5).outcome is InstallOutcome.FAILED


def test_winrt_errors_turn_into_safe_results(monkeypatch: pytest.MonkeyPatch) -> None:
    class Broken:
        async def get_app_and_optional_store_package_updates_async(self) -> list[object]:
            raise OSError("0x80073D54 no package identity")

    _fake_winrt(monkeypatch, Broken())
    assert check_updates(WinRTStoreBackend()) is None
    assert install_update(WinRTStoreBackend(), 5).outcome is InstallOutcome.FAILED


def test_missing_winrt_is_a_safe_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    # An import error (pywinrt not installed, or another OS) is still just "unknown".
    for name in ("winrt.windows.services.store", "winrt.windows.services", "winrt.windows"):
        monkeypatch.setitem(sys.modules, name, None)  # None makes the import fail
    assert check_updates(WinRTStoreBackend()) is None
    assert install_update(WinRTStoreBackend(), 5).outcome is InstallOutcome.FAILED


def test_default_backend_is_none_off_windows(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(su.sys, "platform", "linux")
    assert su.default_backend() is None
