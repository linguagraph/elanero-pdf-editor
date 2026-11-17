"""The startup splash can be turned off: the setting, the factory that picks the null splash
(which must not decode the splash art), and the Preferences checkbox."""

from __future__ import annotations

from pathlib import Path

import pytest
from PySide6.QtCore import QSettings
from PySide6.QtWidgets import QApplication, QWidget

from pdfeditor import bundle
from pdfeditor.ui import branding
from pdfeditor.ui.dialogs.preferences import PreferencesDialog
from pdfeditor.ui.settings import AppSettings

pytestmark = pytest.mark.gui


def fresh(path: Path) -> AppSettings:
    return AppSettings(QSettings(str(path), QSettings.Format.IniFormat))


def test_splash_is_shown_by_default_and_the_choice_persists(tmp_path: Path) -> None:
    path = tmp_path / "splash.ini"
    assert fresh(path).show_splash is True
    settings = fresh(path)
    settings.show_splash = False
    settings.qs.sync()
    assert fresh(path).show_splash is False
    settings = fresh(path)
    settings.show_splash = True
    settings.qs.sync()
    assert fresh(path).show_splash is True


def test_store_update_check_is_on_by_default_and_persists(tmp_path: Path) -> None:
    path = tmp_path / "store.ini"
    assert fresh(path).check_store_updates is True
    settings = fresh(path)
    settings.check_store_updates = False
    settings.qs.sync()
    assert fresh(path).check_store_updates is False


def test_disabled_splash_is_a_null_splash_and_decodes_nothing(
    qapp: QApplication, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Builds a QWidget, so it needs the application itself: run alone, it aborted the process.
    def decoded(*args: object, **kwargs: object) -> None:
        raise AssertionError("the splash art was decoded")

    monkeypatch.setattr(branding, "splash_pixmap", decoded)
    monkeypatch.setattr(branding, "LoadingSplash", decoded)
    splash = branding.startup_splash("dark", enabled=False)
    assert isinstance(splash, branding.NullSplash)
    # The same calls as the real splash, none of them showing anything.
    splash.set_progress(0.5)
    splash.finish(QWidget())
    assert splash.close() is True


def test_enabled_splash_uses_the_real_splash(monkeypatch: pytest.MonkeyPatch) -> None:
    shown: list[str] = []

    class Splash:
        def __init__(self, theme: str) -> None:
            shown.append(theme)

    monkeypatch.setattr(branding, "show_splash", Splash)
    assert isinstance(branding.startup_splash("light", enabled=True), Splash)
    assert shown == ["light"]


def test_preferences_round_trip_the_splash_and_store_options(
    qtbot,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,  # type: ignore[no-untyped-def]
) -> None:
    settings = fresh(tmp_path / "prefs.ini")
    monkeypatch.setattr(bundle, "is_packaged", lambda: True)
    dialog = PreferencesDialog(settings)
    qtbot.addWidget(dialog)
    assert dialog.show_splash.isChecked() and dialog.store_check.isChecked()
    dialog.show_splash.setChecked(False)
    dialog.store_check.setChecked(False)
    dialog.accept()
    settings.qs.sync()
    assert settings.show_splash is False and settings.check_store_updates is False

    again = PreferencesDialog(fresh(tmp_path / "prefs.ini"))
    qtbot.addWidget(again)
    assert not again.show_splash.isChecked() and not again.store_check.isChecked()


def test_store_option_is_only_offered_in_the_store_build(
    qtbot,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,  # type: ignore[no-untyped-def]
) -> None:
    monkeypatch.setattr(bundle, "is_packaged", lambda: False)
    dialog = PreferencesDialog(fresh(tmp_path / "prefs.ini"))
    qtbot.addWidget(dialog)
    assert dialog.store_check.isHidden()
    assert not dialog.show_splash.isHidden()
