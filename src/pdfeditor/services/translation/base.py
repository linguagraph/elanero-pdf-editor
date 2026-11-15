"""The translation service protocol, its result and the errors every service raises.

Messages in the errors are shown to the user as they are, so they say what to do next
rather than what went wrong inside the code.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from pdfeditor.core.jobs import CancelToken

# The part of PRIVACY.md that says what translation sends and to whom.
PRIVACY_NOTICE_URL = "https://github.com/linguagraph/elanero-pdf-editor/blob/main/PRIVACY.md#when-elanero-uses-the-internet"
# Languages offered in the pickers: the codes every service here accepts (ISO 639-1, with a
# region where it matters). Services map them to their own codes when they make a request.
COMMON_LANGUAGES: dict[str, str] = {
    "en": "English",
    "bg": "Bulgarian",
    "cs": "Czech",
    "da": "Danish",
    "de": "German",
    "el": "Greek",
    "es": "Spanish",
    "et": "Estonian",
    "fi": "Finnish",
    "fr": "French",
    "hu": "Hungarian",
    "it": "Italian",
    "ja": "Japanese",
    "ko": "Korean",
    "lt": "Lithuanian",
    "lv": "Latvian",
    "nl": "Dutch",
    "no": "Norwegian",
    "pl": "Polish",
    "pt": "Portuguese",
    "ro": "Romanian",
    "ru": "Russian",
    "sk": "Slovak",
    "sl": "Slovenian",
    "sv": "Swedish",
    "tr": "Turkish",
    "uk": "Ukrainian",
    "zh": "Chinese",
}


def base_code(code: str) -> str:
    """The language without its region: "de-DE" -> "de"."""
    return code.strip().replace("_", "-").split("-")[0].lower()


@dataclass(frozen=True)
class Translation:
    text: str
    source_detected: str | None  # the language the service found, when it detects one
    service_id: str


class TranslationError(Exception):
    """Base of every error a translation service raises; ``message`` is user-facing.

    ``partial`` holds the translation of the text up to the failure, when some chunks of a
    longer selection were already translated.
    """

    def __init__(self, message: str, partial: str = "") -> None:
        super().__init__(message)
        self.message = message
        self.partial = partial
        # The results of the texts that were translated before this error, set by the batch
        # helpers below; the selection code turns them into ``partial``.
        self.done: list[Translation] = []


class OfflineError(TranslationError):
    """No connection, or the service didn't answer in time."""


class QuotaError(TranslationError):
    """The free allowance for today or this month is used up, or too many requests came."""


class AuthError(TranslationError):
    """The key is wrong, or the server refuses us."""


class ConfigError(TranslationError):
    """A setting is missing (a DeepL key, a LibreTranslate address). Fixed in Preferences."""


class TooLongError(TranslationError):
    """The text is more than the service accepts."""


class SameLanguageError(TranslationError):
    """The text and the target language are the same, so there is nothing to translate."""


class ServiceError(TranslationError):
    """Anything else the service reports, or a bad configuration."""


class Translator(Protocol):
    """One translation service, configured with its key or server address."""

    id: str
    name: str
    homepage: str
    privacy_url: str
    detects_source: bool
    max_request_bytes: int
    max_text_chars: int  # the longest selection this service takes at once
    # Identifies this service *and its configuration* (the server, the plan): the translation
    # cache and the user's consent are keyed on it.
    cache_id: str

    def languages(self) -> dict[str, str]:
        """Language code -> English name, for the pickers."""
        ...

    def translate(
        self, text: str, source: str | None, target: str, token: CancelToken | None = None
    ) -> Translation:
        """Translate one request's worth of text (at most ``max_request_bytes`` UTF-8 bytes).

        ``source`` None asks the service to detect the language (only when ``detects_source``).
        """
        ...

    def test_connection(self, token: CancelToken | None = None) -> None:
        """Raise a :class:`TranslationError` if the service can't be used with this config."""
        ...


def translate_each(
    translator: Translator,
    texts: list[str],
    source: str | None,
    target: str,
    token: CancelToken | None = None,
) -> list[Translation]:
    """Translate the texts one request each. Later texts reuse the language the first one
    detected, so they skip detection."""
    done: list[Translation] = []
    current = source
    for text in texts:
        if token is not None:
            token.check()
        try:
            result = translator.translate(text, current, target, token)
        except TranslationError as exc:
            exc.done = list(done)
            raise
        done.append(result)
        if current is None and result.source_detected:
            current = result.source_detected
    return done


def translate_batch(
    translator: Translator,
    texts: list[str],
    source: str | None,
    target: str,
    token: CancelToken | None = None,
) -> list[Translation]:
    """Translate several texts: in as few requests as the service allows when it batches
    (its own ``translate_many``), else one request per text."""
    batched = getattr(translator, "translate_many", None)
    if batched is not None:
        result: list[Translation] = batched(texts, source, target, token)
        return result
    return translate_each(translator, texts, source, target, token)
