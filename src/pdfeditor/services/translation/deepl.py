"""DeepL API Free (or Pro): the user's own key; keys ending in ":fx" are for the free plan.

The free and paid plans are separate hosts, so the key decides which one is called.
"""

from __future__ import annotations

import logging
from typing import Any

from pdfeditor.core.jobs import CancelToken
from pdfeditor.services.translation.base import (
    COMMON_LANGUAGES,
    AuthError,
    ConfigError,
    QuotaError,
    TooLongError,
    Translation,
)
from pdfeditor.services.translation.http import Opener, request_json, unexpected

log = logging.getLogger(__name__)

FREE_HOST = "https://api-free.deepl.com"
PRO_HOST = "https://api.deepl.com"
PRIVACY_URL = "https://www.deepl.com/privacy"
# DeepL wants regional codes for these two; "no" is Norwegian Bokmål ("NB").
_ALIASES = {"en": "EN-US", "pt": "PT-PT", "no": "NB"}


def host_for(key: str) -> str:
    return FREE_HOST if key.strip().endswith(":fx") else PRO_HOST


def _service_code(code: str) -> str:
    """DeepL's code for ``code``, as a target language (regional where DeepL needs it)."""
    code = code.strip()
    return _ALIASES.get(code.lower(), code.upper())


def _source_code(code: str) -> str:
    """DeepL's code for ``code`` as a source language: the base code only."""
    return _service_code(code).split("-")[0]


class DeepLTranslator:
    id = "deepl"
    name = "DeepL"
    homepage = "https://www.deepl.com/pro-api"
    privacy_url = PRIVACY_URL
    detects_source = True
    max_request_bytes = 128 * 1024
    max_text_chars = 10_000

    def __init__(self, key: str, opener: Opener | None = None) -> None:
        self.key = key.strip()
        self.host = host_for(self.key)
        self.cache_id = "deepl-free" if self.host == FREE_HOST else "deepl-pro"
        self.opener = opener

    def languages(self) -> dict[str, str]:
        return dict(COMMON_LANGUAGES)

    def _headers(self) -> dict[str, str]:
        if not self.key:
            raise ConfigError("Add your DeepL API key in Preferences ▸ Translation.")
        return {"Authorization": f"DeepL-Auth-Key {self.key}"}

    def translate(
        self, text: str, source: str | None, target: str, token: CancelToken | None = None
    ) -> Translation:
        headers = self._headers()
        if token is not None:
            token.check()
        body: dict[str, Any] = {"text": [text], "target_lang": _service_code(target)}
        if source:
            body["source_lang"] = _source_code(source)
        status, data = request_json(
            f"{self.host}/v2/translate",
            method="POST",
            headers=headers,
            body=body,
            opener=self.opener,
        )
        self._raise_for_status(status)
        try:
            item = data["translations"][0]
            translated = str(item["text"])
            detected = item.get("detected_source_language")
        except (TypeError, KeyError, IndexError) as exc:
            raise unexpected(self.name, status) from exc
        return Translation(translated, str(detected).lower() if detected else None, self.id)

    def _raise_for_status(self, status: int) -> None:
        if status == 200:
            return
        log.info("DeepL answered HTTP %d", status)
        if status == 403:
            raise AuthError("DeepL rejected the API key. Check it in Preferences ▸ Translation.")
        if status == 456:
            raise QuotaError("Your DeepL character quota for this month is used up.")
        if status == 413:
            raise TooLongError("The text is too long for DeepL. Select less text.")
        if status == 429:
            raise QuotaError("DeepL has received too many requests. Wait a moment and try again.")
        raise unexpected(self.name, status)

    def test_connection(self, token: CancelToken | None = None) -> None:
        headers = self._headers()
        status, _data = request_json(f"{self.host}/v2/usage", headers=headers, opener=self.opener)
        self._raise_for_status(status)
