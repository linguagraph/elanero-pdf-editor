"""One small HTTP helper for the translation clients, on ``urllib`` only.

The opener is injectable so tests replace the network. Nothing sent or received is logged
here: the callers log service ids, lengths and status codes only.
"""

from __future__ import annotations

import http.client
import json
import logging
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from pdfeditor.services.translation.base import OfflineError, ServiceError

log = logging.getLogger(__name__)

USER_AGENT = "Elanero"  # generic on purpose: no version, machine or user details
TIMEOUT_SECONDS = 20.0


@dataclass(frozen=True)
class Reply:
    status: int
    body: bytes


Opener = Callable[[urllib.request.Request, float], Reply]


def urllib_opener(request: urllib.request.Request, timeout: float) -> Reply:
    """The real opener. HTTP error statuses come back as replies; network failures raise."""
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return Reply(response.status, response.read())
    except urllib.error.HTTPError as exc:
        try:
            body = exc.read()
        finally:
            exc.close()
        return Reply(exc.code, body)


def request_json(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: Any = None,  # any JSON value: an object, or a list (Azure)
    opener: Opener | None = None,
) -> tuple[int, Any]:
    """Send a request and return ``(status, decoded JSON or None)``.

    A network failure or timeout raises :class:`OfflineError`; an address the HTTP stack
    can't use raises :class:`ServiceError`. Interpreting the status is the caller's job,
    since each service has its own codes.
    """
    all_headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    all_headers.update(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        all_headers.setdefault("Content-Type", "application/json; charset=utf-8")
    try:
        request = urllib.request.Request(url, data=data, headers=all_headers, method=method)
        send = opener or urllib_opener
        reply = send(request, TIMEOUT_SECONDS)
    except (ValueError, http.client.InvalidURL) as exc:  # a malformed address, not a network fault
        log.info("translation address rejected: %s", type(exc).__name__)
        raise ServiceError(
            "The translation service address isn't valid. Check it in Preferences ▸ Translation."
        ) from exc
    except (urllib.error.URLError, OSError, http.client.HTTPException) as exc:
        # URLError and timeouts are OSErrors; HTTPException covers broken responses.
        log.info("translation request failed: %s", type(exc).__name__)
        raise OfflineError(
            "Couldn't reach the translation service. Check your internet connection and try again."
        ) from exc
    log.info("translation reply: HTTP %d, %d bytes", reply.status, len(reply.body))
    try:
        decoded: Any = json.loads(reply.body.decode("utf-8")) if reply.body else None
    except (UnicodeDecodeError, json.JSONDecodeError):
        decoded = None
    return reply.status, decoded


def unexpected(service: str, status: int) -> ServiceError:
    return ServiceError(f"{service} didn't answer as expected (HTTP {status}). Try again later.")
