"""The translation transport seam: each client through an injected opener, the request the
desktop sends (User-Agent and all), and the desktop default. The network is never touched."""

from __future__ import annotations

import json
import urllib.request
from typing import Any

import pytest

from pdfeditor.services import translation as tr
from pdfeditor.services.translation import http as http_module
from pdfeditor.services.translation.azure import AzureTranslator
from pdfeditor.services.translation.base import (
    AuthError,
    OfflineError,
    QuotaError,
    ServiceError,
)
from pdfeditor.services.translation.http import Reply, Request
from pdfeditor.services.translation.http import urllib_opener as real_opener
from pdfeditor.services.translation.libretranslate import LibreTranslateTranslator
from pdfeditor.services.translation.mymemory import MyMemoryTranslator
from tests.services.translation_fakes import header_of


class FakeOpener:
    """Returns one scripted reply (or raises a scripted exception) and records each request."""

    def __init__(self, reply: Reply | BaseException) -> None:
        self.reply = reply
        self.requests: list[Request] = []

    def __call__(self, request: Request, timeout: float) -> Reply:
        self.requests.append(request)
        assert timeout > 0
        if isinstance(self.reply, BaseException):
            raise self.reply
        return self.reply


def reply_json(payload: Any, status: int = 200) -> Reply:
    return Reply(status, json.dumps(payload).encode("utf-8"))


def mymemory_ok() -> Reply:
    return reply_json({"responseStatus": 200, "responseData": {"translatedText": "Hallo"}})


def azure_ok() -> Reply:
    return reply_json([{"translations": [{"text": "Hallo", "to": "de"}]}])


def libretranslate_ok() -> Reply:
    return reply_json({"translatedText": "Hallo"})


def make_client(service: str, opener: FakeOpener) -> Any:
    if service == "mymemory":
        return MyMemoryTranslator(opener=opener)
    if service == "azure":
        return AzureTranslator("secret-key", "", opener)
    return LibreTranslateTranslator("https://lt.example.org", "", opener)


CLIENTS = [
    ("mymemory", mymemory_ok),
    ("azure", azure_ok),
    ("libretranslate", libretranslate_ok),
]


@pytest.mark.parametrize(("service", "ok"), CLIENTS)
def test_success_returns_the_translation(service: str, ok: Any) -> None:
    opener = FakeOpener(ok())
    result = make_client(service, opener).translate("Hello", "en", "de")
    assert result.text == "Hallo"
    assert len(opener.requests) == 1


@pytest.mark.parametrize(
    ("service", "status", "error"),
    [
        # Azure has a key, so 401 and 403 mean the key was refused.
        ("azure", 401, AuthError),
        ("azure", 403, AuthError),
        # LibreTranslate refuses a bad key with 403; a 401 is not a case it documents.
        ("libretranslate", 403, AuthError),
        ("libretranslate", 401, ServiceError),
        # MyMemory has no key, so there is no auth error; 401/403 are unexpected answers.
        ("mymemory", 401, ServiceError),
        ("mymemory", 403, ServiceError),
        ("mymemory", 429, QuotaError),
        ("azure", 429, QuotaError),
        ("libretranslate", 429, QuotaError),
    ],
)
def test_error_statuses_map_to_the_error_types(service: str, status: int, error: type) -> None:
    opener = FakeOpener(reply_json({"error": "refused"}, status))
    with pytest.raises(error):
        make_client(service, opener).translate("Hello", "en", "de")


@pytest.mark.parametrize(
    "failure",
    [TimeoutError("timed out"), OSError("connection reset")],
    ids=["timeout", "oserror"],
)
@pytest.mark.parametrize("service", ["mymemory", "azure", "libretranslate"])
def test_network_failures_map_to_offline(service: str, failure: BaseException) -> None:
    with pytest.raises(OfflineError):
        make_client(service, FakeOpener(failure)).translate("Hello", "en", "de")


@pytest.mark.parametrize("service", ["mymemory", "azure", "libretranslate"])
def test_a_non_json_200_is_a_service_error(service: str) -> None:
    opener = FakeOpener(Reply(200, b"<html>not json</html>"))
    with pytest.raises(ServiceError):
        make_client(service, opener).translate("Hello", "en", "de")


def test_azure_json_body_is_sent_with_the_right_method_url_and_type() -> None:
    opener = FakeOpener(azure_ok())
    AzureTranslator("secret-key", "", opener).translate("Hello", "en", "de")
    request = opener.requests[0]
    assert request.method == "POST"
    assert request.url.startswith("https://api.cognitive.microsofttranslator.com/translate?")
    assert header_of(request, "Content-Type") == "application/json; charset=UTF-8"
    assert header_of(request, "Ocp-Apim-Subscription-Key") == "secret-key"
    assert request.data is not None
    assert json.loads(request.data.decode("utf-8")) == [{"Text": "Hello"}]


def test_libretranslate_json_body_is_sent_with_the_right_method_url_and_type() -> None:
    opener = FakeOpener(libretranslate_ok())
    LibreTranslateTranslator("https://lt.example.org", "", opener).translate("Hello", "en", "de")
    request = opener.requests[0]
    assert request.method == "POST"
    assert request.url == "https://lt.example.org/translate"
    assert (header_of(request, "Content-Type") or "").startswith("application/json")
    assert request.data is not None
    assert json.loads(request.data.decode("utf-8"))["q"] == "Hello"


def test_urllib_opener_sends_the_same_request_as_before(monkeypatch: pytest.MonkeyPatch) -> None:
    """The desktop path converts the transport Request into the urllib request it always built:
    same URL, method, headers (User-Agent included) and body."""
    sent: list[urllib.request.Request] = []

    class Response:
        status = 200

        def read(self) -> bytes:
            return b"{}"

        def __enter__(self) -> Response:
            return self

        def __exit__(self, *args: object) -> None:
            return None

    def fake_urlopen(request: urllib.request.Request, timeout: float) -> Response:
        sent.append(request)
        return Response()

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    body = json.dumps({"q": "Hello"}).encode("utf-8")
    headers = {
        "User-Agent": "Elanero",
        "Accept": "application/json",
        "Content-Type": "application/json; charset=utf-8",
    }
    # urllib_opener is captured at import time, before the conftest guard replaces it.
    real_opener(
        Request(
            "https://lt.example.org/translate",
            "POST",
            headers,
            body,
        ),
        20.0,
    )
    # What the old code built directly from the same inputs.
    expected = urllib.request.Request(
        "https://lt.example.org/translate", data=body, headers=headers, method="POST"
    )
    actual = sent[0]
    assert actual.full_url == expected.full_url
    assert actual.get_method() == expected.get_method()
    assert actual.data == expected.data
    assert sorted(actual.header_items()) == sorted(expected.header_items())
    assert ("User-agent", "Elanero") in actual.header_items()


def test_desktop_default_uses_urllib_opener(monkeypatch: pytest.MonkeyPatch) -> None:
    """With no opener configured, request_json falls back to http.urllib_opener. The seam is the
    module attribute, which request_json reads at call time."""
    seen: list[Request] = []

    def recorder(request: Request, timeout: float) -> Reply:
        seen.append(request)
        return mymemory_ok()

    monkeypatch.setattr(http_module, "urllib_opener", recorder)
    translator = tr.make_translator("mymemory", tr.TranslationConfig())
    assert translator.translate("Hello", "en", "de").text == "Hallo"
    assert len(seen) == 1
    assert header_of(seen[0], "User-Agent") == "Elanero"
