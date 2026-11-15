"""The Microsoft Store update check, its toolbar indicator and the install (Store build only).

The checks run as background jobs (:class:`pdfeditor.ui.jobs.Job`): 15 seconds after the window
is shown, then once a day, and on demand from Help. Nothing happens unless the app runs from the
Store package, and the automatic checks also need the preference on. The service behind it is
:mod:`pdfeditor.services.store_updates`.
"""

from __future__ import annotations

import logging
from typing import Protocol

from PySide6.QtCore import QObject, Qt, QTimer, QUrl
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import QToolButton, QWidget

from pdfeditor import bundle
from pdfeditor.services.store_updates import (
    InstallOutcome,
    InstallResult,
    StoreBackend,
    check_updates,
    default_backend,
    install_update,
    store_page_url,
)
from pdfeditor.ui.icons import icon
from pdfeditor.ui.jobs import Job
from pdfeditor.ui.settings import AppSettings
from pdfeditor.ui.toasts import Kind

log = logging.getLogger(__name__)

FIRST_CHECK_MS = 15_000  # after the window is shown
REPEAT_MS = 24 * 60 * 60 * 1000  # then once a day while the app runs


class UpdateHost(Protocol):
    """What the update controller needs from the main window."""

    def notify(self, text: str, kind: Kind = "info") -> object: ...

    def confirm(self, title: str, text: str, action_label: str) -> bool: ...

    def confirm_close(self) -> bool:
        """The window's normal close flow (the save and discard prompts); False if cancelled."""
        ...

    def close_for_update(self) -> None:
        """Close the window now, without asking again (the prompts were answered)."""
        ...


class StoreUpdates(QObject):
    def __init__(
        self,
        window: QWidget,
        prefs: AppSettings,
        host: UpdateHost,
        backend: StoreBackend | None = None,
    ) -> None:
        super().__init__(window)
        self._window = window
        self.prefs = prefs
        self.host = host
        self.backend: StoreBackend | None = backend if backend is not None else default_backend()
        self._job: Job | None = None
        self._scheduled = False
        self._repeat = QTimer(self)
        self._repeat.setInterval(REPEAT_MS)
        self._repeat.timeout.connect(self._automatic_check)

        self.button = QToolButton(window)
        self.button.setObjectName("StoreUpdateButton")
        self.button.setText(self.tr("Update available"))
        self.button.setIcon(icon("circle-alert"))
        self.button.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextBesideIcon)
        self.button.setAutoRaise(True)
        self.button.setToolTip(
            self.tr(
                "A new version of Elanero is available in the Microsoft Store. Click to install it."
            )
        )
        self.button.setAccessibleName(self.tr("Install the Microsoft Store update"))
        self.button.clicked.connect(self.install)
        self.button.hide()

    # -- state --------------------------------------------------------------------------
    @property
    def busy(self) -> bool:
        return self._job is not None

    def set_pending(self, count: int) -> None:
        """Show the indicator while Store updates are pending (Store build only)."""
        self.button.setVisible(count > 0 and bundle.is_packaged())

    # -- checks -------------------------------------------------------------------------
    def schedule(self) -> None:
        """Called when the window is shown: the first check 15 s later, then every 24 hours.
        Only in the Store build, and only once."""
        if self._scheduled or self.backend is None or not bundle.is_packaged():
            return
        self._scheduled = True
        QTimer.singleShot(FIRST_CHECK_MS, self._automatic_check)
        self._repeat.start()

    def _automatic_check(self) -> None:
        if self.prefs.check_store_updates:
            self.check()

    def check(self, on_demand: bool = False) -> None:
        """Ask the Store in the background. ``on_demand`` (Help > Check for Updates) also says
        what it found, even when the automatic checks are off."""
        if self.busy or self.backend is None or not bundle.is_packaged():
            if on_demand:
                self.host.notify(self.tr("Couldn't check the Microsoft Store right now."), "error")
            return
        backend = self.backend

        def work(job: Job) -> int | None:
            return check_updates(backend)

        job = Job(work, label=self.tr("Check the Microsoft Store for updates"))
        job.finished.connect(lambda count: self._on_checked(count, on_demand))
        job.failed.connect(lambda _message: self._on_checked(None, on_demand))
        self._job = job
        job.start()

    def _on_checked(self, count: object, on_demand: bool) -> None:
        self._job = None
        if count is None or not isinstance(count, int):
            if on_demand:
                self.host.notify(self.tr("Couldn't check the Microsoft Store right now."), "error")
            return
        self.set_pending(count)
        if not on_demand:
            return
        if count > 0:
            self.host.notify(
                self.tr(
                    "A new version of Elanero is available. Use “Update available” to install it."
                )
            )
        else:
            self.host.notify(self.tr("Elanero is up to date."), "success")

    # -- install ------------------------------------------------------------------------
    def install(self) -> None:
        """Install the pending update. The user confirms that Elanero closes; the window's
        close prompts come next and any cancel aborts the whole thing."""
        if self.busy or self.backend is None or not bundle.is_packaged():
            return
        if not self.host.confirm(
            self.tr("Install the update?"),
            self.tr(
                "Installing the new version from the Microsoft Store closes Elanero. "
                "You'll be asked about unsaved changes first."
            ),
            self.tr("Install and Close"),
        ):
            return
        if not self.host.confirm_close():
            return
        backend = self.backend
        hwnd = int(self._window.winId())

        def work(job: Job) -> InstallResult:
            return install_update(backend, hwnd)

        job = Job(work, label=self.tr("Install the Microsoft Store update"))
        job.finished.connect(self._on_installed)
        job.failed.connect(
            lambda message: self._on_installed(InstallResult(InstallOutcome.FAILED, message))
        )
        self._job = job
        job.start()

    def _on_installed(self, result: object) -> None:
        self._job = None
        if not isinstance(result, InstallResult):
            result = InstallResult(InstallOutcome.FAILED, "no result")
        if result.outcome is InstallOutcome.INSTALLING:
            self.button.hide()
            self.host.close_for_update()
        elif result.outcome is InstallOutcome.CANCELLED:
            self.host.notify(self.tr("The update was not installed."))
        else:
            log.info("in-app install failed (%s); opening the Store page", result.message)
            QDesktopServices.openUrl(QUrl(store_page_url()))
            self.host.notify(
                self.tr("Elanero can't install the update here. The Microsoft Store page is open."),
                "error",
            )
