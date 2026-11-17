"""Azure AI Translator: request format, batching, detection, code mapping, error mapping and the
cache identity. Mocked HTTP only."""

from __future__ import annotations

import json
import urllib.parse
from typing import Any

import pytest

from pdfeditor.services import translation as tr
from pdfeditor.services.translation.azure import (
    MAX_BATCH_CHARS,
    MAX_BATCH_TEXTS,
    AzureTranslator,
    _batches,
)
from pdfeditor.services.translation.base import (
    AuthError,
    ConfigError,
    QuotaError,
    ServiceError,
    TranslationError,
)
from pdfeditor.services.translation.http import Reply, Request
from tests.services.translation_fakes import header_of


class Recorder:
    def __init__(self, *replies: Reply) -> None:
        self.replies = list(replies)
        self.requests: list[Request] = []

    def __call__(self, request: Request, timeout: float) -> Reply:
        self.requests.append(request)
        return self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]


def answer(texts: list[str], detected: str | None = None) -> Reply:
    items: list[dict[str, Any]] = []
    for text in texts:
        item: dict[str, Any] = {"translations": [{"text": f"[{text}]", "to": "de"}]}
        if detected is not None:
            item["detectedLanguage"] = {"language": detected, "score": 0.98}
        items.append(item)
    return Reply(200, json.dumps(items).encode("utf-8"))


def error(status: int, code: int | None, message: str) -> Reply:
    body: dict[str, Any] = {"error": {"message": message}}
    if code is not None:
        body["error"]["code"] = code
    return Reply(status, json.dumps(body).encode("utf-8"))


def sent(request: Request) -> list[dict[str, str]]:
    assert request.data is not None
    return json.loads(request.data.decode("utf-8"))


@pytest.fixture(autouse=True)
def fresh_cache() -> None:
    tr.clear_cache()


# -- request format -------------------------------------------------------------------------


def test_request_url_query_headers_and_body_without_region() -> None:
    rec = Recorder(answer(["Hello"]))
    AzureTranslator("secret-key", opener=rec).translate("Hello", "en", "de")
    request = rec.requests[0]
    assert request.method == "POST"
    parts = urllib.parse.urlsplit(request.url)
    assert f"{parts.scheme}://{parts.netloc}{parts.path}" == (
        "https://api.cognitive.microsofttranslator.com/translate"
    )
    assert urllib.parse.parse_qs(parts.query) == {
        "api-version": ["3.0"],
        "to": ["de"],
        "from": ["en"],
    }
    assert header_of(request, "Ocp-apim-subscription-key") == "secret-key"
    assert header_of(request, "Ocp-apim-subscription-region") is None
    assert header_of(request, "Content-type") == "application/json; charset=UTF-8"
    assert sent(request) == [{"Text": "Hello"}]


def test_request_carries_the_region_when_there_is_one() -> None:
    rec = Recorder(answer(["Hello"]))
    AzureTranslator("k", " westeurope ", opener=rec).translate("Hello", "en", "fr")
    assert header_of(rec.requests[0], "Ocp-apim-subscription-region") == "westeurope"


def test_source_is_left_out_when_detecting() -> None:
    rec = Recorder(answer(["Hallo"], detected="de"))
    result = AzureTranslator("k", opener=rec).translate("Hallo", None, "en")
    query = urllib.parse.parse_qs(urllib.parse.urlsplit(rec.requests[0].url).query)
    assert "from" not in query
    assert result.source_detected == "de"


def test_detection_is_parsed_per_text() -> None:
    rec = Recorder(answer(["one", "two"], detected="fr"))
    results = AzureTranslator("k", opener=rec).translate_many(["one", "two"], None, "en")
    assert [r.text for r in results] == ["[one]", "[two]"]
    assert all(r.source_detected == "fr" for r in results)
    assert all(r.service_id == "azure" for r in results)


def test_test_connection_translates_hello_to_check_the_key() -> None:
    rec = Recorder(answer(["Hello"]))
    AzureTranslator("k", opener=rec).test_connection()
    assert sent(rec.requests[0]) == [{"Text": "Hello"}]
    query = urllib.parse.parse_qs(urllib.parse.urlsplit(rec.requests[0].url).query)
    assert query["to"] == ["de"] and query["from"] == ["en"]


# -- batching -------------------------------------------------------------------------------


def test_texts_that_fit_go_in_one_request() -> None:
    rec = Recorder(answer(["a", "b", "c"]))
    results = AzureTranslator("k", opener=rec).translate_many(["a", "b", "c"], "en", "de")
    assert len(rec.requests) == 1
    assert len(results) == 3
    assert sent(rec.requests[0]) == [{"Text": "a"}, {"Text": "b"}, {"Text": "c"}]


def test_batches_split_at_the_character_limit() -> None:
    big = "x" * 30_000
    assert _batches([big, big, "small"]) == [[big], [big, "small"]]
    assert all(sum(len(t) for t in batch) <= MAX_BATCH_CHARS for batch in _batches([big] * 5))


def test_batches_split_at_the_element_limit() -> None:
    texts = ["t"] * (MAX_BATCH_TEXTS + 1)
    batches = _batches(texts)
    assert [len(b) for b in batches] == [MAX_BATCH_TEXTS, 1]


def test_more_than_one_batch_sends_several_requests() -> None:
    big = "y" * 30_000
    rec = Recorder(answer([big]), answer([big]))
    results = AzureTranslator("k", opener=rec).translate_many([big, big], "en", "de")
    assert len(rec.requests) == 2
    assert len(results) == 2


def test_a_failed_later_batch_keeps_the_earlier_results_on_the_error() -> None:
    big = "y" * 30_000
    rec = Recorder(answer([big]), error(500, None, "boom"))
    with pytest.raises(ServiceError) as info:
        AzureTranslator("k", opener=rec).translate_many([big, big], "en", "de")
    assert len(info.value.done) == 1


# -- language codes --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("ours", "azure"),
    [("zh", "zh-Hans"), ("no", "nb"), ("pt", "pt-pt"), ("de", "de"), ("fr-CA", "fr")],
)
def test_azure_codes(ours: str, azure: str) -> None:
    rec = Recorder(answer(["x"]))
    AzureTranslator("k", opener=rec).translate("x", ours, ours)
    query = urllib.parse.parse_qs(urllib.parse.urlsplit(rec.requests[0].url).query)
    assert query["from"] == [azure]
    assert query["to"] == [azure]


# -- errors ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("reply", "error_type"),
    [
        (error(401, 401000, "bad key"), AuthError),
        (error(403, 403001, "quota"), QuotaError),
        (error(403, 403000, "forbidden"), AuthError),
        (error(429, 429000, "slow down"), QuotaError),
        (error(400, 400077, "text too long"), ServiceError),
        (error(500, 500000, "oops"), ServiceError),
        (error(503, None, "down"), ServiceError),
    ],
)
def test_azure_error_mapping(reply: Reply, error_type: type[TranslationError]) -> None:
    with pytest.raises(error_type):
        AzureTranslator("k", opener=Recorder(reply)).translate("x", "en", "de")


def test_401_names_the_key_and_region_in_preferences() -> None:
    with pytest.raises(AuthError) as info:
        AzureTranslator("k", opener=Recorder(error(401, 401000, "x"))).translate("x", "en", "de")
    assert info.value.message == (
        "The Azure key or region was not accepted. Check both in Preferences."
    )


def test_400_carries_azures_message() -> None:
    with pytest.raises(ServiceError) as info:
        AzureTranslator("k", opener=Recorder(error(400, 400077, "Text too long"))).translate(
            "x", "en", "de"
        )
    assert "Text too long" in info.value.message


def test_a_missing_key_is_a_config_error_and_sends_nothing() -> None:
    rec = Recorder(answer(["x"]))
    with pytest.raises(ConfigError):
        AzureTranslator("", opener=rec).translate("x", "en", "de")
    assert rec.requests == []


# -- identity and registry --------------------------------------------------------------------


def test_cache_id_and_attribution() -> None:
    assert AzureTranslator("k", "westeurope").cache_id == "azure:westeurope"
    assert AzureTranslator("k").cache_id == "azure:"
    translator = AzureTranslator("k")
    assert translator.id == "azure"
    assert translator.name == "Azure AI Translator"
    assert translator.detects_source is True
    assert translator.max_request_bytes == 40_000
    assert translator.max_text_chars == 10_000
    assert translator.privacy_url == "https://www.microsoft.com/privacy/privacystatement"
    assert translator.homepage == ("https://azure.microsoft.com/products/ai-services/ai-translator")


def test_registry_builds_azure_with_its_key_and_region() -> None:
    config = tr.TranslationConfig(azure_key="k", azure_region="eastus")
    assert "azure" in tr.SERVICES
    translator = tr.make_translator("azure", config)
    assert isinstance(translator, AzureTranslator)
    assert translator.cache_id == "azure:eastus"
    assert tr.configuration_problem("azure", tr.TranslationConfig()) == "the Azure key is missing"
    assert tr.configuration_problem("azure", config) is None


def test_a_selection_is_one_azure_request_and_keeps_its_breaks() -> None:
    text = "First paragraph here.\n\nSecond one."
    rec = Recorder(answer([text]))
    result = tr.translate_selection(AzureTranslator("k", opener=rec), text, "en", "de")
    assert len(rec.requests) == 1
    assert result.text == "[First paragraph here.\n\nSecond one.]"


def test_a_detected_chinese_is_never_sent_back_as_from() -> None:
    # Two batches of Chinese text. The first batch detects zh-Hans; the second batch must still
    # detect (no "from"), and the result reports our code "zh", not Azure's "zh-Hans".
    big = "\u4e2d" * 30_000  # 30k characters: one text per batch
    rec = Recorder(answer([big], detected="zh-Hans"), answer([big], detected="zh-Hans"))
    results = AzureTranslator("k", opener=rec).translate_many([big, big], None, "en")
    assert len(rec.requests) == 2
    for request in rec.requests:
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(request.url).query)
        assert "from" not in query
    assert results[0].source_detected == "zh"


def test_detected_codes_are_shown_as_ours() -> None:
    from pdfeditor.services.translation.azure import _detected_code

    assert _detected_code("zh-Hans") == "zh"
    assert _detected_code("zh-Hant") == "zh"
    assert _detected_code("nb") == "no"
    assert _detected_code("pt-PT") == "pt"
    assert _detected_code("pt-BR") == "pt"
    assert _detected_code("fr") == "fr"


def test_traditional_chinese_is_offered_and_sent_as_zh_hant() -> None:
    translator = AzureTranslator("k")
    assert translator.languages()["zh-Hant"] == "Chinese (Traditional)"
    rec = Recorder(answer(["x"]))
    AzureTranslator("k", opener=rec).translate("x", "en", "zh-Hant")
    query = urllib.parse.parse_qs(urllib.parse.urlsplit(rec.requests[0].url).query)
    assert query["to"] == ["zh-Hant"]
