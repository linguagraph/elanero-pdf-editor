"""Translation service: text cleanup, chunking, each client's requests and responses, error
mapping, cancellation and the cache. Every request goes through a fake opener, never the
network."""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from typing import Any

import pytest

from pdfeditor.core.jobs import Cancelled, CancelToken
from pdfeditor.services import translation as tr
from pdfeditor.services.translation.base import (
    AuthError,
    ConfigError,
    OfflineError,
    QuotaError,
    ServiceError,
    TooLongError,
    Translation,
    TranslationError,
)
from pdfeditor.services.translation.deepl import DeepLTranslator, host_for
from pdfeditor.services.translation.http import Reply
from pdfeditor.services.translation.libretranslate import LibreTranslateTranslator, check_url
from pdfeditor.services.translation.mymemory import MyMemoryTranslator
from pdfeditor.services.translation.text import clean_pdf_text, split_chunks


class Recorder:
    """A fake opener: returns the scripted replies in order and records each request."""

    def __init__(self, *replies: Reply | Exception) -> None:
        self.replies = list(replies)
        self.requests: list[urllib.request.Request] = []

    def __call__(self, request: urllib.request.Request, timeout: float) -> Reply:
        self.requests.append(request)
        assert timeout > 0
        reply = self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]
        if isinstance(reply, Exception):
            raise reply
        return reply


def ok(payload: Any, status: int = 200) -> Reply:
    return Reply(status, json.dumps(payload).encode("utf-8"))


def body_of(request: urllib.request.Request) -> dict[str, Any]:
    assert request.data is not None
    return json.loads(request.data.decode("utf-8"))


def query_of(url: str) -> dict[str, list[str]]:
    return urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)


@pytest.fixture(autouse=True)
def fresh_cache() -> None:
    tr.clear_cache()


# -- text cleanup ----------------------------------------------------------------------------


def test_clean_joins_hard_line_breaks_within_a_paragraph() -> None:
    assert (
        clean_pdf_text("A sentence that\nwraps over\nlines.") == "A sentence that wraps over lines."
    )


def test_clean_dehyphenates_only_before_a_lowercase_letter() -> None:
    assert clean_pdf_text("a trans-\nlation of") == "a translation of"
    # A capital after the break means a real hyphen (a name, or a compound), so it stays.
    assert clean_pdf_text("the Anglo-\nSaxon") == "the Anglo- Saxon"


def test_clean_keeps_paragraph_breaks_and_collapses_spaces() -> None:
    raw = "First   para\ncontinues.\r\n\r\n\nSecond\t para.  "
    assert clean_pdf_text(raw) == "First para continues.\n\nSecond para."


def test_clean_of_blank_text_is_empty() -> None:
    assert clean_pdf_text("  \n \n ") == ""


# -- chunking --------------------------------------------------------------------------------


def test_chunks_join_back_to_the_text_and_fit_the_byte_limit() -> None:
    text = ("Ünïcode words, mixed with 中文字符和日本語. " * 40).strip()
    for limit in (4, 9, 50, 500):
        chunks = split_chunks(text, limit)
        assert "".join(chunks) == text
        assert all(len(c.encode("utf-8")) <= limit for c in chunks)


def test_chunks_never_split_a_multibyte_character() -> None:
    text = "ééééé中中中"  # 2-byte and 3-byte characters, no spaces to cut at
    chunks = split_chunks(text, 5)
    assert "".join(chunks) == text
    for chunk in chunks:
        chunk.encode("utf-8").decode("utf-8")  # raises if a code point was cut
        assert len(chunk.encode("utf-8")) <= 5


def test_chunks_prefer_sentence_boundaries() -> None:
    chunks = split_chunks("One short one. Two is here. Three follows now.", 25)
    assert chunks[0] == "One short one. "


def test_chunks_split_cjk_at_sentence_punctuation() -> None:
    chunks = split_chunks("你好世界。这是第二句话。", 15)
    assert chunks[0] == "你好世界。"


def test_chunks_fall_back_to_whitespace_then_hard_cut() -> None:
    assert split_chunks("alpha beta gamma", 11) == ["alpha beta ", "gamma"]
    assert split_chunks("abcdefghij", 4) == ["abcd", "efgh", "ij"]


def test_short_text_is_one_chunk() -> None:
    assert split_chunks("short", 500) == ["short"]


def test_limit_too_small_for_one_character_is_rejected() -> None:
    with pytest.raises(ValueError):
        split_chunks("text", 3)


# -- MyMemory --------------------------------------------------------------------------------


def test_mymemory_request_has_url_and_params() -> None:
    rec = Recorder(ok({"responseData": {"translatedText": "Hallo"}, "responseStatus": 200}))
    result = MyMemoryTranslator(opener=rec).translate("Hello", "en", "de")
    assert result == Translation("Hallo", None, "mymemory")
    request = rec.requests[0]
    assert request.get_method() == "GET"
    assert request.full_url.split("?")[0] == "https://api.mymemory.translated.net/get"
    # No email is sent unless the user gave one.
    assert query_of(request.full_url) == {"q": ["Hello"], "langpair": ["en|de"]}
    assert request.get_header("User-agent") == "Elanero"


def test_mymemory_sends_the_optional_email() -> None:
    rec = Recorder(ok({"responseData": {"translatedText": "x"}, "responseStatus": "200"}))
    MyMemoryTranslator(email=" me@example.com ", opener=rec).translate("a", "en", "fr")
    assert query_of(rec.requests[0].full_url)["de"] == ["me@example.com"]


def test_mymemory_unescapes_html_entities() -> None:
    rec = Recorder(
        ok({"responseData": {"translatedText": "Tom &amp; Jerry &#39;s"}, "responseStatus": 200})
    )
    assert MyMemoryTranslator(opener=rec).translate("x", "en", "fr").text == "Tom & Jerry 's"


def test_mymemory_cannot_detect_the_source() -> None:
    rec = Recorder(ok({}))
    translator = MyMemoryTranslator(opener=rec)
    assert translator.detects_source is False
    with pytest.raises(ServiceError, match="Choose the language"):
        translator.translate("x", None, "fr")
    assert rec.requests == []


@pytest.mark.parametrize(
    "reply",
    [
        Reply(429, b""),
        ok({"responseData": {"translatedText": "x"}, "responseStatus": 429}),
        ok(
            {
                "responseData": {"translatedText": "MYMEMORY WARNING: YOU USED ALL"},
                "responseStatus": 200,
            }
        ),
        ok(
            {
                "responseData": {"translatedText": ""},
                "responseStatus": "403",
                "responseDetails": "NEXT AVAILABLE",
            }
        ),
    ],
)
def test_mymemory_quota_is_quota_error(reply: Reply) -> None:
    with pytest.raises(QuotaError):
        MyMemoryTranslator(opener=Recorder(reply)).translate("x", "en", "fr")


def test_mymemory_other_failures_are_service_errors() -> None:
    bad = ok(
        {"responseData": {"translatedText": ""}, "responseStatus": 400, "responseDetails": "BAD"}
    )
    with pytest.raises(ServiceError):
        MyMemoryTranslator(opener=Recorder(bad)).translate("x", "en", "fr")
    with pytest.raises(ServiceError, match="HTTP 500"):
        MyMemoryTranslator(opener=Recorder(Reply(500, b""))).translate("x", "en", "fr")


# -- DeepL -----------------------------------------------------------------------------------


def test_deepl_free_and_pro_hosts() -> None:
    assert host_for("abc123:fx") == "https://api-free.deepl.com"
    assert host_for("abc123") == "https://api.deepl.com"
    assert DeepLTranslator("k:fx").host == "https://api-free.deepl.com"
    assert DeepLTranslator("k").host == "https://api.deepl.com"


def test_deepl_request_format() -> None:
    rec = Recorder(ok({"translations": [{"detected_source_language": "EN", "text": "Hallo"}]}))
    translator = DeepLTranslator("secret:fx", opener=rec)
    result = translator.translate("Hello", "en", "en")
    request = rec.requests[0]
    assert request.full_url == "https://api-free.deepl.com/v2/translate"
    assert request.get_method() == "POST"
    assert request.get_header("Authorization") == "DeepL-Auth-Key secret:fx"
    assert request.get_header("Content-type", "").startswith("application/json")
    assert body_of(request) == {"text": ["Hello"], "target_lang": "EN-US", "source_lang": "EN"}
    assert result == Translation("Hallo", "en", "deepl")


def test_deepl_target_codes_and_detection() -> None:
    rec = Recorder(ok({"translations": [{"text": "x"}]}))
    translator = DeepLTranslator("k:fx", opener=rec)
    translator.translate("a", None, "pt")
    translator.translate("a", "de-DE", "pt-br")
    translator.translate("a", None, "de")
    bodies = [body_of(r) for r in rec.requests]
    assert bodies[0] == {"text": ["a"], "target_lang": "PT-PT"}  # no source: DeepL detects
    assert bodies[1] == {"text": ["a"], "target_lang": "PT-BR", "source_lang": "DE"}
    assert bodies[2]["target_lang"] == "DE"
    assert translator.detects_source is True
    assert translator.max_request_bytes == 128 * 1024


@pytest.mark.parametrize(
    ("status", "error"),
    [
        (403, AuthError),
        (456, QuotaError),
        (429, QuotaError),
        (413, TooLongError),
        (500, ServiceError),
    ],
)
def test_deepl_status_mapping(status: int, error: type[TranslationError]) -> None:
    with pytest.raises(error):
        DeepLTranslator("k:fx", opener=Recorder(Reply(status, b"{}"))).translate("x", None, "en")


def test_deepl_without_key_is_config_error_and_sends_nothing() -> None:
    rec = Recorder(ok({}))
    with pytest.raises(ConfigError):
        DeepLTranslator("", opener=rec).translate("x", None, "en")
    assert rec.requests == []


def test_deepl_test_connection_uses_usage_endpoint() -> None:
    rec = Recorder(ok({"character_count": 1, "character_limit": 500000}))
    DeepLTranslator("k:fx", opener=rec).test_connection()
    assert rec.requests[0].full_url == "https://api-free.deepl.com/v2/usage"
    assert rec.requests[0].get_method() == "GET"


# -- LibreTranslate --------------------------------------------------------------------------


def test_libre_url_must_be_http_or_https() -> None:
    assert check_url(" https://lt.example.org/ ") == "https://lt.example.org"
    with pytest.raises(ConfigError):
        check_url("")
    for bad in ("ftp://x.org", "file:///etc/passwd", "lt.example.org"):
        with pytest.raises(ServiceError):
            check_url(bad)


def test_libre_request_and_detection() -> None:
    rec = Recorder(
        ok(
            {
                "translatedText": "Bonjour",
                "detectedLanguage": {"confidence": 90, "language": "en"},
            }
        )
    )
    translator = LibreTranslateTranslator("https://lt.example.org/", "key1", opener=rec)
    result = translator.translate("Hello", None, "fr")
    request = rec.requests[0]
    assert request.full_url == "https://lt.example.org/translate"
    assert request.get_method() == "POST"
    assert body_of(request) == {
        "q": "Hello",
        "source": "auto",
        "target": "fr",
        "format": "text",
        "api_key": "key1",
    }
    assert result == Translation("Bonjour", "en", "libretranslate")


def test_libre_without_key_omits_it() -> None:
    rec = Recorder(ok({"translatedText": "x"}))
    LibreTranslateTranslator("https://lt.example.org", "", opener=rec).translate("a", "en", "fr")
    assert "api_key" not in body_of(rec.requests[0])
    assert body_of(rec.requests[0])["source"] == "en"


@pytest.mark.parametrize(
    ("reply", "error"),
    [
        (Reply(403, json.dumps({"error": "Forbidden"}).encode()), AuthError),
        (Reply(400, json.dumps({"error": "Invalid API key"}).encode()), AuthError),
        (Reply(429, b"{}"), QuotaError),
        (Reply(413, b"{}"), TooLongError),
        (Reply(400, json.dumps({"error": "Invalid target language"}).encode()), ServiceError),
        (Reply(500, b""), ServiceError),
    ],
)
def test_libre_status_mapping(reply: Reply, error: type[TranslationError]) -> None:
    translator = LibreTranslateTranslator("https://lt.example.org", opener=Recorder(reply))
    with pytest.raises(error):
        translator.translate("x", "en", "fr")


def test_libre_test_connection_sends_a_tiny_translation_with_the_key() -> None:
    # A real translation, so a wrong key or a wrong server fails here, not on the first use.
    rec = Recorder(ok({"translatedText": "Hallo"}))
    LibreTranslateTranslator("https://lt.example.org", "k", opener=rec).test_connection()
    request = rec.requests[0]
    assert request.full_url == "https://lt.example.org/translate"
    assert request.get_method() == "POST"
    assert body_of(request) == {
        "q": "Hello",
        "source": "en",
        "target": "de",
        "format": "text",
        "api_key": "k",
    }


# -- transport -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "failure",
    [urllib.error.URLError("no route"), TimeoutError("timed out"), OSError("reset")],
)
def test_network_failures_are_offline_errors(failure: Exception) -> None:
    with pytest.raises(OfflineError):
        MyMemoryTranslator(opener=Recorder(failure)).translate("x", "en", "fr")


def test_non_json_reply_is_a_service_error() -> None:
    with pytest.raises(ServiceError):
        MyMemoryTranslator(opener=Recorder(Reply(200, b"<html>"))).translate("x", "en", "fr")


# -- translate_selection: cleanup, chunks, cache, cancellation -------------------------------


class Echo:
    """A translator double that wraps each request in brackets and records the calls."""

    id = "echo"
    cache_id = "echo"
    max_text_chars = 10_000
    name = "Echo"
    homepage = "https://example.invalid/"
    privacy_url = "https://example.invalid/privacy"
    detects_source = True
    max_request_bytes = 20

    def __init__(self, on_call: Callable[[str], None] | None = None) -> None:
        self.calls: list[tuple[str, str | None, str]] = []
        self.on_call = on_call

    def languages(self) -> dict[str, str]:
        return {"en": "English", "fr": "French"}

    def translate(
        self, text: str, source: str | None, target: str, token: CancelToken | None = None
    ) -> Translation:
        self.calls.append((text, source, target))
        if self.on_call is not None:
            self.on_call(text)
        detected = "en" if source is None else None
        return Translation(f"[{text}]", detected, self.id)

    def test_connection(self, token: CancelToken | None = None) -> None:
        return None


def test_selection_is_cleaned_chunked_and_rejoined_with_breaks() -> None:
    echo = Echo()
    raw = "First line that\nwraps here.\n\nSecond paragraph is short."
    result = tr.translate_selection(echo, raw, "en", "fr")
    assert all(len(c[0].encode()) <= 20 for c in echo.calls)
    assert len(echo.calls) > 1
    assert result.text.startswith("[First line that")
    assert "\n\n" in result.text  # the paragraph break survives
    assert result.text.count("[") == len(echo.calls)
    assert result.service_id == "echo"


def test_detected_language_is_reported_and_reused_for_later_chunks() -> None:
    echo = Echo()
    text = "One two three four five six seven eight nine ten"
    result = tr.translate_selection(echo, text, None, "fr")
    assert result.source_detected == "en"
    assert echo.calls[0][1] is None
    assert all(source == "en" for _text, source, _target in echo.calls[1:])


def test_empty_and_overlong_selections_are_refused() -> None:
    echo = Echo()
    with pytest.raises(ServiceError):
        tr.translate_selection(echo, "   \n ", "en", "fr")
    with pytest.raises(TooLongError):
        tr.translate_selection(echo, "word " * 3000, "en", "fr")
    assert echo.calls == []


def test_cancellation_stops_between_requests() -> None:
    token = CancelToken()
    echo = Echo(on_call=lambda _text: token.cancel())
    with pytest.raises(Cancelled):
        tr.translate_selection(echo, "one two three four five six seven eight", "en", "fr", token)
    assert len(echo.calls) == 1  # the next request never went out


def test_repeated_selection_is_served_from_the_cache() -> None:
    echo = Echo()
    first = tr.translate_selection(echo, "Hello there.", "en", "fr")
    calls = len(echo.calls)
    second = tr.translate_selection(echo, "Hello   there.", "en", "fr")
    assert second == first
    assert len(echo.calls) == calls  # cleanup makes the two inputs the same cache key
    tr.translate_selection(echo, "Hello there.", "en", "de")
    assert len(echo.calls) == calls + 1  # a different target is a different request


def test_cache_is_bounded() -> None:
    echo = Echo()
    for i in range(tr.CACHE_SIZE + 5):
        tr.translate_selection(echo, f"text number {i}", "en", "fr")
    assert len(tr._cache) == tr.CACHE_SIZE


# -- registry --------------------------------------------------------------------------------


def test_registry_builds_each_service_with_its_config() -> None:
    rec = Recorder(ok({}))
    config = tr.TranslationConfig(
        mymemory_email="a@b.c",
        deepl_key="k:fx",
        libretranslate_url="https://lt.example.org",
        libretranslate_key="lk",
        opener=rec,
    )
    assert set(tr.SERVICES) == {"mymemory", "deepl", "libretranslate"}
    assert isinstance(tr.make_translator("mymemory", config), MyMemoryTranslator)
    assert isinstance(tr.make_translator("deepl", config), DeepLTranslator)
    assert isinstance(tr.make_translator("libretranslate", config), LibreTranslateTranslator)
    with pytest.raises(ServiceError):
        tr.make_translator("google", config)
    with pytest.raises(ConfigError):
        tr.make_translator("libretranslate", tr.TranslationConfig())  # no server address yet
