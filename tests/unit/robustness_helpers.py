"""Shared checks of the fuzz and robustness suites of the web RPC (W8.4, W1.7 section 9).

One definition of a pass, used by every fuzz test:

- the reply is a well-formed envelope: ``ok`` true with ``result`` and ``events``, or ``ok``
  false with an ``error`` that has a W1.2 ``code``, a ``message`` and ``details``;
- the code is never ``INTERNAL``: dispatch turns any exception it did not expect into
  ``INTERNAL``, so that code is how a crash shows up here and it fails the test;
- the call returns within a bound (:func:`run_bounded`), so a hang fails instead of stalling.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Callable
from typing import Any, TypeVar

from pdfeditor.webapi.errors import ALL_CODES, INTERNAL

T = TypeVar("T")

# Generous for a CI runner: the fixtures take milliseconds, so only a real hang goes past this.
CASE_SECONDS = 10.0

_OK_KEYS = frozenset({"v", "id", "ok", "result", "events"})
_ERROR_KEYS = frozenset({"v", "id", "ok", "error"})
_CODES = frozenset(ALL_CODES) - {INTERNAL}


def check_reply(reply_json: str, label: str) -> dict[str, Any]:
    """Assert that ``reply_json`` is a well-formed envelope and return it parsed.

    ``label`` names the input (a fixture and mutation index, or the request), so a failure says
    how to reproduce it.
    """
    reply = json.loads(reply_json)
    assert isinstance(reply, dict), f"{label}: the reply is not an object: {reply!r}"
    assert "v" in reply and "id" in reply and "ok" in reply, f"{label}: envelope keys: {reply!r}"
    assert reply["id"] is None or type(reply["id"]) is int, f"{label}: bad id {reply['id']!r}"
    if reply["ok"] is True:
        assert set(reply) == _OK_KEYS, f"{label}: success keys {sorted(reply)}"
        assert isinstance(reply["result"], dict), f"{label}: result is not an object"
        assert isinstance(reply["events"], list), f"{label}: events is not a list"
        return reply
    assert reply["ok"] is False, f"{label}: ok is not a bool: {reply['ok']!r}"
    assert set(reply) == _ERROR_KEYS, f"{label}: failure keys {sorted(reply)}"
    error = reply["error"]
    assert isinstance(error, dict), f"{label}: error is not an object"
    assert set(error) == {"code", "message", "details"}, f"{label}: error keys {sorted(error)}"
    code = error["code"]
    assert code != INTERNAL, f"{label}: crash reported as INTERNAL: {error['message']}"
    assert code in _CODES, f"{label}: {code!r} is not a W1.2 error code"
    assert isinstance(error["message"], str) and error["message"], f"{label}: empty message"
    assert isinstance(error["details"], dict), f"{label}: details is not an object"
    return reply


def run_bounded(func: Callable[[], T], seconds: float = CASE_SECONDS) -> T:
    """Run ``func`` on a worker thread and return its value, or fail if it does not finish.

    A call that hangs keeps running on its daemon thread; the test fails and the process still
    exits. The engine lock stays held by that thread, so later cases in the same run fail too,
    which is the right outcome for a hang.
    """
    outcome: dict[str, Any] = {}

    def target() -> None:
        try:
            outcome["value"] = func()
        except BaseException as exc:  # re-raised below on the test's thread
            outcome["error"] = exc

    thread = threading.Thread(target=target, daemon=True)
    thread.start()
    thread.join(seconds)
    if thread.is_alive():
        raise AssertionError(f"no reply within {seconds} s: a hang")
    if "error" in outcome:
        raise outcome["error"]
    value: T = outcome["value"]
    return value
