"""The translation transport on the web: the browser's XMLHttpRequest, synchronous.

Pyodide runs Python in a worker, and the worker can call XMLHttpRequest synchronously, so the
existing clients need no change (plan W2.4). This module imports ``js`` only inside
``make_xhr_opener``, so importing it on the desktop is harmless.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from pdfeditor.services.translation.http import Opener, Reply, Request

log = logging.getLogger(__name__)

# The origins the browser may call directly (W0.3: CORS allowed for each). The clients'
# default hosts must be in this set; the tests check that. LibreTranslate has no default host
# in code (the user names the server), so this list is the source of truth for it. The web
# app's Content-Security-Policy connect-src must match this set (W3 checks it).
WEB_ENDPOINT_ORIGINS: frozenset[str] = frozenset(
    {
        "https://api.mymemory.translated.net",
        "https://api.cognitive.microsofttranslator.com",
        "https://libretranslate.com",
    }
)

# Headers a browser refuses to set (User-Agent is forbidden) or sets itself.
_SKIPPED_HEADERS = frozenset({"user-agent", "accept-encoding", "content-length"})


def make_xhr_opener(factory: Callable[[], Any] | None = None) -> Opener:
    """An opener that sends each request with a synchronous XMLHttpRequest.
    ``factory`` makes one request object per call: the browser's, or the engine worker's gated
    wrapper (W6.6), which has the same methods and properties.
    """
    if factory is None:
        from js import XMLHttpRequest  # the browser's API; only exists inside Pyodide

        factory = XMLHttpRequest.new

    def opener(request: Request, timeout: float) -> Reply:
        # Pyodide does not convert bytes to a JS value; XHR needs a string here. Every body we
        # send is JSON in UTF-8, so the decode is lossless. A non-UTF-8 body raises, by design.
        text_body = None if request.data is None else request.data.decode("utf-8")
        try:
            # Inside the try: an unarmed gate (W6.6) or a missing XMLHttpRequest raises a JS
            # exception here, and it must surface as the same OSError as any other failure.
            xhr = factory()
            xhr.open(request.method, request.url, False)
            # The timeout works because this runs in a worker: synchronous XHR throws when a
            # timeout is set on the main thread, so there every call would fail with OSError.
            # A JS exception here is a failure to reach the service, so it maps to OSError.
            xhr.timeout = int(timeout * 1000)
            xhr.withCredentials = False
            for name, value in request.headers.items():
                if name.lower() not in _SKIPPED_HEADERS:
                    xhr.setRequestHeader(name, value)
            if text_body is None:
                xhr.send()
            else:
                xhr.send(text_body)
        except Exception as exc:
            log.info("web translation request failed: %s", type(exc).__name__)
            raise OSError("network request failed") from exc
        status = int(xhr.status)
        if status == 0:  # no response: network failure, CORS refusal or timeout
            log.info("web translation request got no response")
            raise OSError("network request failed")
        log.info("web translation reply: HTTP %d", status)
        text = str(xhr.responseText or "")
        return Reply(status, text.encode("utf-8"))

    return opener
