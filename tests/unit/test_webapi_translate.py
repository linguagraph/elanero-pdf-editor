"""Translation calls on the web (W6.6 slices S1 and S2): the one service (MyMemory), its request
through a fake gated XHR, the error codes, the deadline, and strict parameters (no settings).

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
from pdfeditor.services.translation.base import AuthError, ConfigError
from pdfeditor.webapi import METHODS, dto, translate
from pdfeditor.webapi.dto import BufferTable, from_json
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
    text: str = "Hello world.", source: str = "en", target: str = "fr"
) -> dto.TranslateParams:
    return dto.TranslateParams(text=text, source=source, target=target)


def mymemory_reply(text: str) -> tuple[int, str]:
    body = {"responseStatus": 200, "responseData": {"translatedText": text}}
    return 200, json.dumps(body)


def failure_of(call: Callable[[], object]) -> RpcFailure:
    with pytest.raises(RpcFailure) as caught:
        call()
    return caught.value


def test_the_web_offers_mymemory_alone_with_its_limits() -> None:
    info = translate.info(dto.Empty())
    assert [s.id for s in info.services] == ["mymemory"]
    service = info.services[0]
    assert service.max_chars == 2000 and not service.detects_source
    assert service.privacy_url.startswith("https://")
    assert info.languages["mymemory"]
    assert not hasattr(service, "needs_key")


def test_the_methods_table_gets_translation_info_only_until_slice_three() -> None:
    # The network method joins the table with the bubble (S3); until then no request can start.
    assert "translation.info" in METHODS
    assert "translation.translate" not in METHODS


def test_the_parameters_are_strict_and_source_is_required() -> None:
    good = {"text": "Hi.", "source": "en", "target": "fr"}
    buffers = BufferTable([])
    assert from_json(dto.TranslateParams, good, buffers, "params") == params("Hi.")
    for extra in ({"service": "mymemory"}, {"credentials": {}}, {"mymemory_email": "a@b.test"}):
        with pytest.raises(RpcFailure) as caught:
            from_json(dto.TranslateParams, {**good, **extra}, buffers, "params")
        assert caught.value.code == INVALID_ARGS
    with pytest.raises(RpcFailure) as caught:
        from_json(dto.TranslateParams, {"text": "Hi.", "target": "fr"}, buffers, "params")
    assert caught.value.code == INVALID_ARGS


def test_mymemory_sends_its_get_request_without_an_email(net: Any) -> None:
    fake = net([mymemory_reply("Bonjour le monde.")])
    result = translate.translate(params())
    assert result == dto.TranslateResult(
        text="Bonjour le monde.", detected=None, service="mymemory"
    )
    request = fake.requests[0]
    assert request["method"] == "GET"
    assert request["url"].startswith("https://api.mymemory.translated.net/get?")
    assert "langpair=en%7Cfr" in request["url"] or "langpair=en|fr" in request["url"]
    assert "de=" not in request["url"]
    assert request["timeout"] == 10_000  # the web's 10 s per request, below the desktop's 20 s
    assert request["credentials"] is False
    assert "User-Agent" not in request["headers"]


@pytest.mark.parametrize(
    ("status", "body", "code"),
    [
        (0, "", TRANSLATION_OFFLINE),
        (429, "", TRANSLATION_QUOTA),
        (500, "", TRANSLATION_SERVICE),
    ],
)
def test_each_failure_maps_to_its_code(net: Any, status: int, body: str, code: str) -> None:
    net([(status, body)])
    failure = failure_of(lambda: translate.translate(params()))
    assert failure.code == code
    assert failure.details == {"partial": ""}


def test_an_auth_refusal_maps_to_its_code_with_the_partial_text() -> None:
    failure = translate._failure(AuthError("refused", partial="Bonjour"))
    assert failure.code == TRANSLATION_AUTH
    assert failure.details == {"partial": "Bonjour"}


def test_a_missing_setup_or_language_maps_to_its_code() -> None:
    failure = translate._failure(ConfigError("no language", partial=""))
    assert failure.code == TRANSLATION_CONFIG


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


@pytest.mark.parametrize(
    ("source", "target", "path"),
    [("xx", "fr", "params.source"), ("en", "fr&x=1", "params.target"), ("", "fr", "params.source")],
)
def test_a_language_the_service_does_not_list_is_invalid_args_before_any_request(
    net: Any, source: str, target: str, path: str
) -> None:
    fake = net([])
    failure = failure_of(lambda: translate.translate(params(source=source, target=target)))
    assert failure.code == INVALID_ARGS
    assert failure.details == {"path": path}
    assert fake.requests == []


def test_the_text_never_reaches_the_log(net: Any, caplog: pytest.LogCaptureFixture) -> None:
    net([mymemory_reply("Bonjour")])
    caplog.set_level(logging.DEBUG)
    translate.translate(params(text="Secret text of the document."))
    assert "Secret text" not in caplog.text
    assert "Bonjour" not in caplog.text


@pytest.fixture(autouse=True)
def fresh_cache() -> None:
    """The translation cache is module-level; a test must not be answered by an earlier one."""
    clear_cache()
