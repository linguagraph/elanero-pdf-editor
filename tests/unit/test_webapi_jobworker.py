"""The job worker's own entry point (W3.7, W1.2 section 13): ``hello`` and ``job.run`` through
:func:`pdfeditor.webapi.jobworker.dispatch`, the table the browser's job worker answers with.

The copy a job runs on comes from the engine's ``jobs.prepare``, as in the browser. Progress
notices are checked here as the adapter sends them (W1.2 section 8). The job's result is opened
in pikepdf and pypdfium2 through ``tests.hostcheck.record``, so this module imports neither at
module level.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.webapi import dispatch as engine_dispatch
from pdfeditor.webapi import jobs, jobworker
from pdfeditor.webapi.errors import INVALID_REQUEST
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.hostcheck import record


@pytest.fixture
def web() -> Iterator[None]:
    previous = model_platform.current()
    configure_web()
    try:
        yield
    finally:
        jobs.PREPARED.clear()
        REGISTRY.close_all()
        model_platform.configure(previous)


def engine_call(
    method: str, params: dict[str, Any], buffers: list[bytes]
) -> tuple[dict[str, Any], list[bytes]]:
    request = json.dumps({"v": 1, "id": 3, "method": method, "params": params})
    reply_json, out = engine_dispatch(request, buffers)
    reply: dict[str, Any] = json.loads(reply_json)
    assert reply["ok"] is True, reply
    result: dict[str, Any] = reply["result"]
    return result, out


def job_call(
    request: dict[str, Any], buffers: list[bytes], notices: list[dict[str, Any]] | None = None
) -> tuple[dict[str, Any], list[bytes]]:
    """The job worker's reply and buffers, the way the adapter gives them over."""
    sink = notices if notices is not None else []
    reply_json, out = jobworker.dispatch(json.dumps(request), buffers, sink.append)
    reply: dict[str, Any] = json.loads(reply_json)
    return reply, out


def test_hello_answers_the_protocol_so_the_loader_starts(web: None) -> None:
    reply, out = job_call({"v": 1, "id": 1, "method": "hello", "params": {}}, [])
    assert reply["ok"] is True
    assert reply["result"]["protocol"] == 1
    assert out == []


def test_job_run_split_returns_the_files_and_its_progress(web: None, fixture_pdf: Any) -> None:
    args = {"mode": "pages", "pages_per_file": 1}
    opened, _ = engine_call(
        "session.open",
        {"name": "text.pdf", "data": {"$bin": 0}, "password": None},
        [fixture_pdf("text_multipage").read_bytes()],
    )
    prepared, engine_out = engine_call(
        "jobs.prepare", {"handle": opened["handle"], "job": "split", "args": args}, []
    )
    copy = engine_out[prepared["document"]["$bin"]]

    notices: list[dict[str, Any]] = []
    reply, out = job_call(
        {
            "v": 1,
            "id": 5,
            "method": "job.run",
            "params": {"job": "split", "args": args, "document": {"$bin": 0}},
        },
        [copy],
        notices,
    )
    assert reply["ok"] is True, reply
    result = reply["result"]
    assert result["kind"] == "files"
    assert len(result["files"]) >= 1
    # Every notice is a W1.2 progress notice for this request, and the last one reports the end.
    assert notices, "a split reports progress"
    assert all(notice["notice"] == "progress" and notice["id"] == 5 for notice in notices)
    last = notices[-1]["data"]
    assert last["total"] > 0 and last["done"] == last["total"]
    assert len(out) == len(result["files"])
    record("page_count_pikepdf", out[0], pages=1)


def test_job_run_refuses_an_engine_method(web: None) -> None:
    reply, _ = job_call({"v": 1, "id": 2, "method": "session.open", "params": {}}, [])
    assert reply["ok"] is False
    assert reply["error"]["code"] == INVALID_REQUEST
