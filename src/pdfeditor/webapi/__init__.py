"""The browser RPC facade (W3.2): one entry point, :func:`dispatch`, that the worker's JS calls.

It is plain Python with no JS imports, so the host CPython runs it in the tests. Requests and
replies are JSON strings; the bytes they carry travel as a parallel list of buffers. Nothing here
raises into the caller: every failure becomes a reply with an error code (W1.2 section 4).
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from pdfeditor.webapi import actions, dto, jobs, render, save, session, text
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
    # True when the handler also gets the call's buffer table, because it converts part of its
    # params itself (actions.run). Such a handler runs before the unused-buffer check.
    takes_buffers: bool = False


def _hello(params: dto.Empty) -> dto.HelloResult:
    return dto.HelloResult(protocol=PROTOCOL_VERSION, engine=ENGINE_NAME, platform=PLATFORM_NAME)


METHODS: dict[str, Method] = {
    "hello": Method(dto.Empty, _hello),
    "session.open": Method(dto.OpenParams, session.open_document),
    "session.close": Method(dto.HandleParams, session.close_document),
    "session.info": Method(dto.HandleParams, session.document_info),
    "session.pages": Method(dto.HandleParams, session.document_pages),
    "session.capabilities": Method(dto.HandleParams, session.document_capabilities),
    "session.unlock_owner": Method(dto.UnlockParams, session.unlock_owner),
    "text.layer": Method(dto.PageParams, text.text_layer),
    "text.extract": Method(dto.ExtractParams, text.extract),
    "text.search": Method(dto.SearchParams, text.search),
    "render.page": Method(dto.RenderPageParams, render.render_page),
    "actions.run": Method(dto.RunParams, actions.run_action, takes_buffers=True),
    "actions.undo": Method(dto.HandleParams, actions.undo),
    "actions.redo": Method(dto.HandleParams, actions.redo),
    "actions.available": Method(dto.HandleParams, actions.available),
    "save.save_bytes": Method(dto.SaveParams, save.save_bytes),
    "jobs.prepare": Method(dto.JobPrepareParams, jobs.prepare, takes_buffers=True),
    "jobs.apply": Method(dto.JobApplyParams, jobs.apply),
    "jobs.abort": Method(dto.JobAbortParams, jobs.abort),
}


def dispatch(
    request_json: str, buffers: list[bytes], methods: Mapping[str, Method] = METHODS
) -> tuple[str, list[bytes]]:
    """Handle one request. Returns the reply JSON and the reply's buffers, in ``$bin`` order.

    ``methods`` is the table of this worker: the engine's by default, the job worker's own in
    :mod:`pdfeditor.webapi.jobworker`.

    Never raises: a malformed envelope, an unknown method, bad arguments, a document error or a
    bug all come back as a failure reply (``"ok": false`` with ``error``).
    """
    request_id: object = None
    try:
        data = _load(request_json)
        if isinstance(data, dict) and _is_id(data.get("id")):
            request_id = data["id"]  # echoed even in a failure about the rest of the envelope
        reply, out = _run(data, buffers, methods)
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


def _is_id(value: object) -> bool:
    # An integer within the JSON-safe range (W1.2 section 6); bool is an int subclass, so it is
    # excluded by type.
    return type(value) is int and abs(value) <= dto.MAX_SAFE_INT


def _reject_constant(name: str) -> object:
    raise ValueError(f"{name} is not allowed in JSON")


def _run(
    data: object, buffers: list[bytes], methods: Mapping[str, Method]
) -> tuple[dict[str, object], list[bytes]]:
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
    if not _is_id(request_id) or not isinstance(method_name, str):
        raise RpcFailure(INVALID_REQUEST, "id must be an integer and method a string")
    if not isinstance(params, dict):
        raise RpcFailure(INVALID_REQUEST, "params must be an object")
    method = methods.get(method_name)
    if method is None:
        raise RpcFailure(INVALID_REQUEST, "unknown method")

    table = BufferTable(buffers)
    typed: Any = from_json(method.params, params, table, "params")
    if method.takes_buffers:
        result = method.handler(typed, table)
        table.check_all_used()
    else:
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
