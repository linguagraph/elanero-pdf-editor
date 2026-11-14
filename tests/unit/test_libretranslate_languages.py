"""LibreTranslate's language list: fetched by Test connection, stored as (our code, server code,
name) with its address, offered under our codes, and sent with the server's own codes. The
address is normalised by one function everywhere. Mocked HTTP only."""

from __future__ import annotations

import json
import urllib.request
from pathlib import Path

import pytest
from PySide6.QtCore import QSettings

from pdfeditor.services.translation import make_translator
from pdfeditor.services.translation.base import OfflineError, TranslationError
from pdfeditor.services.translation.http import Reply
from pdfeditor.services.translation.libretranslate import (
    LibreTranslateTranslator,
    check_url,
    normalize_url,
)
from pdfeditor.ui.settings import AppSettings

SERVER_LIST = [
    {"code": "en", "name": "English"},
    {"code": "nb", "name": "Norwegian Bokmål", "targets": ["en"]},
    {"code": "zh-Hans", "name": "Chinese (Simplified)"},
    {"code": "de", "name": "German"},
]


class Recorder:
    def __init__(self, *replies: Reply | Exception) -> None:
        self.replies = list(replies)
        self.urls: list[str] = []
        self.bodies: list[bytes] = []

    def __call__(self, request: urllib.request.Request, timeout: float) -> Reply:
        self.urls.append(request.full_url)
        self.bodies.append(request.data or b"")
        reply = self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]
        if isinstance(reply, Exception):
            raise reply
        return reply


def translated_body(rec: Recorder) -> dict[str, object]:
    return json.loads(rec.bodies[0].decode("utf-8"))


def settings_in(tmp_path: Path) -> AppSettings:
    return AppSettings(QSettings(str(tmp_path / "s.ini"), QSettings.Format.IniFormat))


def ok_translation() -> Reply:
    return Reply(200, json.dumps({"translatedText": "x"}).encode("utf-8"))


# -- fetching and storing ------------------------------------------------------------------------


def test_fetch_returns_our_code_server_code_and_name() -> None:
    rec = Recorder(Reply(200, json.dumps(SERVER_LIST).encode("utf-8")))
    languages = LibreTranslateTranslator("https://lt.example.org", opener=rec).fetch_languages()
    assert rec.urls == ["https://lt.example.org/languages"]
    assert ("no", "nb", "Norwegian Bokmål") in languages
    assert ("zh", "zh-Hans", "Chinese (Simplified)") in languages
    assert ("de", "de", "German") in languages


def test_a_failed_fetch_raises_and_is_not_guessed() -> None:
    rec = Recorder(OfflineError("gone"))
    with pytest.raises(TranslationError):
        LibreTranslateTranslator("https://lt.example.org", opener=rec).fetch_languages()


def test_the_stored_list_is_offered_only_for_its_own_address(tmp_path: Path) -> None:
    prefs = settings_in(tmp_path)
    prefs.store_libretranslate_languages("https://lt.example.org/", [("no", "nb", "Norwegian")])
    assert prefs.libretranslate_language_list("https://lt.example.org") == [
        ("no", "nb", "Norwegian")
    ]
    assert prefs.libretranslate_language_list("https://other.example.org") is None
    assert prefs.libretranslate_language_list("") is None


def test_one_normaliser_serves_the_address_and_the_stored_list(tmp_path: Path) -> None:
    assert normalize_url("  https://lt.example.org/ ") == "https://lt.example.org"
    assert check_url("  https://lt.example.org/ ") == normalize_url("https://lt.example.org")
    prefs = settings_in(tmp_path)
    prefs.store_libretranslate_languages(" https://lt.example.org/ ", [("de", "de", "German")])
    assert prefs.libretranslate_language_list("https://lt.example.org") == [("de", "de", "German")]


def test_the_saved_config_carries_the_list_for_the_saved_address(tmp_path: Path) -> None:
    prefs = settings_in(tmp_path)
    prefs.libretranslate_url = "https://lt.example.org"
    prefs.store_libretranslate_languages("https://lt.example.org", [("no", "nb", "Norwegian")])
    config = prefs.translation_config()
    assert config.libretranslate_languages == [("no", "nb", "Norwegian")]
    assert "no" in make_translator("libretranslate", config).languages()


def test_a_stored_value_that_is_not_a_list_of_triples_is_ignored(tmp_path: Path) -> None:
    prefs = settings_in(tmp_path)
    prefs.qs.setValue("translation/libretranslate_languages_url", "https://lt.example.org")
    prefs.qs.setValue("translation/libretranslate_languages", "[1, 2]")
    assert prefs.libretranslate_language_list("https://lt.example.org") is None


# -- which codes are offered and sent ------------------------------------------------------------


def test_the_server_codes_are_offered_under_our_codes() -> None:
    translator = LibreTranslateTranslator(
        "https://lt.example.org",
        languages=[
            ("no", "nb", "Norwegian Bokmål"),
            ("zh", "zh-Hans", "Chinese"),
            ("de", "de", "German"),
        ],
    )
    offered = translator.languages()
    assert set(offered) == {"no", "zh", "de"}
    assert offered["no"] == "Norwegian Bokmål"


def test_norwegian_is_sent_as_the_servers_nb() -> None:
    rec = Recorder(ok_translation())
    translator = LibreTranslateTranslator(
        "https://lt.example.org", languages=[("no", "nb", "Norwegian")], opener=rec
    )
    translator.translate("hi", "en", "no")
    assert translated_body(rec)["target"] == "nb"


def test_a_server_that_lists_only_zh_gets_zh() -> None:
    rec = Recorder(ok_translation())
    translator = LibreTranslateTranslator(
        "https://lt.example.org", languages=[("zh", "zh", "Chinese")], opener=rec
    )
    translator.translate("hi", "en", "zh")
    assert translated_body(rec)["target"] == "zh"


def test_a_server_that_lists_only_zh_hans_gets_zh_hans() -> None:
    rec = Recorder(ok_translation())
    translator = LibreTranslateTranslator(
        "https://lt.example.org", languages=[("zh", "zh-Hans", "Chinese")], opener=rec
    )
    translator.translate("hi", "en", "zh")
    assert translated_body(rec)["target"] == "zh-Hans"


def test_when_both_nb_and_no_are_listed_the_static_choice_wins_and_both_are_kept() -> None:
    rec = Recorder(ok_translation())
    listed = [("no", "no", "Norwegian (no)"), ("no", "nb", "Norwegian Bokmål")]
    translator = LibreTranslateTranslator("https://lt.example.org", languages=listed, opener=rec)
    translator.translate("hi", "en", "no")
    assert translated_body(rec)["target"] == "nb"
    assert translator.languages()["no"] == "Norwegian Bokmål"
    assert len(listed) == 2  # the other code is still in the stored list


def test_when_both_zh_and_zh_hans_are_listed_the_static_choice_wins() -> None:
    rec = Recorder(ok_translation())
    listed = [("zh", "zh", "Chinese"), ("zh", "zh-Hans", "Chinese (Simplified)")]
    translator = LibreTranslateTranslator("https://lt.example.org", languages=listed, opener=rec)
    translator.translate("hi", "en", "zh")
    assert translated_body(rec)["target"] == "zh-Hans"


def test_a_language_not_on_the_servers_list_is_sent_as_ours() -> None:
    rec = Recorder(ok_translation())
    translator = LibreTranslateTranslator(
        "https://lt.example.org", languages=[("de", "de", "German")], opener=rec
    )
    translator.translate("hi", "en", "fr")
    assert translated_body(rec)["target"] == "fr"


def test_without_a_stored_list_the_static_codes_are_used() -> None:
    rec = Recorder(ok_translation())
    LibreTranslateTranslator("https://lt.example.org", opener=rec).translate("hi", "en", "no")
    assert translated_body(rec)["target"] == "nb"
