"""Translation calls for the web (W6.6): the service list, a translate call and a connection test.

The services are the desktop's clients, unchanged. The web differs in its transport (the engine
worker's gated XHR, ``elanero_net``), the fixed LibreTranslate address and the limits. Credentials
come in with each call and are never stored, logged or echoed; errors carry a fixed message.
"""

from __future__ import annotations

import importlib
import logging
import time
from typing import Any

from pdfeditor.core.jobs import CancelToken
from pdfeditor.services.translation import TranslationConfig, make_translator, translate_selection
from pdfeditor.services.translation.base import (
    AuthError,
    ConfigError,
    OfflineError,
    QuotaError,
    SameLanguageError,
    TooLongError,
    TranslationError,
    Translator,
)
from pdfeditor.services.translation.web_http import make_xhr_opener
from pdfeditor.webapi import dto
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

log = logging.getLogger(__name__)

# The services the web offers, in the order the pickers show them (the CSP fixes the hosts).
WEB_SERVICES: tuple[str, ...] = ("mymemory", "azure", "libretranslate")
NEEDS_KEY: frozenset[str] = frozenset({"azure", "libretranslate"})
WEB_LIBRETRANSLATE_URL = "https://libretranslate.com"  # the only LibreTranslate server reachable
REQUEST_SECONDS = 10.0  # per request, below the desktop's 20 s
DEADLINE_SECONDS = 30.0  # for one call, checked between requests (W6.6 section 3)
MAX_TEXT_CHARS = 40_000  # the main thread's cap (W6.6 section 6), enforced here too
_TOO_LONG_MESSAGE = "The selection is too long to translate in one go."
_CLOCK: Any = time.monotonic  # a test replaces it to pass the deadline without waiting


class _Deadline(CancelToken):
    """Stops a call once its time is up, with an offline error rather than ``Cancelled``, so the
    text translated before the stop comes back as ``partial``."""

    def __init__(self, seconds: float) -> None:
        super().__init__()
        self._until = _CLOCK() + seconds

    def check(self) -> None:
        super().check()
        if _CLOCK() >= self._until:
            raise OfflineError("The translation took too long. Select less text and try again.")


def _web_opener() -> Any:
    """The engine worker's gated XHR (registered as ``elanero_net``), with the per-request cap."""
    net: Any = importlib.import_module("elanero_net")  # only exists inside the web engine
    send = make_xhr_opener(net.open_xhr)
    return lambda request, timeout: send(request, min(timeout, REQUEST_SECONDS))


def _translator(service: str, credentials: dto.TranslationCredentials) -> Translator:
    if service not in WEB_SERVICES:  # DeepL and anything else: refused before any request
        raise RpcFailure(TRANSLATION_CONFIG, "this translation service is not offered on the web")
    config = TranslationConfig(
        mymemory_email=credentials.mymemory_email or "",
        azure_key=credentials.azure_key or "",
        azure_region=credentials.azure_region or "",
        libretranslate_url=WEB_LIBRETRANSLATE_URL,
        libretranslate_key=credentials.libre_key or "",
        opener=_web_opener(),
    )
    return make_translator(service, config)


def _check_language(translator: Translator, path: str, code: str | None) -> None:
    # A code the service does not list never reaches its request, so it cannot shape a URL.
    if code is not None and code not in translator.languages():
        raise RpcFailure(INVALID_ARGS, f"{path}: not a language of this service", {"path": path})


# Each error class to its code and fixed message, most specific first.
_FAILURES: tuple[tuple[type[TranslationError], str, str], ...] = (
    (OfflineError, TRANSLATION_OFFLINE, "The translation service could not be reached."),
    (QuotaError, TRANSLATION_QUOTA, "The translation service's limit has been reached."),
    (AuthError, TRANSLATION_AUTH, "The translation service refused the key."),
    (ConfigError, TRANSLATION_CONFIG, "The translation service is not set up."),
    (TooLongError, TRANSLATION_TOO_LONG, _TOO_LONG_MESSAGE),
    (SameLanguageError, TRANSLATION_SAME_LANGUAGE, "The text is already in that language."),
    (TranslationError, TRANSLATION_SERVICE, "The translation service failed."),
)


def _failure(exc: TranslationError) -> RpcFailure:
    code, message = next((c, m) for cls, c, m in _FAILURES if isinstance(exc, cls))
    return RpcFailure(code, message, {"partial": exc.partial})


def info(params: dto.Empty) -> dto.TranslationInfoResult:
    """The services, limits and languages, read from the clients. No request is sent."""
    config = TranslationConfig(libretranslate_url=WEB_LIBRETRANSLATE_URL)
    services: list[dto.TranslationServiceDto] = []
    languages: dict[str, tuple[dto.LanguageDto, ...]] = {}
    for service in WEB_SERVICES:
        translator = make_translator(service, config)
        services.append(
            dto.TranslationServiceDto(
                id=service,
                name=translator.name,
                privacy_url=translator.privacy_url,
                needs_key=service in NEEDS_KEY,
                detects_source=translator.detects_source,
                max_chars=translator.max_text_chars,
            )
        )
        pairs = translator.languages().items()
        languages[service] = tuple(dto.LanguageDto(code=code, name=name) for code, name in pairs)
    return dto.TranslationInfoResult(services=tuple(services), languages=languages)


def translate(params: dto.TranslateParams) -> dto.TranslateResult:
    translator = _translator(params.service, params.credentials)
    _check_language(translator, "params.source", params.source)
    _check_language(translator, "params.target", params.target)
    if len(params.text) > MAX_TEXT_CHARS:
        raise RpcFailure(TRANSLATION_TOO_LONG, _TOO_LONG_MESSAGE, {"partial": ""})
    # The count and the service are logged; the text and the credentials never are.
    log.info("translation requested: %s, %d characters", params.service, len(params.text))
    try:
        result = translate_selection(
            translator, params.text, params.source, params.target, _Deadline(DEADLINE_SECONDS)
        )
    except TranslationError as exc:
        raise _failure(exc) from exc
    return dto.TranslateResult(
        text=result.text, detected=result.source_detected, service=result.service_id
    )


def check_connection(params: dto.TranslationTestParams) -> dto.Empty:
    """Send a short fixed text to check the service and the key. It is not document text."""
    translator = _translator(params.service, params.credentials)
    try:
        translator.test_connection(_Deadline(DEADLINE_SECONDS))
    except TranslationError as exc:
        raise _failure(exc) from exc
    return dto.Empty()
