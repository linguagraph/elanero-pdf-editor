"""The limit audit of W3.9 (W1.1 section 7, W1.2 section 4): every limit that applies to the
engine, tested at its boundary with the limit lowered, plus the guard that a refusal never leaves
a document open or a task running.

The limits are read from :mod:`pdfeditor.webapi.limits` at call time, so each test monkeypatches
the one it needs. Limits that are measured against the output (save, job result) are tested by
lowering the limit to the output's own size, so the boundary is exact.
"""

from __future__ import annotations

import json
import math
from collections.abc import Iterator
from typing import Any

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.webapi import dispatch, jobs, limits, session
from pdfeditor.webapi.errors import (
    BUSY,
    FILE_TOO_LARGE,
    INVALID_ARGS,
    OUT_OF_MEMORY,
    RENDER_TOO_LARGE,
    TOO_MANY_PAGES,
)
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY


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


def call_raw(
    method: str, params: dict[str, Any], buffers: list[bytes] | None = None
) -> tuple[dict[str, Any], list[bytes]]:
    request = json.dumps({"v": 1, "id": 7, "method": method, "params": params})
    reply_json, out = dispatch(request, buffers or [])
    return json.loads(reply_json), out


def call(method: str, params: dict[str, Any], buffers: list[bytes] | None = None) -> dict[str, Any]:
    reply, _ = call_raw(method, params, buffers)
    return reply


def ok(reply: dict[str, Any]) -> dict[str, Any]:
    assert reply["ok"] is True, reply
    result: dict[str, Any] = reply["result"]
    return result


def error(reply: dict[str, Any]) -> dict[str, Any]:
    assert reply["ok"] is False, reply
    err: dict[str, Any] = reply["error"]
    return err


def open_data(data: bytes, name: str = "doc.pdf") -> str:
    reply = call("session.open", {"name": name, "data": {"$bin": 0}, "password": None}, [data])
    return str(ok(reply)["handle"])


def open_fixture(fixture_pdf: Any, name: str) -> str:
    return open_data(fixture_pdf(name).read_bytes(), f"{name}.pdf")


def page_size(handle: str, page: int = 0) -> tuple[float, float]:
    size = ok(call("session.pages", {"handle": handle}))["pages"][page]
    return float(size["width"]), float(size["height"])


def revision(handle: str, page: int = 0) -> int:
    # A revision that cannot match: no pixels come back, and the reply names the current one.
    reply = call(
        "render.page",
        {
            "handle": handle,
            "page": page,
            "revision": -1,
            "scale_milli": 1000,
            "rotation": 0,
            "annotations": False,
        },
    )
    return int(ok(reply)["revision"])


def render_pixels(handle: str, scale_milli: int) -> int:
    width, height = page_size(handle)
    return math.ceil(width * scale_milli / 1000) * math.ceil(height * scale_milli / 1000)


def render(handle: str, scale_milli: int) -> dict[str, Any]:
    return call(
        "render.page",
        {
            "handle": handle,
            "page": 0,
            "revision": revision(handle),
            "scale_milli": scale_milli,
            "rotation": 0,
            "annotations": False,
        },
    )


def search(handle: str, query: str, **overrides: Any) -> dict[str, Any]:
    params: dict[str, Any] = {
        "handle": handle,
        "query": query,
        "options": {"case_sensitive": False, "whole_word": False, "regex": False},
        "start_page": 0,
        "cursor": None,
        "budget_ms": 1000,
    }
    params.update(overrides)
    return call("text.search", params)


def save(handle: str, mode: str) -> tuple[dict[str, Any], list[bytes]]:
    return call_raw("save.save_bytes", {"handle": handle, "mode": mode})


def sanitize(handle: str) -> dict[str, Any]:
    return {"handle": handle, "job": "action", "args": {"name": "document.sanitize", "args": {}}}


# -- file size and pages (session.open) -------------------------------------------------------


def test_a_refused_open_leaves_no_document_open(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    data = fixture_pdf("text_multipage").read_bytes()
    monkeypatch.setattr(limits, "MAX_PAGES", 1)
    reply = call("session.open", {"name": "a.pdf", "data": {"$bin": 0}, "password": None}, [data])
    assert error(reply)["code"] == TOO_MANY_PAGES
    assert len(REGISTRY) == 0


def test_a_memory_error_while_opening_leaves_no_document_open(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Any failure after the engine opened the file must close it again (W3.9 guard).
    def out_of_memory(*_args: object, **_kwargs: object) -> None:
        raise MemoryError

    monkeypatch.setattr(session, "_info", out_of_memory)
    data = fixture_pdf("text_multipage").read_bytes()
    reply = call("session.open", {"name": "a.pdf", "data": {"$bin": 0}, "password": None}, [data])
    assert error(reply)["code"] == OUT_OF_MEMORY
    assert len(REGISTRY) == 0


def test_the_page_limit_is_inclusive(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    data = fixture_pdf("text_multipage").read_bytes()
    pages = ok(
        call("session.open", {"name": "a.pdf", "data": {"$bin": 0}, "password": None}, [data])
    )["pages"]
    REGISTRY.close_all()
    monkeypatch.setattr(limits, "MAX_PAGES", pages)
    assert (
        ok(call("session.open", {"name": "a.pdf", "data": {"$bin": 0}, "password": None}, [data]))[
            "pages"
        ]
        == pages
    )
    REGISTRY.close_all()
    monkeypatch.setattr(limits, "MAX_PAGES", pages - 1)
    reply = call("session.open", {"name": "a.pdf", "data": {"$bin": 0}, "password": None}, [data])
    assert error(reply)["details"] == {"max_pages": pages - 1, "pages": pages}


# -- render size and scale (render.page) ------------------------------------------------------


def test_the_scale_limit_is_inclusive(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle = open_fixture(fixture_pdf, "text_multipage")
    monkeypatch.setattr(limits, "MAX_RENDER_SCALE_MILLI", 1000)
    monkeypatch.setattr(limits, "MAX_RENDER_PIXELS", 10**12)
    assert "error" not in render(handle, 1000)
    assert error(render(handle, 1001))["code"] == RENDER_TOO_LARGE


def test_the_pixel_limit_is_inclusive(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle = open_fixture(fixture_pdf, "text_multipage")
    pixels = render_pixels(handle, 1000)
    monkeypatch.setattr(limits, "MAX_RENDER_PIXELS", pixels)
    assert ok(render(handle, 1000))["width"] > 0
    monkeypatch.setattr(limits, "MAX_RENDER_PIXELS", pixels - 1)
    err = error(render(handle, 1000))
    assert err["code"] == RENDER_TOO_LARGE
    assert err["details"] == {"max_pixels": pixels - 1, "pixels": pixels}


def test_a_refused_render_draws_nothing_and_the_document_stays_usable(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle = open_fixture(fixture_pdf, "text_multipage")
    monkeypatch.setattr(limits, "MAX_RENDER_PIXELS", 1)
    reply, out = call_raw(
        "render.page",
        {
            "handle": handle,
            "page": 0,
            "revision": revision(handle),
            "scale_milli": 1000,
            "rotation": 0,
            "annotations": False,
        },
    )
    assert error(reply)["code"] == RENDER_TOO_LARGE
    assert out == []
    monkeypatch.undo()
    assert ok(render(handle, 1000))["width"] > 0


# -- text query size and hits (text.search) ---------------------------------------------------


def test_the_query_limit_is_inclusive(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle = open_fixture(fixture_pdf, "text_multipage")
    monkeypatch.setattr(limits, "MAX_QUERY_CHARS", 6)
    ok(search(handle, "needle"))  # exactly 6 characters
    err = error(search(handle, "needles"))  # 7
    assert err["code"] == INVALID_ARGS
    assert err["details"] == {"path": "params.query", "max_chars": 6}


def test_a_search_stops_at_the_hit_limit_and_names_the_next_slice(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle = open_fixture(fixture_pdf, "text_multipage")
    monkeypatch.setattr(limits, "MAX_HITS_PER_REPLY", 1)
    result = ok(search(handle, "needle"))
    assert len(result["hits"]) == 1
    assert result["done"] is False
    assert result["cursor"] is not None  # the caller asks for the next slice; nothing is refused


# -- save size (save.save_bytes) --------------------------------------------------------------


def test_the_save_limit_is_inclusive(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Two saves of the same document are not byte-stable (W3.6), so the size is read back from
    # the refusal itself rather than assumed from an earlier save.
    handle = open_fixture(fixture_pdf, "text_multipage")
    monkeypatch.setattr(limits, "MAX_SAVE_BYTES", 1)
    err = error(save(handle, "copy")[0])
    assert err["code"] == FILE_TOO_LARGE
    size = err["details"]["size"]
    assert err["details"] == {"max_bytes": 1, "size": size}
    monkeypatch.setattr(limits, "MAX_SAVE_BYTES", size - 1)
    err = error(save(handle, "copy")[0])
    assert err["code"] == FILE_TOO_LARGE
    assert err["details"]["max_bytes"] == size - 1
    monkeypatch.setattr(limits, "MAX_SAVE_BYTES", err["details"]["size"])
    reply, out = save(handle, "copy")
    assert ok(reply)["size"] == len(out[0])
    assert len(out) == 1


# -- job bytes (jobs.prepare and jobs.apply) --------------------------------------------------


def test_the_job_limit_is_inclusive_at_prepare(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle = open_fixture(fixture_pdf, "images")
    reply, out = call_raw(
        "jobs.prepare", {"handle": handle, "job": "reduce_size", "args": {"preset": "ebook"}}
    )
    size = len(out[ok(reply)["document"]["$bin"]])
    jobs.PREPARED.clear()
    monkeypatch.setattr(limits, "MAX_JOB_BYTES", size)
    assert "token" in ok(
        call("jobs.prepare", {"handle": handle, "job": "reduce_size", "args": {"preset": "ebook"}})
    )
    jobs.PREPARED.clear()
    monkeypatch.setattr(limits, "MAX_JOB_BYTES", size - 1)
    err = error(
        call("jobs.prepare", {"handle": handle, "job": "reduce_size", "args": {"preset": "ebook"}})
    )
    assert err["code"] == FILE_TOO_LARGE
    assert err["details"] == {"max_bytes": size - 1, "size": size}


def test_a_job_result_over_the_limit_is_refused_and_nothing_is_applied(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle = open_fixture(fixture_pdf, "images")
    prepared = ok(call("jobs.prepare", sanitize(handle)))
    monkeypatch.setattr(limits, "MAX_JOB_BYTES", 100)
    result = b"x" * 101
    reply = call(
        "jobs.apply",
        {
            "handle": handle,
            "token": prepared["token"],
            "document": {"$bin": 0},
            "label": "Sanitize Document",
            "require_full_save": False,
        },
        [result],
    )
    err = error(reply)
    assert err["code"] == FILE_TOO_LARGE
    assert err["details"] == {"max_bytes": 100, "size": 101}
    doc_session = REGISTRY.get(handle)
    assert doc_session.busy == "document.sanitize"  # still prepared, not applied
    assert ok(call("jobs.abort", {"handle": handle, "token": prepared["token"]})) == {}
    assert doc_session.busy == ""


# -- out of memory --------------------------------------------------------------------------


def test_a_memory_error_in_a_call_is_out_of_memory_and_the_document_stays_open(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle = open_fixture(fixture_pdf, "text_multipage")

    def out_of_memory(*_args: object, **_kwargs: object) -> None:
        raise MemoryError

    monkeypatch.setattr(session, "_info", out_of_memory)
    err = error(call("session.info", {"handle": handle}))
    assert err["code"] == OUT_OF_MEMORY
    assert handle in REGISTRY


def test_a_busy_refusal_names_the_task_and_is_not_a_limit(web: None, fixture_pdf: Any) -> None:
    handle = open_fixture(fixture_pdf, "images")
    ok(call("jobs.prepare", sanitize(handle)))
    err = error(call("save.save_bytes", {"handle": handle, "mode": "copy"}))
    assert err["code"] == BUSY
    assert err["details"] == {"task": "document.sanitize"}
