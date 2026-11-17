"""Translation rules added after review: MyMemory's quota signals, same-language requests,
cache identity per service configuration, per-service language codes, partial results and
caps, the cleanup of hyphenated breaks, and transport error mapping. Mocked HTTP only."""

from __future__ import annotations

import http.client
import json
from typing import Any

import pytest

from pdfeditor.services import translation as tr
from pdfeditor.services.translation.base import (
    ConfigError,
    OfflineError,
    QuotaError,
    SameLanguageError,
    ServiceError,
    TooLongError,
    Translation,
)
from pdfeditor.services.translation.deepl import DeepLTranslator
from pdfeditor.services.translation.http import Reply, Request, request_json
from pdfeditor.services.translation.libretranslate import LibreTranslateTranslator, check_url
from pdfeditor.services.translation.mymemory import MyMemoryTranslator
from pdfeditor.services.translation.text import clean_pdf_text


class Recorder:
    def __init__(self, *replies: Reply | Exception) -> None:
        self.replies = list(replies)
        self.requests: list[Request] = []

    def __call__(self, request: Request, timeout: float) -> Reply:
        self.requests.append(request)
        reply = self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]
        if isinstance(reply, Exception):
            raise reply
        return reply


def ok(payload: Any) -> Reply:
    return Reply(200, json.dumps(payload).encode("utf-8"))


def body_of(request: Request) -> dict[str, Any]:
    assert request.data is not None
    return json.loads(request.data.decode("utf-8"))


@pytest.fixture(autouse=True)
def fresh_cache() -> None:
    tr.clear_cache()


# -- MyMemory quota signals --------------------------------------------------------------------


def test_mymemory_403_with_a_message_is_a_service_error_not_quota() -> None:
    reply = ok(
        {
            "responseData": {"translatedText": ""},
            "responseStatus": 403,
            "responseDetails": "INVALID LANGUAGE PAIR",
        }
    )
    with pytest.raises(ServiceError) as info:
        MyMemoryTranslator(opener=Recorder(reply)).translate("x", "en", "fr")
    assert not isinstance(info.value, QuotaError)
    assert "INVALID LANGUAGE PAIR" in info.value.message


@pytest.mark.parametrize(
    "details",
    ["YOU USED ALL AVAILABLE FREE TRANSLATIONS", "MYMEMORY WARNING", "NEXT AVAILABLE in 3 hours"],
)
def test_mymemory_quota_warnings_in_the_details_are_quota(details: str) -> None:
    reply = ok(
        {"responseData": {"translatedText": ""}, "responseStatus": 200, "responseDetails": details}
    )
    with pytest.raises(QuotaError):
        MyMemoryTranslator(opener=Recorder(reply)).translate("x", "en", "fr")


def test_mymemory_http_429_is_quota() -> None:
    with pytest.raises(QuotaError):
        MyMemoryTranslator(opener=Recorder(Reply(429, b""))).translate("x", "en", "fr")


def test_mymemory_other_http_status_is_a_service_error() -> None:
    with pytest.raises(ServiceError):
        MyMemoryTranslator(opener=Recorder(Reply(403, b""))).translate("x", "en", "fr")


# -- same language -----------------------------------------------------------------------------


def test_same_language_is_refused_without_a_request() -> None:
    rec = Recorder(ok({"translatedText": "x"}))
    echo = MyMemoryTranslator(opener=rec)
    with pytest.raises(SameLanguageError) as info:
        tr.translate_selection(echo, "Hello there", "en", "en-US")
    assert "already in that language" in info.value.message
    assert rec.requests == []


def test_detected_source_is_not_compared_to_the_target() -> None:
    class Detect(MyMemoryTranslator):
        detects_source = True

    class Fake:
        id = "fake"
        cache_id = "fake"
        name = "Fake"
        max_request_bytes = 500
        max_text_chars = 10_000

        def translate(self, text, source, target, token=None):  # type: ignore[no-untyped-def]
            return Translation(f"[{text}]", "en", "fake")

    result = tr.translate_selection(Fake(), "Hello there", None, "en")
    assert result.text == "[Hello there]"


# -- cache identity ----------------------------------------------------------------------------


def test_cache_ids_follow_the_service_configuration() -> None:
    assert DeepLTranslator("k:fx").cache_id == "deepl-free"
    assert DeepLTranslator("k").cache_id == "deepl-pro"
    assert MyMemoryTranslator().cache_id == "mymemory"
    keyed = LibreTranslateTranslator("https://lt.example.org", "key").cache_id
    assert keyed == "libretranslate:https://lt.example.org:True"
    assert LibreTranslateTranslator("https://lt.example.org").cache_id.endswith(":False")


def test_two_libretranslate_servers_do_not_share_cache_entries() -> None:
    first = Recorder(ok({"translatedText": "[one]"}))
    second = Recorder(ok({"translatedText": "[two]"}))
    a = LibreTranslateTranslator("https://one.example.org", opener=first)
    b = LibreTranslateTranslator("https://two.example.org", opener=second)
    assert tr.translate_selection(a, "Hello there", "en", "de").text == "[one]"
    assert tr.translate_selection(b, "Hello there", "en", "de").text == "[two]"
    assert len(first.requests) == 1 and len(second.requests) == 1


def test_same_server_with_the_same_text_is_served_from_cache() -> None:
    rec = Recorder(ok({"translatedText": "[one]"}))
    a = LibreTranslateTranslator("https://one.example.org", opener=rec)
    tr.translate_selection(a, "Hello there", "en", "de")
    tr.translate_selection(a, "Hello there", "en", "de")
    assert len(rec.requests) == 1


# -- per-service language codes ----------------------------------------------------------------


def test_deepl_maps_norwegian_to_nb_for_source_and_target() -> None:
    rec = Recorder(ok({"translations": [{"text": "x"}]}))
    DeepLTranslator("k:fx", opener=rec).translate("hej", "no", "no")
    assert body_of(rec.requests[0])["target_lang"] == "NB"
    assert body_of(rec.requests[0])["source_lang"] == "NB"


def test_mymemory_maps_chinese_and_norwegian_in_the_language_pair() -> None:
    rec = Recorder(ok({"responseData": {"translatedText": "x"}, "responseStatus": 200}))
    MyMemoryTranslator(opener=rec).translate("hi", "zh", "no")
    assert "langpair=zh-CN%7Cnb" in rec.requests[0].url


def test_libretranslate_maps_norwegian_and_chinese() -> None:
    rec = Recorder(ok({"translatedText": "x"}))
    LibreTranslateTranslator("https://lt.example.org", opener=rec).translate("hi", "zh", "no")
    body = body_of(rec.requests[0])
    assert body["source"] == "zh-Hans"
    assert body["target"] == "nb"


# -- partial results and caps -------------------------------------------------------------------


class FailsLater:
    """Translates the first request, then fails with the given error."""

    id = "fails"
    cache_id = "fails"
    name = "Fails later"
    detects_source = False
    max_request_bytes = 20
    max_text_chars = 10_000

    def __init__(self, error: Exception) -> None:
        self.error = error
        self.calls = 0

    def translate(self, text, source, target, token=None):  # type: ignore[no-untyped-def]
        self.calls += 1
        if self.calls > 1:
            raise self.error
        return Translation(f"[{text}]", None, self.id)


def test_a_mid_way_error_carries_the_translated_chunks_as_partial() -> None:
    from pdfeditor.services.translation.base import OfflineError as Offline

    fake = FailsLater(Offline("gone"))
    text = "First sentence here. Second sentence follows now. Third one ends it."
    with pytest.raises(OfflineError) as info:
        tr.translate_selection(fake, text, "en", "fr")
    assert info.value.partial.startswith("[First sentence")
    assert info.value.partial.count("[") == 1
    assert "Second" not in info.value.partial


def test_a_failure_before_any_chunk_has_an_empty_partial() -> None:
    class Broken(FailsLater):
        def translate(self, text, source, target, token=None):  # type: ignore[no-untyped-def]
            raise ServiceError("nope")

    with pytest.raises(ServiceError) as info:
        tr.translate_selection(Broken(ServiceError("x")), "Hello there", "en", "fr")
    assert info.value.partial == ""


def test_mymemory_caps_a_selection_at_2000_characters_and_names_the_limit() -> None:
    translator = MyMemoryTranslator(opener=Recorder(ok({})))
    assert translator.max_text_chars == 2000
    with pytest.raises(TooLongError) as info:
        tr.translate_selection(translator, "word " * 500, "en", "fr")  # 2500 characters
    assert "2,000 characters" in info.value.message
    assert "MyMemory" in info.value.message


def test_other_services_keep_the_10000_character_cap() -> None:
    assert DeepLTranslator("k:fx").max_text_chars == 10_000
    assert LibreTranslateTranslator("https://lt.example.org").max_text_chars == 10_000


# -- cleanup of hyphenated breaks ----------------------------------------------------------------


def test_hyphen_before_a_function_word_is_kept_with_a_space() -> None:
    assert clean_pdf_text("Ein-\nund Ausgang") == "Ein- und Ausgang"


def test_line_break_hyphen_is_removed() -> None:
    assert clean_pdf_text("trans-\nlation") == "translation"


def test_hyphenated_word_seen_elsewhere_keeps_its_hyphen() -> None:
    assert (
        clean_pdf_text("a well-\nknown idea, and well-known again")
        == "a well-known idea, and well-known again"
    )


def test_soft_hyphens_and_unicode_hyphens_are_handled() -> None:
    assert clean_pdf_text("con­stant") == "constant"
    assert clean_pdf_text("trans‐\nlation") == "translation"
    assert clean_pdf_text("well‑known") == "well-known"


# -- transport error mapping --------------------------------------------------------------------


def test_invalid_url_error_is_a_service_error() -> None:
    def opener(request: Request, timeout: float) -> Reply:
        raise http.client.InvalidURL("bad url")

    with pytest.raises(ServiceError):
        request_json("https://x.example.org/", opener=opener)


def test_value_error_from_the_address_is_a_service_error() -> None:
    def opener(request: Request, timeout: float) -> Reply:
        raise ValueError("unknown url type")

    with pytest.raises(ServiceError):
        request_json("https://x.example.org/", opener=opener)


def test_broken_http_response_is_an_offline_error() -> None:
    def opener(request: Request, timeout: float) -> Reply:
        raise http.client.RemoteDisconnected("closed")

    with pytest.raises(OfflineError):
        request_json("https://x.example.org/", opener=opener)


def test_check_url_rejects_empty_hosts_and_whitespace() -> None:
    for bad in ("https://", "https://lt .example.org", "https://lt.example.org/a b"):
        with pytest.raises(ServiceError):
            check_url(bad)
    with pytest.raises(ConfigError):
        check_url("   ")


def test_libretranslate_privacy_link_is_the_notice_not_the_server() -> None:
    translator = LibreTranslateTranslator("https://lt.example.org")
    assert translator.privacy_url == tr.PRIVACY_NOTICE_URL
