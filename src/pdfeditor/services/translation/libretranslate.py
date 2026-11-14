"""LibreTranslate: a server the user names (their own or a community one), with an optional key.

Detects the source language itself (``source: "auto"``). Only http and https addresses are
accepted, so a typo can't turn into a request to a local file or some other scheme.

Language codes: the server names its languages its own way (Norwegian is "nb", Chinese "zh-Hans"
or "zh"). The static map covers a server that hasn't been asked; once Test connection has stored
the server's list, the codes the server actually lists are the ones sent.
"""

from __future__ import annotations

import logging
import urllib.parse
from typing import Any

from pdfeditor.core.jobs import CancelToken
from pdfeditor.services.translation.base import (
    COMMON_LANGUAGES,
    PRIVACY_NOTICE_URL,
    AuthError,
    ConfigError,
    QuotaError,
    ServiceError,
    TooLongError,
    Translation,
    TranslationError,
)
from pdfeditor.services.translation.http import Opener, request_json, unexpected

log = logging.getLogger(__name__)

# A language the server lists: (our code, the server's code, its name).
ServerLanguage = tuple[str, str, str]

# Our code -> the server's code, when nothing better is known (Norwegian is Bokmål, Chinese is
# Simplified).
_STATIC_CODES = {"no": "nb", "zh": "zh-Hans"}
# The server's code -> ours, for a code the server lists.
_OUR_CODES = {"nb": "no", "zh-hans": "zh"}


def normalize_url(url: str) -> str:
    """The server address as it is stored and compared: no spaces, no trailing slash.

    One function for both the saved address and the one a language list belongs to, so the two
    can't drift apart."""
    return url.strip().rstrip("/")


def _static_code(code: str) -> str:
    stripped = code.strip()
    return _STATIC_CODES.get(stripped.lower(), stripped)


def _our_code(code: str) -> str:
    stripped = code.strip()
    return _OUR_CODES.get(stripped.lower(), stripped)


def parse_language_list(items: Any) -> list[ServerLanguage]:
    """The server's ``/languages`` answer ([{code, name, ...}]) as (our code, server code, name)
    triples. Entries without a code are skipped."""
    out: list[ServerLanguage] = []
    if not isinstance(items, list):
        return out
    for item in items:
        if isinstance(item, dict) and isinstance(item.get("code"), str):
            code = item["code"]
            out.append((_our_code(code), code, str(item.get("name") or code)))
    return out


def preferred_servers(languages: list[ServerLanguage]) -> dict[str, tuple[str, str]]:
    """For each of our codes: the server's code to send, and the name.

    When the server lists several codes for one of ours (both "nb" and "no", both "zh" and
    "zh-Hans"), the one the static map would send wins. The others stay in the stored list,
    they are not dropped."""
    chosen: dict[str, tuple[str, str]] = {}
    for ours, server, name in languages:
        if ours not in chosen or server == _static_code(ours):
            chosen[ours] = (server, name)
    return chosen


def check_url(url: str) -> str:
    """The server address as stored (see :func:`normalize_url`).

    :class:`ConfigError` if none is set yet; :class:`ServiceError` if it isn't an http(s)
    address with a host (an empty host or stray whitespace counts as invalid).
    """
    url = normalize_url(url)
    if not url:
        raise ConfigError(
            "Set the LibreTranslate server address in Preferences ▸ Translation first."
        )
    parts = urllib.parse.urlsplit(url)
    invalid = (
        parts.scheme not in ("http", "https")
        or not parts.hostname
        or any(ch.isspace() for ch in url)
    )
    if invalid:
        raise ServiceError(
            "Enter the LibreTranslate server address, starting with https:// (for example "
            "https://libretranslate.com)."
        )
    return url


class LibreTranslateTranslator:
    id = "libretranslate"
    name = "LibreTranslate"
    detects_source = True
    max_request_bytes = 5000  # servers differ; this keeps requests small for all of them
    max_text_chars = 10_000

    def __init__(
        self,
        url: str,
        key: str = "",
        opener: Opener | None = None,
        languages: list[ServerLanguage] | None = None,
    ) -> None:
        self.base_url = check_url(url)
        self.homepage = self.base_url
        self.privacy_url = PRIVACY_NOTICE_URL
        self.key = key.strip()
        self.cache_id = f"libretranslate:{self.base_url}:{bool(self.key)}"
        self.opener = opener
        # The server's own list (from Test connection), by our code.
        self._servers = preferred_servers(languages) if languages else {}

    def languages(self) -> dict[str, str]:
        if not self._servers:
            return dict(COMMON_LANGUAGES)
        return {ours: name for ours, (_server, name) in self._servers.items()}

    def _service_code(self, code: str) -> str:
        """The code to send for ``code``: the server's own when its list has one for it."""
        stripped = code.strip()
        if stripped in self._servers:
            return self._servers[stripped][0]
        return _static_code(stripped)

    def fetch_languages(self, token: CancelToken | None = None) -> list[ServerLanguage]:
        """The server's language list. Raises a :class:`TranslationError` if the server doesn't
        answer with one."""
        if token is not None:
            token.check()
        status, data = request_json(f"{self.base_url}/languages", opener=self.opener)
        if status != 200:
            raise self._error_for(status, data)
        languages = parse_language_list(data)
        if not languages:
            raise unexpected(self.name, status)
        return languages

    def _body(self, text: str, source: str | None, target: str) -> dict[str, Any]:
        body: dict[str, Any] = {
            "q": text,
            "source": self._service_code(source) if source else "auto",
            "target": self._service_code(target),
            "format": "text",
        }
        if self.key:
            body["api_key"] = self.key
        return body

    def translate(
        self, text: str, source: str | None, target: str, token: CancelToken | None = None
    ) -> Translation:
        if token is not None:
            token.check()
        status, data = request_json(
            f"{self.base_url}/translate",
            method="POST",
            body=self._body(text, source, target),
            opener=self.opener,
        )
        if status != 200 or not isinstance(data, dict):
            raise self._error_for(status, data)
        translated = data.get("translatedText")
        if not isinstance(translated, str):
            raise unexpected(self.name, status)
        detected = data.get("detectedLanguage")
        code = detected.get("language") if isinstance(detected, dict) else None
        return Translation(translated, _our_code(str(code)) if code else None, self.id)

    def _error_for(self, status: int, data: Any) -> TranslationError:
        message = str(data.get("error", "")) if isinstance(data, dict) else ""
        log.info("LibreTranslate answered HTTP %d", status)
        if status == 403 or (status == 400 and "key" in message.lower()):
            return AuthError(
                "The LibreTranslate server rejected the API key. Check it in Preferences "
                "▸ Translation."
            )
        if status == 429:
            return QuotaError("The LibreTranslate server is busy or its limit is reached.")
        if status == 413:
            return TooLongError("The text is too long for this LibreTranslate server.")
        if status == 400 and message:
            return ServiceError(f"LibreTranslate: {message}")
        return unexpected(self.name, status)

    def test_connection(self, token: CancelToken | None = None) -> None:
        """A tiny real translation, so a wrong key or a wrong server fails here."""
        status, data = request_json(
            f"{self.base_url}/translate",
            method="POST",
            body=self._body("Hello", "en", "de"),
            opener=self.opener,
        )
        if status != 200:
            raise self._error_for(status, data)
