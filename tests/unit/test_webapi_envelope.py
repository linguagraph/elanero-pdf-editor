"""The request and reply envelope of the web RPC (W1.2 sections 2 and 5): round trips, the version
check, unknown methods, malformed input and the $bin buffers. Host CPython, no browser."""

from __future__ import annotations

import json
from dataclasses import dataclass

import pytest

from pdfeditor.webapi import METHODS, Method, dispatch
from pdfeditor.webapi.errors import INTERNAL, INVALID_ARGS, INVALID_REQUEST, PROTOCOL_MISMATCH


@dataclass(frozen=True, slots=True)
class EchoParams:
    name: str
    data: bytes


@dataclass(frozen=True, slots=True)
class EchoResult:
    size: int
    data: bytes


@dataclass(frozen=True, slots=True)
class TwoBuffers:
    first: bytes
    second: bytes


def _echo(params: EchoParams) -> EchoResult:
    return EchoResult(size=len(params.data), data=params.data)


@pytest.fixture
def echo(monkeypatch: pytest.MonkeyPatch) -> None:
    """Test-only methods, registered for one test; the real table is left as it was."""
    monkeypatch.setitem(METHODS, "echo", Method(EchoParams, _echo))
    monkeypatch.setitem(METHODS, "two", Method(TwoBuffers, lambda p: p))


def _request(method: str, params: object, *, request_id: str = "7", version: object = 1) -> str:
    return json.dumps({"v": version, "id": request_id, "method": method, "params": params})


def _reply(request: str, buffers: list[bytes] | None = None) -> tuple[dict, list[bytes]]:
    reply_json, out = dispatch(request, buffers or [])
    return json.loads(reply_json), out


def test_hello_round_trip() -> None:
    reply, out = _reply(_request("hello", {}))
    assert reply == {
        "v": 1,
        "id": "7",
        "ok": True,
        "result": {"protocol": 1, "engine": "mupdf", "platform": "web"},
    }
    assert out == []


def test_reply_echoes_the_request_id() -> None:
    reply, _ = _reply(_request("hello", {}, request_id="abc-42"))
    assert reply["id"] == "abc-42"


def test_bytes_round_trip_through_buffers(echo: None) -> None:
    request = _request("echo", {"name": "a.pdf", "data": {"$bin": 0}})
    reply, out = _reply(request, [b"%PDF-1.7"])
    assert reply["ok"] is True
    assert reply["result"] == {"size": 8, "data": {"$bin": 0}}
    assert out == [b"%PDF-1.7"]


def test_unreferenced_buffer_is_invalid_args(echo: None) -> None:
    reply, _ = _reply(_request("echo", {"name": "a", "data": {"$bin": 0}}), [b"x", b"unused"])
    assert reply["error"]["code"] == INVALID_ARGS
    assert reply["error"]["details"] == {"path": "buffers[1]"}


def test_reused_buffer_index_is_invalid_args(echo: None) -> None:
    reply, _ = _reply(_request("two", {"first": {"$bin": 0}, "second": {"$bin": 0}}), [b"same"])
    assert reply["error"]["code"] == INVALID_ARGS
    assert reply["error"]["details"] == {"path": "params.second"}


def test_missing_buffer_index_is_invalid_args(echo: None) -> None:
    reply, _ = _reply(_request("echo", {"name": "a", "data": {"$bin": 3}}), [b"x"])
    assert reply["error"]["code"] == INVALID_ARGS
    assert reply["error"]["details"] == {"path": "params.data"}


def test_unknown_method_is_invalid_request() -> None:
    reply, _ = _reply(_request("no.such.call", {}))
    assert reply["ok"] is False
    assert reply["error"]["code"] == INVALID_REQUEST


def test_wrong_version_is_protocol_mismatch_and_keeps_the_id() -> None:
    reply, _ = _reply(_request("hello", {}, version=2))
    assert reply["id"] == "7"
    assert reply["error"]["code"] == PROTOCOL_MISMATCH


@pytest.mark.parametrize("version", ["1", 1.0, True, None])
def test_version_must_be_an_integer(version: object) -> None:
    reply, _ = _reply(_request("hello", {}, version=version))
    assert reply["error"]["code"] == PROTOCOL_MISMATCH


@pytest.mark.parametrize(
    "raw",
    [
        "not json",
        "[]",
        json.dumps({"v": 1, "id": "1", "method": "hello"}),  # no params
        json.dumps({"v": 1, "id": "1", "method": "hello", "params": {}, "extra": 1}),
        json.dumps({"v": 1, "id": 1, "method": "hello", "params": {}}),  # id must be a string
        json.dumps({"v": 1, "id": "1", "method": "hello", "params": []}),
        '{"v": 1, "id": "1", "method": "hello", "params": {"x": NaN}}',
    ],
)
def test_malformed_envelope_is_invalid_request(raw: str) -> None:
    reply_json, out = dispatch(raw, [])
    reply = json.loads(reply_json)
    assert reply["ok"] is False
    assert reply["error"]["code"] == INVALID_REQUEST
    assert out == []


def test_a_crashing_handler_becomes_internal_without_a_traceback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def boom(params: EchoParams) -> EchoResult:
        raise RuntimeError("secret internal detail")

    monkeypatch.setitem(METHODS, "boom", Method(EchoParams, boom))
    reply_json, out = dispatch(_request("boom", {"name": "a", "data": {"$bin": 0}}), [b"x"])
    reply = json.loads(reply_json)
    assert reply["error"]["code"] == INTERNAL
    assert "Traceback" not in reply_json
    assert "secret internal detail" not in reply_json
    assert out == []
