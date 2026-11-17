"""The web transport: make_xhr_opener over a fake ``js`` module, the origins the browser may
call, and the import guard (the module must load on the desktop with no ``js`` present)."""

from __future__ import annotations

import subprocess
import sys
import types
import urllib.parse
from typing import Any

import pytest

from pdfeditor.services.translation.azure import ENDPOINT as AZURE_ENDPOINT
from pdfeditor.services.translation.http import Reply, Request
from pdfeditor.services.translation.mymemory import ENDPOINT as MYMEMORY_ENDPOINT
from pdfeditor.services.translation.web_http import WEB_ENDPOINT_ORIGINS, make_xhr_opener


class FakeXHR:
    """Records the calls a synchronous XMLHttpRequest receives, and answers with a scripted
    status and body."""

    def __init__(self, status: int = 200, text: str = "{}", send_error: Exception | None = None):
        self.status = status
        self.responseText = text
        self.send_error = send_error
        self.timeout = 0
        self.withCredentials = True
        self.calls: list[tuple[str, Any]] = []

    def open(self, method: str, url: str, asynchronous: bool) -> None:
        self.calls.append(("open", (method, url, asynchronous)))

    def setRequestHeader(self, name: str, value: str) -> None:
        self.calls.append(("setRequestHeader", (name, value)))

    def send(self, data: Any = None) -> None:
        self.calls.append(("send", data))
        if self.send_error is not None:
            raise self.send_error


def install_js(monkeypatch: pytest.MonkeyPatch, xhr: FakeXHR) -> None:
    """Put a fake ``js`` module in sys.modules; monkeypatch removes it after the test."""
    module = types.ModuleType("js")
    module.XMLHttpRequest = types.SimpleNamespace(new=lambda: xhr)  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "js", module)


def test_get_opens_synchronously_and_returns_the_reply(monkeypatch: pytest.MonkeyPatch) -> None:
    xhr = FakeXHR(200, '{"responseStatus": 200}')
    install_js(monkeypatch, xhr)
    url = "https://api.mymemory.translated.net/get?q=x"
    reply = make_xhr_opener()(Request(url, "GET", {}, None), 20.0)
    assert reply == Reply(200, b'{"responseStatus": 200}')
    assert ("open", ("GET", url, False)) in xhr.calls
    assert xhr.withCredentials is False
    assert xhr.timeout == 20000
    assert ("send", None) in xhr.calls


def test_user_agent_is_not_set_but_other_headers_are(monkeypatch: pytest.MonkeyPatch) -> None:
    xhr = FakeXHR()
    install_js(monkeypatch, xhr)
    headers = {
        "User-Agent": "Elanero",
        "Accept": "application/json",
        "Content-Type": "application/json; charset=utf-8",
        "Accept-Encoding": "gzip",
        "Content-Length": "2",
    }
    make_xhr_opener()(Request("https://libretranslate.com/translate", "POST", headers, b"{}"), 5.0)
    names = [args[0] for name, args in xhr.calls if name == "setRequestHeader"]
    assert names == ["Accept", "Content-Type"]


def test_a_post_body_is_sent_as_text(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pyodide passes no bytes to XHR: the UTF-8 JSON body goes as a str, decoded losslessly."""
    xhr = FakeXHR()
    install_js(monkeypatch, xhr)
    text = '{"q": "Grüße"}'
    make_xhr_opener()(
        Request("https://libretranslate.com/translate", "POST", {}, text.encode()), 5.0
    )
    sent = [args for name, args in xhr.calls if name == "send"]
    assert sent == [text]
    assert isinstance(sent[0], str)


def test_a_non_utf8_body_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    """Never happens for our clients (all bodies are UTF-8 JSON); the test documents it."""
    install_js(monkeypatch, FakeXHR())
    bad = Request("https://libretranslate.com/translate", "POST", {}, b"\xff\xfe")
    with pytest.raises(UnicodeDecodeError):
        make_xhr_opener()(bad, 5.0)


def test_an_open_exception_is_a_network_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    xhr = FakeXHR()

    def refuse(method: str, url: str, asynchronous: bool) -> None:
        raise RuntimeError("invalid URL")

    xhr.open = refuse  # type: ignore[method-assign]
    install_js(monkeypatch, xhr)
    with pytest.raises(OSError, match="network request failed"):
        make_xhr_opener()(Request("https://libretranslate.com/translate", "GET", {}, None), 5.0)


def test_a_missing_response_text_is_an_empty_body(monkeypatch: pytest.MonkeyPatch) -> None:
    install_js(monkeypatch, FakeXHR(status=204, text=None))  # type: ignore[arg-type]
    reply = make_xhr_opener()(Request("https://libretranslate.com/translate", "GET", {}, None), 5.0)
    assert reply == Reply(204, b"")


def test_status_zero_is_a_network_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    install_js(monkeypatch, FakeXHR(status=0, text=""))
    with pytest.raises(OSError, match="network request failed"):
        make_xhr_opener()(Request("https://libretranslate.com/translate", "GET", {}, None), 5.0)


def test_a_send_exception_is_a_network_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    install_js(monkeypatch, FakeXHR(send_error=RuntimeError("blocked by CORS")))
    with pytest.raises(OSError, match="network request failed"):
        make_xhr_opener()(Request("https://libretranslate.com/translate", "GET", {}, None), 5.0)


def test_web_origins_are_the_three_from_w03() -> None:
    """Hard-coded on purpose: the set must match docs/web/spikes/W0.3-results.md (its CSP
    connect-src line lists the same three). Changing one means changing the spike too."""
    assert {
        "https://api.mymemory.translated.net",
        "https://api.cognitive.microsofttranslator.com",
        "https://libretranslate.com",
    } == WEB_ENDPOINT_ORIGINS


def test_web_origins_cover_each_default_endpoint() -> None:
    def origin(url: str) -> str:
        parts = urllib.parse.urlsplit(url)
        return f"{parts.scheme}://{parts.netloc}"

    assert {
        "https://api.mymemory.translated.net",
        "https://api.cognitive.microsofttranslator.com",
        "https://libretranslate.com",
    } == WEB_ENDPOINT_ORIGINS
    assert origin(MYMEMORY_ENDPOINT) in WEB_ENDPOINT_ORIGINS
    assert origin(AZURE_ENDPOINT) in WEB_ENDPOINT_ORIGINS
    # LibreTranslate has no default host in code (the user names the server), so the list is
    # the source of truth for its public instance.
    assert "https://libretranslate.com" in WEB_ENDPOINT_ORIGINS


def test_web_http_imports_on_the_desktop_without_js() -> None:
    result = subprocess.run(
        [sys.executable, "-c", "import pdfeditor.services.translation.web_http"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
