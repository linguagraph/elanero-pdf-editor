"""MyMemory (MT by Translated.net): free, no key; an email raises the daily allowance.

It doesn't detect the source language, so the caller must name it. Requests are limited to
500 bytes, which the caller's chunking respects, and a selection is capped at 2,000 characters.
"""

from __future__ import annotations

import html
import logging
import urllib.parse
from typing import Any

from pdfeditor.core.jobs import CancelToken
from pdfeditor.services.translation.base import (
    COMMON_LANGUAGES,
    QuotaError,
    ServiceError,
    Translation,
)
from pdfeditor.services.translation.http import Opener, request_json, unexpected

log = logging.getLogger(__name__)

ENDPOINT = "https://api.mymemory.translated.net/get"
# Words MyMemory uses when the free allowance is spent (it answers 200 with a warning instead).
QUOTA_MARKERS = ("MYMEMORY WARNING", "USED ALL", "NEXT AVAILABLE")
_SERVICE_CODES = {"zh": "zh-CN", "no": "nb"}


def _service_code(code: str) -> str:
    """MyMemory's own code for ``code`` (Chinese is Simplified, Norwegian is Bokmål)."""
    code = code.strip()
    return _SERVICE_CODES.get(code.lower(), code)


class MyMemoryTranslator:
    id = "mymemory"
    name = "MyMemory (Translated.net)"
    homepage = "https://mymemory.translated.net/"
    privacy_url = "https://translated.com/confidentiality"
    detects_source = False
    max_request_bytes = 500
    max_text_chars = 2000
    cache_id = "mymemory"

    def __init__(self, email: str = "", opener: Opener | None = None) -> None:
        self.email = email.strip()  # optional: MyMemory raises the daily limit for it
        self.opener = opener

    def languages(self) -> dict[str, str]:
        return dict(COMMON_LANGUAGES)

    def translate(
        self, text: str, source: str | None, target: str, token: CancelToken | None = None
    ) -> Translation:
        if source is None:
            raise ServiceError(
                "MyMemory can't detect the language. Choose the language of the text."
            )
        if token is not None:
            token.check()
        params = {"q": text, "langpair": f"{_service_code(source)}|{_service_code(target)}"}
        if self.email:
            params["de"] = self.email
        url = f"{ENDPOINT}?{urllib.parse.urlencode(params)}"
        status, data = request_json(url, opener=self.opener)
        if status == 429:
            raise QuotaError(
                "MyMemory has received too many requests. Wait a moment and try again."
            )
        if status != 200 or not isinstance(data, dict):
            raise unexpected(self.name, status)
        return self._parse(data)

    def _parse(self, data: dict[str, Any]) -> Translation:
        details = str(data.get("responseDetails") or "")
        status = str(data.get("responseStatus", ""))
        response = data.get("responseData")
        translated = response.get("translatedText") if isinstance(response, dict) else None
        text = str(translated or "")
        combined = f"{details} {text}".upper()
        if status == "429" or any(marker in combined for marker in QUOTA_MARKERS):
            raise QuotaError("MyMemory's free daily limit is used up. Try again tomorrow.")
        if status != "200" or not isinstance(translated, str):
            log.info("MyMemory answered status %s", status)
            message = details.strip() or "couldn't translate this text. Try again later."
            raise ServiceError(f"MyMemory: {message}")
        return Translation(html.unescape(text), None, self.id)

    def test_connection(self, token: CancelToken | None = None) -> None:
        self.translate("Hello", "en", "fr", token)
