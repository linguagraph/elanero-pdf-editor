"""Translation settings and key storage: defaults, validation, and that API keys never reach the
settings file in plain text. The DPAPI round-trip runs on Windows only; the memory-only path is
checked everywhere by pretending DPAPI is missing."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from PySide6.QtCore import QSettings

from pdfeditor.core import secrets
from pdfeditor.core.secrets import SecretError
from pdfeditor.ui import settings as settings_module
from pdfeditor.ui.settings import AppSettings

pytestmark = pytest.mark.desktop_only

KEY = "sk-test-DEEPL-KEY-1234:fx"


def app_settings(path: Path) -> AppSettings:
    return AppSettings(QSettings(str(path), QSettings.Format.IniFormat))


@pytest.fixture(autouse=True)
def no_session_keys() -> None:
    settings_module._SESSION_KEYS.clear()


def test_translation_defaults_are_off_and_mymemory(tmp_path: Path) -> None:
    prefs = app_settings(tmp_path / "s.ini")
    assert prefs.translation_enabled is False  # nothing is sent before the user agrees
    assert prefs.translation_service == "mymemory"
    assert prefs.translation_email == ""
    assert prefs.libretranslate_url == ""
    assert prefs.translation_target == ""
    assert prefs.translation_last_source == ""


def test_unknown_service_falls_back_to_default(tmp_path: Path) -> None:
    prefs = app_settings(tmp_path / "s.ini")
    prefs.qs.setValue("translation/service", "google")
    assert prefs.translation_service == "mymemory"
    prefs.translation_service = "nonsense"
    assert prefs.translation_service == "mymemory"
    prefs.translation_service = "deepl"
    assert prefs.translation_service == "deepl"


def test_preferences_round_trip(tmp_path: Path) -> None:
    path = tmp_path / "s.ini"
    prefs = app_settings(path)
    prefs.translation_enabled = True
    prefs.translation_email = "  me@example.com "
    prefs.libretranslate_url = "https://lt.example.org"
    prefs.translation_target = "de"
    prefs.translation_last_source = "fr"
    again = app_settings(path)
    assert again.translation_enabled is True
    assert again.translation_email == "me@example.com"
    assert again.libretranslate_url == "https://lt.example.org"
    assert again.translation_target == "de"
    assert again.translation_last_source == "fr"


def test_key_is_not_stored_in_plain_text_on_windows(tmp_path: Path) -> None:
    if not secrets.can_encrypt():
        pytest.skip("DPAPI is available on Windows only")
    path = tmp_path / "s.ini"
    prefs = app_settings(path)
    prefs.set_translation_key("deepl", KEY)
    stored = prefs.qs.value("translation/deepl_key")
    assert isinstance(stored, str) and stored
    assert stored != KEY
    prefs.qs.sync()  # QSettings writes its file lazily
    assert KEY not in path.read_text(encoding="utf-8", errors="replace")
    # A fresh reader of the same settings, the next day, gets the key back.
    assert app_settings(path).translation_key("deepl") == KEY
    assert app_settings(path).translation_config().deepl_key == KEY


def test_empty_key_removes_the_stored_value(tmp_path: Path) -> None:
    if not secrets.can_encrypt():
        pytest.skip("DPAPI is available on Windows only")
    prefs = app_settings(tmp_path / "s.ini")
    prefs.set_translation_key("deepl", KEY)
    prefs.set_translation_key("deepl", "  ")
    assert prefs.translation_key("deepl") == ""
    assert prefs.qs.value("translation/deepl_key") is None


def test_undecryptable_key_reads_as_empty(tmp_path: Path) -> None:
    if not secrets.can_encrypt():
        pytest.skip("DPAPI is available on Windows only")
    prefs = app_settings(tmp_path / "s.ini")
    prefs.qs.setValue("translation/deepl_key", "bm90IGEgc2VjcmV0")  # base64, not DPAPI data
    assert prefs.translation_key("deepl") == ""


def test_without_dpapi_keys_stay_in_memory_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(secrets, "can_encrypt", lambda: False)
    path = tmp_path / "s.ini"
    prefs = app_settings(path)
    prefs.set_translation_key("libretranslate", "lt-key-value")
    assert prefs.translation_key("libretranslate") == "lt-key-value"
    assert app_settings(path).translation_key("libretranslate") == "lt-key-value"  # this run
    assert prefs.qs.value("translation/libretranslate_key") is None
    assert (
        "lt-key-value" not in path.read_text(encoding="utf-8", errors="replace")
        if path.exists()
        else True
    )
    prefs.set_translation_key("libretranslate", "")
    assert prefs.translation_key("libretranslate") == ""


def test_secret_errors_are_raised_where_dpapi_is_missing() -> None:
    if sys.platform == "win32":
        pytest.skip("the non-Windows stubs are only reachable off Windows")
    with pytest.raises(SecretError):
        secrets.encrypt(b"x")
    with pytest.raises(SecretError):
        secrets.decrypt(b"x")


def test_dpapi_round_trip() -> None:
    if not secrets.can_encrypt():
        pytest.skip("DPAPI is available on Windows only")
    sealed = secrets.encrypt(KEY.encode("utf-8"))
    assert KEY.encode("utf-8") not in sealed
    assert secrets.decrypt(sealed) == KEY.encode("utf-8")
