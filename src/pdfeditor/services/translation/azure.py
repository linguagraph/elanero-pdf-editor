"""Azure AI Translator (Translator v3): the user's own key, and the resource's region when it has
one. It detects the source language and takes several texts in one request.

A request holds at most 50,000 characters and 1,000 texts, so longer batches are sent as several
requests. Each answer is matched to its text by position.
"""

from __future__ import annotations

import logging
import urllib.parse
from typing import Any

from pdfeditor.core.jobs import CancelToken
from pdfeditor.services.translation.base import (
    COMMON_LANGUAGES,
    AuthError,
    ConfigError,
    QuotaError,
    ServiceError,
    Translation,
    TranslationError,
    base_code,
)
from pdfeditor.services.translation.http import Opener, request_json, unexpected

log = logging.getLogger(__name__)

ENDPOINT = "https://api.cognitive.microsofttranslator.com/translate"
PRIVACY_URL = "https://www.microsoft.com/privacy/privacystatement"
HOMEPAGE = "https://azure.microsoft.com/products/ai-services/ai-translator"
MAX_BATCH_CHARS = 50_000
MAX_BATCH_TEXTS = 1000
FREE_QUOTA_CODE = 403001
# Our codes Azure names differently. Only codes chosen in our pickers come through here.
_SERVICE_CODES = {"zh": "zh-Hans", "zh-hant": "zh-Hant", "no": "nb", "pt": "pt-pt"}
# Codes Azure reports as detected, shown as ours: every Chinese script is "zh" for us.
_DETECTED_CODES = {"zh-hans": "zh", "zh-hant": "zh", "nb": "no", "pt-pt": "pt"}


def _service_code(code: str) -> str:
    """Azure's code for a language picked in our pickers."""
    code = code.strip()
    return _SERVICE_CODES.get(code.lower(), base_code(code))


def _detected_code(code: str) -> str:
    """Our code for a language Azure reports it detected, e.g. "zh-Hans" -> "zh"."""
    code = code.strip()
    return _DETECTED_CODES.get(code.lower(), base_code(code))


def _batches(texts: list[str]) -> list[list[str]]:
    """Group texts so that no request exceeds the character or element limit."""
    batches: list[list[str]] = []
    current: list[str] = []
    size = 0
    for text in texts:
        if current and (size + len(text) > MAX_BATCH_CHARS or len(current) >= MAX_BATCH_TEXTS):
            batches.append(current)
            current, size = [], 0
        current.append(text)
        size += len(text)
    if current:
        batches.append(current)
    return batches


class AzureTranslator:
    id = "azure"
    name = "Azure AI Translator"
    homepage = HOMEPAGE
    privacy_url = PRIVACY_URL
    detects_source = True
    max_request_bytes = 40_000
    max_text_chars = 10_000

    def __init__(self, key: str, region: str = "", opener: Opener | None = None) -> None:
        self.key = key.strip()
        self.region = region.strip()
        self.cache_id = f"azure:{self.region}"
        self.opener = opener

    def languages(self) -> dict[str, str]:
        return {**COMMON_LANGUAGES, "zh-Hant": "Chinese (Traditional)"}

    def _headers(self) -> dict[str, str]:
        if not self.key:
            raise ConfigError("Add your Azure key in Preferences ▸ Translation.")
        headers = {
            "Ocp-Apim-Subscription-Key": self.key,
            "Content-Type": "application/json; charset=UTF-8",
        }
        if self.region:
            headers["Ocp-Apim-Subscription-Region"] = self.region
        return headers

    def _url(self, source: str | None, target: str) -> str:
        params: list[tuple[str, str]] = [("api-version", "3.0"), ("to", _service_code(target))]
        if source:
            params.append(("from", _service_code(source)))
        return f"{ENDPOINT}?{urllib.parse.urlencode(params)}"

    def translate(
        self, text: str, source: str | None, target: str, token: CancelToken | None = None
    ) -> Translation:
        return self.translate_many([text], source, target, token)[0]

    def translate_many(
        self,
        texts: list[str],
        source: str | None,
        target: str,
        token: CancelToken | None = None,
    ) -> list[Translation]:
        """Translate the texts in as few requests as the limits allow. A later batch that
        fails leaves the earlier results on the error (``done``).

        When the source is detected, every batch detects again: a language reported by one
        batch is never sent back as ``from``, since Azure's own codes for it may differ from ours.
        """
        headers = self._headers()
        results: list[Translation] = []
        for batch in _batches(texts):
            if token is not None:
                token.check()
            try:
                answered = self._request(batch, source, target, headers)
            except TranslationError as exc:
                exc.done = list(results)
                raise
            results.extend(answered)
        return results

    def _request(
        self,
        texts: list[str],
        source: str | None,
        target: str,
        headers: dict[str, str],
    ) -> list[Translation]:
        body = [{"Text": text} for text in texts]
        status, data = request_json(
            self._url(source, target),
            method="POST",
            headers=headers,
            body=body,
            opener=self.opener,
        )
        if status != 200:
            raise self._error_for(status, data)
        return self._parse(data, len(texts))

    def _parse(self, data: Any, expected: int) -> list[Translation]:
        if not isinstance(data, list) or len(data) != expected:
            raise unexpected(self.name, 200)
        results: list[Translation] = []
        for item in data:
            try:
                translated = str(item["translations"][0]["text"])
            except (TypeError, KeyError, IndexError) as exc:
                raise unexpected(self.name, 200) from exc
            detected = item.get("detectedLanguage") if isinstance(item, dict) else None
            code = detected.get("language") if isinstance(detected, dict) else None
            shown = _detected_code(str(code)) if code else None
            results.append(Translation(translated, shown, self.id))
        return results

    def _error_for(self, status: int, data: Any) -> TranslationError:
        error = data.get("error") if isinstance(data, dict) else None
        message = str(error.get("message", "")) if isinstance(error, dict) else ""
        code = error.get("code") if isinstance(error, dict) else None
        log.info("Azure answered HTTP %d (code %s)", status, code)
        if status == 401:
            return AuthError("The Azure key or region was not accepted. Check both in Preferences.")
        if status == 403:
            if code == FREE_QUOTA_CODE:
                return QuotaError("Your free Azure translation quota for this month is used up.")
            return AuthError("Azure refused the request. Check the key in Preferences.")
        if status == 429:
            return QuotaError("Azure is receiving too many requests. Wait a moment and try again.")
        if status == 400 and message:
            return ServiceError(f"Azure: {message}")
        if status >= 500:
            return ServiceError("Azure is unavailable right now. Try again later.")
        return unexpected(self.name, status)

    def test_connection(self, token: CancelToken | None = None) -> None:
        """A real translation: the languages list doesn't check the key."""
        self.translate("Hello", "en", "de", token)
