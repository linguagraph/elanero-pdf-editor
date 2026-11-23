"""Translation calls for the web (W6.6): the service list and the translate call.

The web offers one service, the free MyMemory service, and no settings: no keys, no email and no
custom server (those are the desktop's). The client is the desktop's, unchanged. The web differs in
its transport (the engine worker's gated XHR, ``elanero_net``) and its limits. Errors carry a fixed
message, and neither the text nor a setting is logged.
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

# The one service the web offers (W6.6 owner decision): the CSP and the origins list its host only.
WEB_SERVICES: tuple[str, ...] = ("mymemory",)
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


def _translator() -> Translator:
    # The email is always empty: the web sends none, so MyMemory's ``de=`` parameter is never set.
    config = TranslationConfig(mymemory_email="", opener=_web_opener())
    return make_translator(WEB_SERVICES[0], config)


def _check_language(translator: Translator, path: str, code: str) -> None:
    # A code the service does not list never reaches its request, so it cannot shape a URL.
    if code not in translator.languages():
        raise RpcFailure(INVALID_ARGS, f"{path}: not a language of this service", {"path": path})


# Each error class to its code and fixed message, most specific first.
_FAILURES: tuple[tuple[type[TranslationError], str, str], ...] = (
    (OfflineError, TRANSLATION_OFFLINE, "The translation service could not be reached."),
    (QuotaError, TRANSLATION_QUOTA, "The translation service's limit has been reached."),
    (AuthError, TRANSLATION_AUTH, "The translation service refused the request."),
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
    services: list[dto.TranslationServiceDto] = []
    languages: dict[str, tuple[dto.LanguageDto, ...]] = {}
    for service in WEB_SERVICES:
        translator = make_translator(service, TranslationConfig())
        services.append(
            dto.TranslationServiceDto(
                id=service,
                name=translator.name,
                privacy_url=translator.privacy_url,
                detects_source=translator.detects_source,
                max_chars=translator.max_text_chars,
            )
        )
        pairs = translator.languages().items()
        languages[service] = tuple(dto.LanguageDto(code=code, name=name) for code, name in pairs)
    return dto.TranslationInfoResult(services=tuple(services), languages=languages)


def translate(params: dto.TranslateParams) -> dto.TranslateResult:
    translator = _translator()
    _check_language(translator, "params.source", params.source)
    _check_language(translator, "params.target", params.target)
    if len(params.text) > MAX_TEXT_CHARS:
        raise RpcFailure(TRANSLATION_TOO_LONG, _TOO_LONG_MESSAGE, {"partial": ""})
    # Only the count is logged; the text never is.
    log.info("translation requested: %d characters", len(params.text))
    try:
        result = translate_selection(
            translator, params.text, params.source, params.target, _Deadline(DEADLINE_SECONDS)
        )
    except TranslationError as exc:
        raise _failure(exc) from exc
    return dto.TranslateResult(
        text=result.text, detected=result.source_detected, service=result.service_id
    )
