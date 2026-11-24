"""The request depth scan (W8.6 F13): a request nested deeper than ``limits.MAX_JSON_DEPTH`` is
refused before the JSON decoder recurses into it.

``_check_depth`` reads the limit at call time, so each test lowers it with monkeypatch. Without the
scan, the deep request would parse and fail later as an unknown field, so these assertions fail if
the scan is removed, on host CPython as well as under Pyodide.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.webapi import dispatch, limits
from pdfeditor.webapi.errors import INVALID_ARGS, INVALID_REQUEST
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY

REFUSAL = "the request is nested too deeply"


@pytest.fixture
def web() -> Iterator[None]:
    previous = model_platform.current()
    configure_web()
    try:
        yield
    finally:
        REGISTRY.close_all()
        model_platform.configure(previous)


def _request(levels: int) -> str:
    # The envelope is 2 levels deep (the request object and params), so the arg adds `levels`.
    return '{"v":1,"id":1,"method":"hello","params":{"x":' + "[" * levels + "]" * levels + "}}"


def test_request_over_the_lowered_limit_is_refused(
    web: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(limits, "MAX_JSON_DEPTH", 5)
    reply_json, _ = dispatch(_request(4), [])  # 2 + 4 = 6 levels, one over the limit
    assert '"ok":false' in reply_json, reply_json
    assert REFUSAL in reply_json, reply_json
    assert '"code":"' + INVALID_REQUEST + '"' in reply_json, reply_json


def test_request_at_the_lowered_limit_is_parsed(web: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(limits, "MAX_JSON_DEPTH", 5)
    reply_json, _ = dispatch(_request(3), [])  # 2 + 3 = 5 levels, exactly the limit
    assert REFUSAL not in reply_json, reply_json
    assert '"code":"' + INVALID_ARGS + '"' in reply_json, reply_json
    assert "params.x: unknown field" in reply_json, reply_json


def test_brackets_inside_strings_do_not_count(web: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(limits, "MAX_JSON_DEPTH", 3)
    # Twenty opening brackets inside a string are data, not nesting, so the scan lets it through.
    text = '{"v":1,"id":1,"method":"hello","params":{"x":"' + "[" * 20 + '"}}'
    reply_json, _ = dispatch(text, [])
    assert REFUSAL not in reply_json, reply_json
    assert "params.x: unknown field" in reply_json, reply_json


def test_escaped_quote_inside_a_string_does_not_end_it(
    web: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(limits, "MAX_JSON_DEPTH", 3)
    # JSON text `"\"[[[[[["`: the escaped quote keeps the string open, so the brackets are data.
    # Without the escape pair in the scanner, the quote would close the string and the brackets
    # would count as nesting, so the request would be refused.
    text = '{"v":1,"id":1,"method":"hello","params":{"x":"\\"' + "[" * 6 + '"}}'
    reply_json, _ = dispatch(text, [])
    assert REFUSAL not in reply_json, reply_json
    assert '"code":"' + INVALID_ARGS + '"' in reply_json, reply_json
    assert "params.x: unknown field" in reply_json, reply_json


def test_escaped_backslash_then_real_nesting_is_refused(
    web: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(limits, "MAX_JSON_DEPTH", 5)
    # JSON text `"\\"` closes its string after the escaped backslash, so the arrays after it are
    # nesting: 2 envelope levels + 4 = 6, one over the limit.
    text = '{"v":1,"id":1,"method":"hello","params":{"s":"\\\\","x":[[[[]]]]}}'
    reply_json, _ = dispatch(text, [])
    assert '"ok":false' in reply_json, reply_json
    assert REFUSAL in reply_json, reply_json
    assert '"code":"' + INVALID_REQUEST + '"' in reply_json, reply_json
