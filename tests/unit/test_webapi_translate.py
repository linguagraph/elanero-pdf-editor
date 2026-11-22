"""Translation calls on the web (W6.6 slice S1): the service list, each service's request through
a fake gated XHR, the error codes, the deadline, and credentials that never leave the call.

No test touches the network: ``elanero_net`` (the engine worker's gate) is replaced by a fake
that scripts each reply. The file runs under Pyodide too.
"""

from __future__ import annotations

import json
import logging
import sys
import types
from collections.abc import Callable
from typing import Any

import pytest

from pdfeditor.services.translation import clear_cache
from pdfeditor.webapi import METHODS, dto, translate
from pdfeditor.webapi.errors import (
    INVALID_ARGS,
    TRANSLATION_AUTH,
    TRANSLATION_CONFIG,
    TRANSLATION_OFFLINE,
    TRANSLATION_QUOTA,
    TRANSLATION_SAME_LANGUAGE,
    TRANSLATION_SERVICE,
    TRANSLATION_TOO_LONG,
    RpcFailure,
)

SECRET = "SECRET-KEY-do-not-log"
EMAIL = "someone@example.test"


class FakeNet:
    """Scripted replies, one per request: (status, body), or an exception to raise on send."""

    def __init__(self, replies: list[Any], after_send: Callable[[], None] | None = None) -> None:
        self.replies = list(replies)
        self.requests: list[dict[str, Any]] = []
        self.after_send = after_send

    def open_xhr(self) -> FakeXhr:
        return FakeXhr(self)


class FakeXhr:
    def __init__(self, net: FakeNet) -> None:
        self.net = net
        self.status = 0
        self.responseText = ""
        self.timeout = 0
        self.withCredentials = True
        self.method = ""
        self.url = ""
        self.headers: dict[str, str] = {}

    def open(self, method: str, url: str, asynchronous: bool) -> None:
        assert asynchronous is False
        self.method, self.url = method, url

    def setRequestHeader(self, name: str, value: str) -> None:
        self.headers[name] = value

    def send(self, body: str | None = None) -> None:
        self.net.requests.append(
            {
                "method": self.method,
                "url": self.url,
                "headers": dict(self.headers),
                "body": body,
                "timeout": self.timeout,
                "credentials": self.withCredentials,
            }
        )
        status, text = self.net.replies.pop(0)
        self.status, self.responseText = status, text
        if self.net.after_send is not None:
            self.net.after_send()


@pytest.fixture
def net(monkeypatch: pytest.MonkeyPatch) -> Callable[..., FakeNet]:
    """``net(replies)`` installs a fake gate with those replies and returns it."""

    def install(replies: list[Any], after_send: Callable[[], None] | None = None) -> FakeNet:
        fake = FakeNet(replies, after_send)
        module = types.SimpleNamespace(open_xhr=fake.open_xhr)
        monkeypatch.setitem(sys.modules, "elanero_net", module)
        return fake

    return install


def params(
    service: str = "mymemory",
    text: str = "Hello world.",
    source: str | None = "en",
    target: str = "fr",
    **credentials: str,
) -> dto.TranslateParams:
    return dto.TranslateParams(
        service=service,
        text=text,
        source=source,
        target=target,
        credentials=dto.TranslationCredentials(**credentials),
    )


def mymemory_reply(text: str) -> tuple[int, str]:
    body = {"responseStatus": 200, "responseData": {"translatedText": text}}
    return 200, json.dumps(body)


def failure_of(call: Callable[[], object]) -> RpcFailure:
    with pytest.raises(RpcFailure) as caught:
        call()
    return caught.value


def test_the_web_service_list_is_the_three_services_with_the_clients_limits() -> None:
    info = translate.info(dto.Empty())
    assert [s.id for s in info.services] == ["mymemory", "azure", "libretranslate"]
    by_id = {s.id: s for s in info.services}
    assert by_id["mymemory"].max_chars == 2000 and not by_id["mymemory"].detects_source
    assert not by_id["mymemory"].needs_key
    assert by_id["azure"].max_chars == 10_000 and by_id["azure"].needs_key
    assert by_id["libretranslate"].needs_key and by_id["libretranslate"].privacy_url
    assert {code.code for code in info.languages["azure"]} >= {"en", "fr"}
    assert info.languages["mymemory"]


def test_the_methods_table_gets_translation_info_only_until_slice_three() -> None:
    # The network methods join the table with the bubble (S3); until then no request can start.
    assert "translation.info" in METHODS
    assert "translation.translate" not in METHODS and "translation.test" not in METHODS


def test_mymemory_sends_its_get_request_with_the_optional_email(net: Any) -> None:
    fake = net([mymemory_reply("Bonjour le monde.")])
    result = translate.translate(params(mymemory_email=EMAIL))
    assert result == dto.TranslateResult(
        text="Bonjour le monde.", detected=None, service="mymemory"
    )
    request = fake.requests[0]
    assert request["method"] == "GET"
    assert request["url"].startswith("https://api.mymemory.translated.net/get?")
    assert "langpair=en%7Cfr" in request["url"] or "langpair=en|fr" in request["url"]
    assert "de=" in request["url"]
    assert SECRET not in request["url"]
    assert request["timeout"] == 10_000  # the web's 10 s per request, below the desktop's 20 s
    assert request["credentials"] is False
    assert "User-Agent" not in request["headers"]


def test_azure_sends_the_key_in_a_header_and_never_in_the_address(net: Any) -> None:
    reply = [{"translations": [{"text": "Bonjour", "to": "fr"}]}]
    fake = net([(200, json.dumps(reply))])
    result = translate.translate(params("azure", azure_key=SECRET, azure_region="westeurope"))
    assert result.text == "Bonjour" and result.service == "azure"
    request = fake.requests[0]
    assert request["method"] == "POST"
    assert request["url"].startswith("https://api.cognitive.microsofttranslator.com/translate?")
    assert request["headers"]["Ocp-Apim-Subscription-Key"] == SECRET
    assert request["headers"]["Ocp-Apim-Subscription-Region"] == "westeurope"
    assert SECRET not in request["url"]
    assert json.loads(request["body"]) == [{"Text": "Hello world."}]


def test_libretranslate_uses_the_fixed_server_and_the_key_in_the_body(net: Any) -> None:
    fake = net([(200, json.dumps({"translatedText": "Bonjour"}))])
    translate.translate(params("libretranslate", libre_key=SECRET))
    request = fake.requests[0]
    assert request["url"] == "https://libretranslate.com/translate"
    body = json.loads(request["body"])
    assert body["api_key"] == SECRET and body["target"] == "fr"
    assert SECRET not in request["url"]


def test_deepl_and_unknown_services_are_refused_before_any_request(net: Any) -> None:
    fake = net([])
    for service in ("deepl", "libretranslate-custom", ""):
        failure = failure_of(lambda s=service: translate.translate(params(s)))  # type: ignore[misc]
        assert failure.code == TRANSLATION_CONFIG
    assert fake.requests == []


@pytest.mark.parametrize(
    ("service", "status", "body", "code"),
    [
        ("mymemory", 0, "", TRANSLATION_OFFLINE),
        ("mymemory", 429, "", TRANSLATION_QUOTA),
        ("mymemory", 500, "", TRANSLATION_SERVICE),
        ("azure", 401, "", TRANSLATION_AUTH),
    ],
)
def test_each_failure_maps_to_its_code(
    net: Any, service: str, status: int, body: str, code: str
) -> None:
    net([(status, body)])
    failure = failure_of(lambda: translate.translate(params(service, azure_key=SECRET)))
    assert failure.code == code
    assert failure.details == {"partial": ""}


def test_text_translated_before_a_failure_comes_back_as_partial(net: Any) -> None:
    text = "Alpha sentence here. " * 40  # more than one MyMemory request (500 bytes each)
    fake = net([mymemory_reply("FIRST part."), (0, "")])
    failure = failure_of(lambda: translate.translate(params(text=text)))
    assert failure.code == TRANSLATION_OFFLINE
    assert failure.details["partial"].startswith("FIRST part.")
    assert len(fake.requests) == 2


def test_the_deadline_stops_between_requests_and_keeps_the_partial(
    monkeypatch: pytest.MonkeyPatch, net: Any
) -> None:
    clock = {"now": 0.0}
    monkeypatch.setattr(translate, "_CLOCK", lambda: clock["now"])

    def past_the_deadline() -> None:
        clock["now"] = translate.DEADLINE_SECONDS + 1

    text = "Alpha sentence here. " * 40
    fake = net([mymemory_reply("FIRST part.")], after_send=past_the_deadline)
    failure = failure_of(lambda: translate.translate(params(text=text)))
    assert failure.code == TRANSLATION_OFFLINE
    assert failure.details["partial"].startswith("FIRST part.")
    assert len(fake.requests) == 1  # no second request once the deadline has passed


def test_a_selection_over_the_service_limit_or_the_main_thread_cap_is_refused(net: Any) -> None:
    fake = net([])
    too_long = failure_of(lambda: translate.translate(params(text="x " * 1500)))
    assert too_long.code == TRANSLATION_TOO_LONG
    capped = failure_of(lambda: translate.translate(params(text="x" * 40_001)))
    assert capped.code == TRANSLATION_TOO_LONG
    assert fake.requests == []


def test_the_same_language_is_refused_before_any_request(net: Any) -> None:
    fake = net([])
    failure = failure_of(lambda: translate.translate(params(source="fr", target="fr")))
    assert failure.code == TRANSLATION_SAME_LANGUAGE
    assert fake.requests == []


def test_a_language_the_service_does_not_list_is_invalid_args_and_names_only_the_field(
    net: Any,
) -> None:
    fake = net([])
    failure = failure_of(
        lambda: translate.translate(params("azure", target="fr&x=1", azure_key=SECRET))
    )
    assert failure.code == INVALID_ARGS
    assert failure.details == {"path": "params.target"}
    assert SECRET not in failure.message
    assert fake.requests == []


def test_credentials_and_text_never_reach_the_log(
    net: Any, caplog: pytest.LogCaptureFixture
) -> None:
    net([mymemory_reply("Bonjour")])
    caplog.set_level(logging.DEBUG)
    translate.translate(params(text="Secret text of the document.", mymemory_email=EMAIL))
    failure_of(lambda: translate.translate(params("azure", azure_key=SECRET, target="xx")))
    assert "Secret text" not in caplog.text
    assert SECRET not in caplog.text and EMAIL not in caplog.text


def test_the_connection_test_sends_a_fixed_word_and_maps_failures(net: Any) -> None:
    fake = net([mymemory_reply("Bonjour"), (429, "")])
    assert (
        translate.check_connection(
            dto.TranslationTestParams("mymemory", dto.TranslationCredentials())
        )
        == dto.Empty()
    )
    assert "q=Hello" in fake.requests[0]["url"]
    failure = failure_of(
        lambda: translate.check_connection(
            dto.TranslationTestParams("mymemory", dto.TranslationCredentials())
        )
    )
    assert failure.code == TRANSLATION_QUOTA


@pytest.fixture(autouse=True)
def fresh_cache() -> None:
    """The translation cache is module-level; a test must not be answered by an earlier one."""
    clear_cache()
