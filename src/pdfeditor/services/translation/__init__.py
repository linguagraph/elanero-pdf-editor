"""Translate selected PDF text with an online service (opt-in; see PRIVACY.md).

``translate_selection`` is the one entry point the UI uses: it cleans the text, splits it to the
service's request limit, translates the pieces in order and puts the paragraph breaks back. A
small in-memory cache returns repeated requests without sending them again. Nothing here logs
the text, keys or addresses.
"""

from __future__ import annotations

import logging
import threading
from collections import OrderedDict
from collections.abc import Iterable
from dataclasses import dataclass

from pdfeditor.core.jobs import CancelToken
from pdfeditor.services.translation.azure import AzureTranslator
from pdfeditor.services.translation.base import (
    PRIVACY_NOTICE_URL,
    ConfigError,
    SameLanguageError,
    ServiceError,
    TooLongError,
    Translation,
    TranslationError,
    Translator,
    base_code,
    translate_batch,
)
from pdfeditor.services.translation.deepl import DeepLTranslator
from pdfeditor.services.translation.http import Opener
from pdfeditor.services.translation.libretranslate import LibreTranslateTranslator, ServerLanguage
from pdfeditor.services.translation.mymemory import MyMemoryTranslator
from pdfeditor.services.translation.text import clean_pdf_text, split_chunks

log = logging.getLogger(__name__)

__all__ = [
    "DEFAULT_SERVICE",
    "PRIVACY_NOTICE_URL",
    "SERVICES",
    "ConfigError",
    "Translation",
    "TranslationConfig",
    "TranslationError",
    "Translator",
    "clear_cache",
    "configuration_problem",
    "make_translator",
    "translate_selection",
]

# Service id -> the name shown in the pickers and the consent notice.
SERVICES: dict[str, str] = {
    "mymemory": MyMemoryTranslator.name,
    "deepl": DeepLTranslator.name,
    "libretranslate": LibreTranslateTranslator.name,
    "azure": AzureTranslator.name,
}
DEFAULT_SERVICE = "mymemory"
CACHE_SIZE = 64


@dataclass(frozen=True)
class TranslationConfig:
    """What the services need from the user's settings. Keys live in the secret store; the
    caller reads them and passes them in, so this module never touches storage."""

    mymemory_email: str = ""
    deepl_key: str = ""
    libretranslate_url: str = ""
    libretranslate_key: str = ""
    # The server's own language list (code -> name), when Test connection has stored one for
    # this address; None means the built-in list.
    libretranslate_languages: list[ServerLanguage] | None = None
    azure_key: str = ""
    azure_region: str = ""
    # the transport: urllib on the desktop, the browser's XMLHttpRequest on the web (W3)
    opener: Opener | None = None


def make_translator(service_id: str, config: TranslationConfig) -> Translator:
    if service_id == "mymemory":
        return MyMemoryTranslator(config.mymemory_email, config.opener)
    if service_id == "deepl":
        return DeepLTranslator(config.deepl_key, config.opener)
    if service_id == "libretranslate":
        return LibreTranslateTranslator(
            config.libretranslate_url,
            config.libretranslate_key,
            config.opener,
            languages=config.libretranslate_languages,
        )
    if service_id == "azure":
        return AzureTranslator(config.azure_key, config.azure_region, config.opener)
    raise ServiceError(f"Unknown translation service: {service_id}")


def configuration_problem(service_id: str, config: TranslationConfig) -> str | None:
    """Why ``service_id`` can't be used with ``config`` yet, or None if it can.

    Checks what the service needs before a request is possible: a key, or a server address.
    """
    if service_id == "deepl" and not config.deepl_key.strip():
        return "the DeepL API key is missing"
    if service_id == "azure" and not config.azure_key.strip():
        return "the Azure key is missing"
    try:
        make_translator(service_id, config)
    except TranslationError as exc:
        return exc.message
    return None


_cache: OrderedDict[tuple[str, str | None, str, str], Translation] = OrderedDict()
_cache_lock = threading.Lock()


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


def _assemble(units: Iterable[tuple[str, str]], results: list[Translation]) -> str:
    """The translated text: each unit's body replaced by its result, its trailing whitespace
    kept. Units whose body is empty stand for themselves. Stops at the first missing result."""
    remaining = iter(results)
    out: list[str] = []
    for body, trailing in units:
        if not body:
            out.append(trailing)
            continue
        result = next(remaining, None)
        if result is None:
            break
        out.append(result.text + trailing)
    return "".join(out)


def translate_selection(
    translator: Translator,
    raw_text: str,
    source: str | None,
    target: str,
    token: CancelToken | None = None,
) -> Translation:
    """Translate the text of a PDF selection; ``source`` None asks the service to detect it.

    Raises :class:`TooLongError` above the service's ``max_text_chars``, and
    :class:`SameLanguageError` when source and target are the same language. If a request fails
    part way, the error's ``partial`` holds the chunks translated so far. A cancelled ``token``
    raises :class:`pdfeditor.core.jobs.Cancelled` between requests.
    """
    text = clean_pdf_text(raw_text)
    if not text:
        raise ServiceError("There is no text in the selection to translate.")
    limit = translator.max_text_chars
    if len(text) > limit:
        raise TooLongError(
            f"The selection is longer than {limit:,} characters, the most {translator.name} "
            "translates at once. Select less text."
        )
    if source is not None and base_code(source) == base_code(target):
        raise SameLanguageError(
            "The text is already in that language. Pick another language to translate to."
        )
    key = (translator.cache_id, source, target, text)
    with _cache_lock:
        cached = _cache.get(key)
        if cached is not None:
            _cache.move_to_end(key)
            log.debug("translation served from cache (%s)", translator.id)
            return cached

    chunks = split_chunks(text, translator.max_request_bytes)
    units = [(chunk.rstrip(), chunk[len(chunk.rstrip()) :]) for chunk in chunks]
    bodies = [body for body, _trailing in units if body]
    try:
        results = translate_batch(translator, bodies, source, target, token)
    except TranslationError as exc:
        exc.partial = _assemble(units, exc.done)
        raise
    detected = next((r.source_detected for r in results if r.source_detected), None)
    translation = Translation(_assemble(units, results), detected, translator.id)
    log.info(
        "translated %d characters in %d request(s) with %s",
        len(text),
        len(chunks),
        translator.id,
    )
    with _cache_lock:
        _cache[key] = translation
        while len(_cache) > CACHE_SIZE:
            _cache.popitem(last=False)
    return translation
