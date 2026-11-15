"""Microsoft Store updates for the Store (MSIX) build: is a newer Elanero out, and install it.

Headless (no Qt). The UI talks to :class:`StoreBackend`; :class:`WinRTStoreBackend` is the
real one, built on pywinrt (``winrt-runtime`` and ``winrt-Windows.Services.Store``). Every
``winrt`` import is inside a function, so importing this module (and the main window) never
loads WinRT. Nothing here is called unless the app runs from the Store package: see
``pdfeditor.ui.store_updates``.

What the pywinrt APIs are, as found in the installed packages (winrt-runtime 4.1,
winrt-windows-services-store 10.0.28000):

- ``StoreContext.get_default()`` returns the app's context. Its
  ``get_app_and_optional_store_package_updates_async()`` lists the package updates
  (an empty list when there are none). It shows no UI and needs no window.
- ``request_download_and_install_store_package_updates_async(updates)`` downloads and installs
  them, showing the Store's own UI. A desktop (full trust) app has to tell the context which
  window owns that UI first: ``IInitializeWithWindow::Initialize(hwnd)``. pywinrt exposes that
  as ``winrt.runtime.interop.initialize_with_window(context, hwnd)`` (``winrt._winrt``),
  which calls the interface on the object's ABI pointer, so no ctypes QueryInterface is
  needed. It has to run before the first UI call on that context, so the install asks for a
  fresh context and initializes it.
- The operations are awaitable (``IAsyncOperation.__await__``), so ``asyncio.run`` drives them
  on any thread. The UI runs them on a worker thread, never on the GUI thread.

Outside a Store install (a source run, a test, or another OS) the WinRT calls raise. That is
logged and reported as "no update known" or as a failed install, never as a crash.
"""

from __future__ import annotations

import asyncio
import logging
import sys
from dataclasses import dataclass
from enum import Enum
from typing import Protocol

from pdfeditor.bundle import package_family_name

log = logging.getLogger(__name__)


class InstallOutcome(Enum):
    INSTALLING = "installing"  # the Store took the update: Elanero should close
    CANCELLED = "cancelled"  # the user backed out of the Store's prompt
    FAILED = "failed"


@dataclass(frozen=True)
class InstallResult:
    outcome: InstallOutcome
    message: str = ""  # why it failed, for the log (never shown raw to the user)


class StoreBackend(Protocol):
    def pending_updates(self) -> int:
        """How many package updates the Store has for this app (0 when there are none)."""
        ...

    def request_install(self, hwnd: int) -> InstallResult:
        """Download and install the updates, with the Store's UI owned by window ``hwnd``."""
        ...


def store_page_url() -> str:
    """The app's page in the Store, for when the in-app install isn't possible."""
    family = package_family_name()
    if not family:
        return "ms-windows-store://home"
    return f"ms-windows-store://pdp/?PFN={family}"


def check_updates(backend: StoreBackend) -> int | None:
    """The number of pending updates, or None when the check couldn't be made (the failure is
    logged): the caller must not read that as "up to date"."""
    try:
        return max(0, int(backend.pending_updates()))
    except Exception:
        log.warning("the Microsoft Store update check failed", exc_info=True)
        return None


def install_update(backend: StoreBackend, hwnd: int) -> InstallResult:
    """Install the pending updates; a failure is a :class:`InstallResult` too, never raised."""
    try:
        return backend.request_install(hwnd)
    except Exception as exc:
        log.warning("the Microsoft Store install failed", exc_info=True)
        return InstallResult(InstallOutcome.FAILED, str(exc))


def default_backend() -> StoreBackend | None:
    """The WinRT backend on Windows; None elsewhere (nothing can be checked there)."""
    return WinRTStoreBackend() if sys.platform == "win32" else None


def _enter_mta() -> None:
    """Put the calling worker thread in COM's multithreaded apartment, which the Store calls
    expect from a thread that isn't the GUI thread. A thread that already has an apartment of
    another mode refuses (RPC_E_CHANGED_MODE); that is harmless, because the calls then run in
    the apartment the thread already has, so the error is only logged."""
    try:
        from winrt.runtime import ApartmentType, init_apartment

        init_apartment(ApartmentType.MULTI_THREADED)
    except Exception:
        log.debug("COM apartment left as it is", exc_info=True)


class WinRTStoreBackend:
    """:class:`StoreBackend` on pywinrt. Each call is self-contained: a fresh context and its
    own ``asyncio.run``, so it can be called from any worker thread. Each call first enters the
    multithreaded COM apartment (see :func:`_enter_mta`)."""

    def pending_updates(self) -> int:
        """Raises when WinRT can't answer (not a Store install, no network): see check_updates."""
        _enter_mta()
        from winrt.windows.services.store import StoreContext

        async def check() -> int:
            context = StoreContext.get_default()
            updates = await context.get_app_and_optional_store_package_updates_async()
            return len(updates)

        return asyncio.run(check())

    def request_install(self, hwnd: int) -> InstallResult:
        _enter_mta()
        from winrt.runtime.interop import initialize_with_window
        from winrt.windows.services.store import StoreContext, StorePackageUpdateState

        async def install() -> InstallResult:
            context = StoreContext.get_default()
            initialize_with_window(context, hwnd)  # before the first UI call (see module doc)
            updates = await context.get_app_and_optional_store_package_updates_async()
            if len(updates) == 0:
                return InstallResult(InstallOutcome.FAILED, "the Store has no update")
            result = await context.request_download_and_install_store_package_updates_async(updates)
            state = result.overall_state
            if state == StorePackageUpdateState.COMPLETED:
                return InstallResult(InstallOutcome.INSTALLING)
            if state == StorePackageUpdateState.CANCELED:
                return InstallResult(InstallOutcome.CANCELLED)
            return InstallResult(InstallOutcome.FAILED, f"the Store reported {state.name}")

        try:
            return asyncio.run(install())
        except Exception as exc:
            log.warning("the Microsoft Store install raised", exc_info=True)
            return InstallResult(InstallOutcome.FAILED, str(exc))
