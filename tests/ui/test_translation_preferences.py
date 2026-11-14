"""Preferences → Translation: switching translation on records consent for the service chosen
there, a plain-http LibreTranslate server is flagged, the connection test says what it sends and
stores the server's language list, and a translation problem never blocks the other preferences:
translation is left off, the reason is said once, and everything else is saved."""

from __future__ import annotations

import json
import urllib.request
from pathlib import Path
from typing import Any

import pytest
from PySide6.QtCore import QSettings
from PySide6.QtWidgets import QLabel, QMessageBox

from pdfeditor.core import secrets
from pdfeditor.core.secrets import SecretError
from pdfeditor.services.translation.http import Reply
from pdfeditor.services.translation.libretranslate import LibreTranslateTranslator
from pdfeditor.ui.dialogs import preferences as prefs_module
from pdfeditor.ui.dialogs.preferences import PreferencesDialog
from pdfeditor.ui.settings import AppSettings

pytestmark = pytest.mark.gui

URL = "https://lt.example.org"


@pytest.fixture
def settings(tmp_path: Path) -> AppSettings:
    prefs = AppSettings(QSettings(str(tmp_path / "prefs.ini"), QSettings.Format.IniFormat))
    prefs.translation_enabled = False
    prefs.translation_consented = ""
    prefs.author = "Before"
    return prefs


@pytest.fixture
def messages(monkeypatch: pytest.MonkeyPatch) -> dict[str, list[str]]:
    shown: dict[str, list[str]] = {"information": [], "warning": []}
    monkeypatch.setattr(
        QMessageBox, "information", lambda _p, _t, text: shown["information"].append(text)
    )
    monkeypatch.setattr(QMessageBox, "warning", lambda _p, _t, text: shown["warning"].append(text))
    return shown


def encryption_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse(_data: bytes) -> bytes:
        raise SecretError("Windows refused")

    monkeypatch.setattr(secrets, "can_encrypt", lambda: True)
    monkeypatch.setattr(secrets, "encrypt", refuse)


def test_switching_translation_on_records_consent_for_the_chosen_service(
    qtbot, settings: AppSettings, messages
) -> None:
    d = PreferencesDialog(settings)
    qtbot.addWidget(d)
    d.translation_enabled.setChecked(True)
    d.translation_service.setCurrentIndex(d.translation_service.findData("deepl"))
    d.deepl_key.setText("key-123:fx")
    d.accept()
    assert settings.translation_enabled is True
    assert settings.translation_consented == "deepl-free"
    assert messages["information"] == []


def test_switching_off_keeps_the_record_but_disables(
    qtbot, settings: AppSettings, messages
) -> None:
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


def test_a_key_that_cant_be_encrypted_turns_translation_off_and_saves_the_rest(
    qtbot, settings: AppSettings, monkeypatch: pytest.MonkeyPatch, messages
) -> None:
    settings.set_translation_key("deepl", "old-key:fx")  # what is stored now
    encryption_fails(monkeypatch)
    d = PreferencesDialog(settings)
    qtbot.addWidget(d)
    d.author.setText("Someone else")
    d.zoom.setCurrentIndex(d.zoom.findData("100"))
    d.translation_enabled.setChecked(True)
    d.translation_service.setCurrentIndex(d.translation_service.findData("deepl"))
    d.deepl_key.setText("new-key:fx")
    d.accept()
    assert settings.author == "Someone else"  # the other preferences are saved
    assert settings.default_zoom == "100"
    assert settings.translation_enabled is False
    assert settings.translation_consented == ""  # no consent recorded
    assert settings.translation_key("deepl") == "old-key:fx"  # the old key is kept
    assert len(messages["information"]) == 1
    text = messages["information"][0]
    assert text.startswith("Translation was left off: ")
    assert "DeepL key couldn't be saved" in text
    assert text.endswith("Your other preferences were saved.")


def test_an_unneeded_key_that_cant_be_encrypted_leaves_translation_on(
    qtbot, settings: AppSettings, monkeypatch: pytest.MonkeyPatch, messages
) -> None:
    encryption_fails(monkeypatch)
    d = PreferencesDialog(settings)
    qtbot.addWidget(d)
    d.author.setText("Kept")
    d.translation_enabled.setChecked(True)
    d.translation_service.setCurrentIndex(d.translation_service.findData("mymemory"))
    d.deepl_key.setText("unused:fx")  # not the chosen service's key
    d.accept()
    assert settings.author == "Kept"
    assert settings.translation_enabled is True
    assert settings.translation_consented == "mymemory"
    assert len(messages["information"]) == 1
    assert "DeepL key couldn't be saved" in messages["information"][0]
    assert messages["information"][0].endswith("Your other preferences were saved.")


def test_switching_on_with_no_server_address_turns_translation_off(
    qtbot, settings: AppSettings, messages
) -> None:
    d = PreferencesDialog(settings)
    qtbot.addWidget(d)
    d.author.setText("Kept")
    d.translation_enabled.setChecked(True)
    d.translation_service.setCurrentIndex(d.translation_service.findData("libretranslate"))
    d.libre_url.setText("")
    d.accept()
    assert settings.author == "Kept"
    assert settings.translation_enabled is False
    assert settings.translation_consented == ""
    assert settings.translation_service == "libretranslate"  # the valid service choice is saved
    assert len(messages["information"]) == 1
    assert "LibreTranslate server address" in messages["information"][0]
    assert messages["information"][0].startswith("Translation was left off: ")


def test_switching_on_without_a_deepl_key_turns_translation_off(
    qtbot, settings: AppSettings, messages
) -> None:
    d = PreferencesDialog(settings)
    qtbot.addWidget(d)
    d.author.setText("Kept")
    d.translation_enabled.setChecked(True)
    d.translation_service.setCurrentIndex(d.translation_service.findData("deepl"))
    d.accept()
    assert settings.author == "Kept"
    assert settings.translation_enabled is False
    assert "the DeepL API key is missing" in messages["information"][0]


def test_switching_on_without_an_azure_key_turns_translation_off(
    qtbot, settings: AppSettings, messages
) -> None:
    d = PreferencesDialog(settings)
    qtbot.addWidget(d)
    d.translation_enabled.setChecked(True)
    d.translation_service.setCurrentIndex(d.translation_service.findData("azure"))
    d.accept()
    assert settings.translation_enabled is False
    assert "the Azure key is missing" in messages["information"][0]


def test_azure_key_and_region_are_saved(qtbot, settings: AppSettings, messages) -> None:
    d = PreferencesDialog(settings)
    qtbot.addWidget(d)
    d.translation_service.setCurrentIndex(d.translation_service.findData("azure"))
    d.azure_key.setText("azure-secret")
    d.azure_region.setText(" westeurope ")
    d.accept()
    assert settings.translation_service == "azure"
    assert settings.translation_key("azure") == "azure-secret"
    assert settings.azure_region == "westeurope"
    assert messages["information"] == []


def test_the_azure_fields_show_only_for_azure(qtbot, settings: AppSettings) -> None:
    d = PreferencesDialog(settings)
    qtbot.addWidget(d)
    d.translation_service.setCurrentIndex(d.translation_service.findData("azure"))
    assert not d._service_groups["azure"].isHidden()
    assert d._service_groups["deepl"].isHidden()
    d.translation_service.setCurrentIndex(d.translation_service.findData("mymemory"))
    assert d._service_groups["azure"].isHidden()


def fake_server(languages_ok: bool) -> Any:
    """An opener for a LibreTranslate server: /translate answers, /languages answers or fails."""
    server_list = [{"code": "nb", "name": "Norwegian Bokmål"}, {"code": "de", "name": "German"}]

    def opener(request: urllib.request.Request, timeout: float) -> Reply:
        if request.full_url.endswith("/languages"):
            if languages_ok:
                return Reply(200, json.dumps(server_list).encode("utf-8"))
            return Reply(500, b"{}")
        return Reply(200, json.dumps({"translatedText": "Hallo"}).encode("utf-8"))

    return opener


def run_test_connection(qtbot, d: PreferencesDialog) -> None:
    d.test_button.click()
    qtbot.waitUntil(lambda: d._test_job is None, timeout=5000)


def test_test_connection_stores_the_servers_language_list(
    qtbot, settings: AppSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        prefs_module,
        "make_translator",
        lambda _sid, _cfg: LibreTranslateTranslator(URL, opener=fake_server(True)),
    )
    d = PreferencesDialog(settings)
    qtbot.addWidget(d)
    d.translation_service.setCurrentIndex(d.translation_service.findData("libretranslate"))
    d.libre_url.setText(URL)
    run_test_connection(qtbot, d)
    assert d.test_status.text() == "Connected. The service answered."
    assert settings.libretranslate_language_list(URL) == [
        ("no", "nb", "Norwegian Bokmål"),
        ("de", "de", "German"),
    ]


def test_a_failed_language_fetch_still_passes_and_keeps_the_stored_list(
    qtbot, settings: AppSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings.store_libretranslate_languages(URL, [("fr", "fr", "French")])
    monkeypatch.setattr(
        prefs_module,
        "make_translator",
        lambda _sid, _cfg: LibreTranslateTranslator(URL, opener=fake_server(False)),
    )
    d = PreferencesDialog(settings)
    qtbot.addWidget(d)
    d.translation_service.setCurrentIndex(d.translation_service.findData("libretranslate"))
    d.libre_url.setText(URL)
    run_test_connection(qtbot, d)
    assert d.test_status.text() == "Connected. The service answered."
    assert settings.libretranslate_language_list(URL) == [("fr", "fr", "French")]


def test_the_default_language_offers_only_the_servers_list(qtbot, settings: AppSettings) -> None:
    settings.translation_service = "libretranslate"
    settings.libretranslate_url = URL
    settings.store_libretranslate_languages(
        URL, [("no", "nb", "Norwegian"), ("de", "de", "German")]
    )
    d = PreferencesDialog(settings)
    qtbot.addWidget(d)
    codes = {d.target.itemData(i) for i in range(d.target.count())}
    assert codes == {"", "no", "de"}


def test_a_failed_encryption_message_names_the_key_once(
    qtbot, settings: AppSettings, monkeypatch: pytest.MonkeyPatch, messages
) -> None:
    encryption_fails(monkeypatch)
    d = PreferencesDialog(settings)
    qtbot.addWidget(d)
    d.azure_key.setText("az-key")
    d.accept()
    assert len(messages["information"]) == 1
    assert messages["warning"] == []


def test_a_key_is_encrypted_once_and_saving_cannot_fail_halfway(
    qtbot, settings: AppSettings, monkeypatch: pytest.MonkeyPatch, messages
) -> None:
    import base64

    from PySide6.QtWidgets import QDialog

    calls: list[bytes] = []

    def once_then_refuse(data: bytes) -> bytes:
        calls.append(data)
        if len(calls) == 1:
            return b"sealed-bytes"
        raise SecretError("a second encryption is refused")

    monkeypatch.setattr(secrets, "can_encrypt", lambda: True)
    monkeypatch.setattr(secrets, "encrypt", once_then_refuse)
    d = PreferencesDialog(settings)
    qtbot.addWidget(d)
    d.author.setText("Saved")
    d.deepl_key.setText("key-123:fx")
    d.accept()
    assert len(calls) == 1  # the key is encrypted once, and that ciphertext is what's stored
    assert settings.author == "Saved"  # the other settings were saved
    stored = settings.qs.value("translation/deepl_key")
    assert stored == base64.b64encode(b"sealed-bytes").decode("ascii")
    assert d.result() == QDialog.DialogCode.Accepted  # the dialog still closes
    assert messages["information"] == []


def test_a_saved_zh_hant_for_azure_survives_open_and_ok(
    qtbot, settings: AppSettings, messages
) -> None:
    settings.translation_service = "azure"
    settings.translation_target = "zh-Hant"
    d = PreferencesDialog(settings)
    qtbot.addWidget(d)
    assert d.target.currentData() == "zh-Hant"  # offered by Azure, so selected
    d.accept()
    assert settings.translation_target == "zh-Hant"


def test_an_unknown_saved_target_survives_open_and_ok(
    qtbot, settings: AppSettings, messages
) -> None:
    settings.translation_target = "xx-Unknown"
    d = PreferencesDialog(settings)
    qtbot.addWidget(d)
    assert d.target.currentData() == "xx-Unknown"  # listed under its own code, not dropped
    d.accept()
    assert settings.translation_target == "xx-Unknown"


def test_switching_service_keeps_a_shared_selection(qtbot, settings: AppSettings, messages) -> None:
    settings.translation_service = "mymemory"
    settings.translation_target = "de"
    d = PreferencesDialog(settings)
    qtbot.addWidget(d)
    d.translation_service.setCurrentIndex(d.translation_service.findData("deepl"))
    assert d.target.currentData() == "de"
    d.translation_service.setCurrentIndex(d.translation_service.findData("azure"))
    assert d.target.currentData() == "de"
    d.accept()
    assert settings.translation_target == "de"
    # A choice another service offers is still kept when switching, not dropped.
    d2 = PreferencesDialog(settings)
    qtbot.addWidget(d2)
    d2.translation_service.setCurrentIndex(d2.translation_service.findData("azure"))
    d2.target.setCurrentIndex(d2.target.findData("zh-Hant"))
    d2.translation_service.setCurrentIndex(d2.translation_service.findData("mymemory"))
    assert d2.target.currentData() == "zh-Hant"
