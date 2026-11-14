"""LibreTranslate: a server the user names (their own or a community one), with an optional key.

Detects the source language itself (``source: "auto"``). Only http and https addresses are
accepted, so a typo can't turn into a request to a local file or some other scheme.
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

_SERVICE_CODES = {"no": "nb", "zh": "zh-Hans"}


def _service_code(code: str) -> str:
    """LibreTranslate's code for ``code`` (Norwegian is Bokmål, Chinese is Simplified)."""
    code = code.strip()
    return _SERVICE_CODES.get(code.lower(), code)


def check_url(url: str) -> str:
    """The server address without a trailing slash.

    :class:`ConfigError` if none is set yet; :class:`ServiceError` if it isn't an http(s)
    address with a host (an empty host or stray whitespace counts as invalid).
    """
    url = url.strip().rstrip("/")
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

    def __init__(self, url: str, key: str = "", opener: Opener | None = None) -> None:
        self.base_url = check_url(url)
        self.homepage = self.base_url
        self.privacy_url = PRIVACY_NOTICE_URL
        self.key = key.strip()
        self.cache_id = f"libretranslate:{self.base_url}:{bool(self.key)}"
        self.opener = opener

    def languages(self) -> dict[str, str]:
        return dict(COMMON_LANGUAGES)

    def _body(self, text: str, source: str | None, target: str) -> dict[str, Any]:
        body: dict[str, Any] = {
            "q": text,
            "source": _service_code(source) if source else "auto",
            "target": _service_code(target),
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
        return Translation(translated, str(code) if code else None, self.id)

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
