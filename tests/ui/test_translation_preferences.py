"""Preferences → Translation, review follow-ups: switching translation on records consent for the
service chosen there, a plain-http LibreTranslate server is flagged, the connection test says
what it sends, and nothing is saved when a key can't be encrypted or the setup is incomplete."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from PySide6.QtCore import QSettings
from PySide6.QtWidgets import QLabel, QMessageBox

from pdfeditor.core import secrets
from pdfeditor.core.secrets import SecretError
from pdfeditor.ui.dialogs.preferences import PreferencesDialog
from pdfeditor.ui.settings import AppSettings

pytestmark = pytest.mark.gui


@pytest.fixture
def settings(tmp_path: Path) -> AppSettings:
    prefs = AppSettings(QSettings(str(tmp_path / "prefs.ini"), QSettings.Format.IniFormat))
    prefs.translation_enabled = False
    prefs.translation_consented = ""
    return prefs


@pytest.fixture
def warnings(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    shown: list[str] = []
    monkeypatch.setattr(QMessageBox, "warning", lambda _parent, _title, text: shown.append(text))
    return shown


def test_switching_translation_on_records_consent_for_the_chosen_service(
    qtbot, settings: AppSettings
) -> None:
    d = PreferencesDialog(settings)
    qtbot.addWidget(d)
    d.translation_enabled.setChecked(True)
    d.translation_service.setCurrentIndex(d.translation_service.findData("deepl"))
    d.deepl_key.setText("key-123:fx")
    d.accept()
    assert settings.translation_enabled is True
    assert settings.translation_consented == "deepl-free"


def test_switching_off_keeps_the_record_but_disables(qtbot, settings: AppSettings) -> None:
    settings.translation_enabled = True
    settings.translation_consented = "mymemory"
    d = PreferencesDialog(settings)
    qtbot.addWidget(d)
    d.translation_enabled.setChecked(False)
    d.accept()
    assert settings.translation_enabled is False
    assert settings.translation_consented == "mymemory"


def test_plain_http_to_a_remote_server_is_flagged(qtbot, settings: AppSettings) -> None:
    d = PreferencesDialog(settings)
    qtbot.addWidget(d)
    d.translation_service.setCurrentIndex(d.translation_service.findData("libretranslate"))
    d.libre_url.setText("http://lt.example.org")
    assert not d.libre_warning.isHidden()
    assert "unencrypted" in d.libre_warning.text()
    d.libre_url.setText("https://lt.example.org")
    assert d.libre_warning.isHidden()


@pytest.mark.parametrize(
    "address", ["http://localhost:5000", "http://127.0.0.1", "http://[::1]:5000"]
)
def test_plain_http_on_this_computer_is_not_flagged(
    qtbot, settings: AppSettings, address: str
) -> None:
    d = PreferencesDialog(settings)
    qtbot.addWidget(d)
    d.libre_url.setText(address)
    assert d.libre_warning.isHidden()


def test_the_connection_test_says_what_it_sends(qtbot, settings: AppSettings) -> None:
    d = PreferencesDialog(settings)
    qtbot.addWidget(d)
    captions = [label.text() for label in d.findChildren(QLabel)]
    assert "Sends a short test text to the service." in captions


def test_a_key_that_cant_be_encrypted_saves_nothing(
    qtbot, settings: AppSettings, monkeypatch: pytest.MonkeyPatch, warnings: list[str]
) -> None:
    def refuse(_data: bytes) -> bytes:
        raise SecretError("Windows refused")

    monkeypatch.setattr(secrets, "can_encrypt", lambda: True)
    monkeypatch.setattr(secrets, "encrypt", refuse)
    before: dict[str, Any] = {"author": settings.author, "service": settings.translation_service}
    d = PreferencesDialog(settings)
    qtbot.addWidget(d)
    d.author.setText("Someone else")
    d.translation_service.setCurrentIndex(d.translation_service.findData("deepl"))
    d.deepl_key.setText("key-123:fx")
    d.accept()
    assert warnings and "couldn't be saved" in warnings[0]
    assert settings.author == before["author"]
    assert settings.translation_service == before["service"]
    assert settings.translation_key("deepl") == ""


def test_switching_on_with_no_server_address_saves_nothing(
    qtbot, settings: AppSettings, warnings: list[str]
) -> None:
    d = PreferencesDialog(settings)
    qtbot.addWidget(d)
    d.translation_enabled.setChecked(True)
    d.translation_service.setCurrentIndex(d.translation_service.findData("libretranslate"))
    d.libre_url.setText("")
    d.accept()
    assert warnings and "LibreTranslate server address" in warnings[0]
    assert settings.translation_enabled is False
    assert settings.translation_consented == ""
