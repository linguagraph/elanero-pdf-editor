"""The translation transport on the web: the browser's XMLHttpRequest, synchronous.

Pyodide runs Python in a worker, and the worker can call XMLHttpRequest synchronously, so the
existing clients need no change (plan W2.4). This module imports ``js`` only inside
``make_xhr_opener``, so importing it on the desktop is harmless.
"""

from __future__ import annotations

import logging

from pdfeditor.services.translation.http import Opener, Reply, Request

log = logging.getLogger(__name__)

# The origins the browser may call directly (W0.3: CORS allowed for each). The clients'
# default hosts must be in this set; the tests check that. LibreTranslate has no default host
# in code (the user names the server), so this list is the source of truth for it.
WEB_ENDPOINT_ORIGINS: frozenset[str] = frozenset(
    {
        "https://api.mymemory.translated.net",
        "https://api.cognitive.microsofttranslator.com",
        "https://libretranslate.com",
    }
)

# Headers a browser refuses to set (User-Agent is forbidden) or sets itself.
_SKIPPED_HEADERS = frozenset({"user-agent", "accept-encoding", "content-length"})


def make_xhr_opener() -> Opener:
    """An opener that sends each request with the browser's synchronous XMLHttpRequest."""
    from js import XMLHttpRequest  # the browser's API; only exists inside Pyodide

    def opener(request: Request, timeout: float) -> Reply:
        xhr = XMLHttpRequest.new()
        try:
            xhr.open(request.method, request.url, False)
            # Synchronous XHR in a worker accepts a timeout; a JS exception here is a failure
            # to reach the service, so it maps to OSError like the rest of the network calls.
            xhr.timeout = int(timeout * 1000)
            xhr.withCredentials = False
            for name, value in request.headers.items():
                if name.lower() not in _SKIPPED_HEADERS:
                    xhr.setRequestHeader(name, value)
            if request.data is None:
                xhr.send()
            else:
                xhr.send(request.data)
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
