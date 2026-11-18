"""The browser RPC facade (W3.2): one entry point, :func:`dispatch`, that the worker's JS calls.

It is plain Python with no JS imports, so the host CPython runs it in the tests. Requests and
replies are JSON strings; the bytes they carry travel as a parallel list of buffers. Nothing here
raises into the caller: every failure becomes a reply with an error code (W1.2 section 4).
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from pdfeditor.webapi import dto
from pdfeditor.webapi.dto import PROTOCOL_VERSION, BufferTable, from_json, to_json
from pdfeditor.webapi.errors import INVALID_REQUEST, PROTOCOL_MISMATCH, RpcFailure, failure_for

log = logging.getLogger(__name__)

ENGINE_NAME = "mupdf"
PLATFORM_NAME = "web"
_ENVELOPE_KEYS = frozenset({"v", "id", "method", "params"})


@dataclass(frozen=True, slots=True)
class Method:
    params: type
    handler: Callable[..., object]


def _hello(params: dto.Empty) -> dto.HelloResult:
    return dto.HelloResult(protocol=PROTOCOL_VERSION, engine=ENGINE_NAME, platform=PLATFORM_NAME)


METHODS: dict[str, Method] = {
    "hello": Method(dto.Empty, _hello),
}


def dispatch(request_json: str, buffers: list[bytes]) -> tuple[str, list[bytes]]:
    """Handle one request. Returns the reply JSON and the reply's buffers, in ``$bin`` order.

    Never raises: a malformed envelope, an unknown method, bad arguments, a document error or a
    bug all come back as a failure reply (``"ok": false`` with ``error``).
    """
    request_id: object = None
    try:
        data = _load(request_json)
        if isinstance(data, dict) and isinstance(data.get("id"), str):
            request_id = data["id"]  # echoed even in a failure about the rest of the envelope
        reply, out = _run(data, buffers)
    except Exception as exc:  # every failure becomes a reply; the worker must not die of one
        failure = failure_for(exc)
        reply = {
            "v": PROTOCOL_VERSION,
            "id": request_id,
            "ok": False,
            "error": {"code": failure.code, "message": failure.message, "details": failure.details},
        }
        out = []
    return json.dumps(reply, allow_nan=False, separators=(",", ":")), out


def _load(request_json: str) -> object:
    try:
        return json.loads(request_json, parse_constant=_reject_constant)
    except ValueError as exc:
        raise RpcFailure(INVALID_REQUEST, "the request is not valid JSON") from exc


def _reject_constant(name: str) -> object:
    raise ValueError(f"{name} is not allowed in JSON")


def _run(data: object, buffers: list[bytes]) -> tuple[dict[str, object], list[bytes]]:
    if not isinstance(data, dict) or set(data) != _ENVELOPE_KEYS:
        raise RpcFailure(INVALID_REQUEST, "the request needs exactly v, id, method and params")
    version = data["v"]
    if type(version) is not int or version != PROTOCOL_VERSION:
        raise RpcFailure(
            PROTOCOL_MISMATCH,
            f"the request uses protocol {version!r}; this worker speaks {PROTOCOL_VERSION}",
        )
    request_id = data["id"]
    method_name = data["method"]
    params = data["params"]
    if not isinstance(request_id, str) or not isinstance(method_name, str):
        raise RpcFailure(INVALID_REQUEST, "id and method must be strings")
    if not isinstance(params, dict):
        raise RpcFailure(INVALID_REQUEST, "params must be an object")
    method = METHODS.get(method_name)
    if method is None:
        raise RpcFailure(INVALID_REQUEST, "unknown method")

    table = BufferTable(buffers)
    typed: Any = from_json(method.params, params, table, "params")
    table.check_all_used()
    result = method.handler(typed)

    out: list[bytes] = []
    reply: dict[str, object] = {
        "v": PROTOCOL_VERSION,
        "id": request_id,
        "ok": True,
        "result": to_json(result, out),
    }
    return reply, out
