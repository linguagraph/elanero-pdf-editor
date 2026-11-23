"""The jobs calls of W3.7 (W1.2 section 13): ``jobs.prepare``, ``job.run`` (the job worker's
entry point) and ``jobs.apply`` / ``jobs.abort``, through dispatch, on fixtures.

The job worker runs in the same process here. A cancel is set from a progress notice, because
the worker runs synchronously and only a callback on its own thread can reach the token. The
saved file of a mutated document is checked in pikepdf and pypdfium2 through
``tests.hostcheck.record``, as in test_webapi_save.py, so this module imports neither at module
level.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import pytest

from pdfeditor.core.jobs import CancelToken
from pdfeditor.engine.base import EngineError
from pdfeditor.engine.registry import get_engine
from pdfeditor.model import platform as model_platform
from pdfeditor.webapi import dispatch, jobs, jobworker, limits
from pdfeditor.webapi.errors import (
    BUSY,
    CANCELLED,
    FILE_TOO_LARGE,
    INVALID_ARGS,
    NO_DOCUMENT,
    REFUSED,
    STALE_JOB,
    STALE_OBJECT,
)
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.hostcheck import record

SANITIZE = "document.sanitize"
SANITIZE_LABEL = "Sanitize Document"
UNKNOWN_TOKEN = "0" * 32


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
    request = json.dumps({"v": 1, "id": 11, "method": method, "params": params})
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


def binary(value: dict[str, Any], out: list[bytes]) -> bytes:
    """The bytes a ``$bin`` marker of a reply refers to."""
    assert set(value) == {"$bin"}
    return out[value["$bin"]]


def open_data(data: bytes, name: str = "doc.pdf", password: str | None = None) -> str:
    reply, _ = call_raw(
        "session.open", {"name": name, "data": {"$bin": 0}, "password": password}, [data]
    )
    return str(ok(reply)["handle"])


def prepare(handle: str, job: str, args: dict[str, Any]) -> tuple[dict[str, Any], bytes]:
    """The result of jobs.prepare, and the document copy it returned."""
    reply, out = call_raw("jobs.prepare", {"handle": handle, "job": job, "args": args})
    result = ok(reply)
    return result, binary(result["document"], out)


def run_job(
    job: str,
    args: dict[str, Any],
    document: bytes,
    *,
    notify: Any = None,
    cancel: CancelToken | None = None,
) -> tuple[dict[str, Any], list[bytes]]:
    """The job worker's reply to job.run, called directly in this process."""
    request = json.dumps(
        {
            "v": 1,
            "id": 5,
            "method": "job.run",
            "params": {
                "job": job,
                "args": args,
                "document": {"$bin": 0},
            },
        }
    )
    reply_json, out = jobworker.dispatch(request, [document], notify, cancel)
    reply: dict[str, Any] = json.loads(reply_json)
    return reply, out


def apply(
    handle: str,
    token: str,
    document: bytes | None = None,
    label: str = "",
    require_full_save: bool = False,
) -> dict[str, Any]:
    params: dict[str, Any] = {
        "handle": handle,
        "token": token,
        "document": None if document is None else {"$bin": 0},
        "label": label,
        "require_full_save": require_full_save,
    }
    return call("jobs.apply", params, None if document is None else [document])


def rotate(handle: str) -> dict[str, Any]:
    return call(
        "actions.run",
        {"handle": handle, "name": "pages.rotate", "args": {"pages": [0], "delta": 90}},
    )


def page_total(handle: str) -> int:
    return int(ok(call("session.info", {"handle": handle}))["page_count"])


def pages_of(data: bytes) -> list[dict[str, Any]]:
    """The page sizes and rotations MuPDF reads from a file's bytes (session.pages)."""
    handle = open_data(data, "output.pdf")
    pages: list[dict[str, Any]] = ok(call("session.pages", {"handle": handle}))["pages"]
    return pages


def sanitize_args(options: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"name": SANITIZE, "args": {} if options is None else {"options": options}}


# The "screen" preset's values, written out as a custom spec: a custom spec equal to a preset must
# give the same file (the mapping in webapi.jobs._reduce_options).
SCREEN_OPTIONS: dict[str, Any] = {
    "image_dpi": 72,
    "jpeg_quality": 50,
    "grayscale": False,
    "subset_fonts": True,
    "remove_thumbnails": True,
    "remove_metadata": False,
    "object_streams": True,
}


def custom_reduce(**changes: Any) -> dict[str, Any]:
    """A reduce_size spec with the custom preset, its options changed by ``changes``."""
    return {"preset": "custom", "options": {**SCREEN_OPTIONS, **changes}}


# -- read-only jobs ---------------------------------------------------------------------------


def test_read_only_job_prepare_run_and_apply(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("images").read_bytes(), "images.pdf")
    session = REGISTRY.get(handle)
    before = (session.is_dirty, session.undo_stack.can_undo, session.structure_version)

    prepared, copy = prepare(handle, "reduce_size", {"preset": "screen"})
    assert prepared["mutating"] is False
    assert prepared["label"] == "reduce_size"
    assert "password" not in prepared  # no password comes back in any reply
    assert copy.startswith(b"%PDF")
    assert session.busy == ""  # a read-only job takes no task

    notices: list[dict[str, Any]] = []
    reply, out = run_job("reduce_size", {"preset": "screen"}, copy, notify=notices.append)
    result = ok(reply)
    assert result["kind"] == "files"
    assert result["document"] is None
    assert result["files"][0]["name"] == "reduced.pdf"
    assert result["files"][0]["mime"] == "application/pdf"
    assert binary(result["files"][0]["data"], out).startswith(b"%PDF")
    assert result["value"]["before"] > 0
    assert result["value"]["after"] > 0
    assert notices[0] == {
        "v": 1,
        "notice": "progress",
        "id": 5,
        "data": {"done": 0, "total": 3, "status": ""},
    }

    applied = ok(apply(handle, prepared["token"]))
    assert applied["applied"] is False  # the result never touched the session
    assert applied["changed"] is None
    assert (session.is_dirty, session.undo_stack.can_undo, session.structure_version) == before


def test_read_only_job_does_not_block_edits(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("images").read_bytes())
    prepare(handle, "reduce_size", {"preset": "ebook"})
    assert ok(rotate(handle))["executed"] is True


def test_read_only_job_is_stale_after_an_edit(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("images").read_bytes())
    prepared, _ = prepare(handle, "reduce_size", {"preset": "ebook"})
    assert ok(rotate(handle))["executed"] is True
    err = error(apply(handle, prepared["token"]))
    assert err["code"] == STALE_OBJECT
    assert err["details"] == {"reason": "document changed"}
    assert error(apply(handle, prepared["token"]))["code"] == STALE_JOB  # the token is spent


def test_a_later_prepare_forgets_an_unapplied_read_only_job(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("images").read_bytes())
    first, _ = prepare(handle, "reduce_size", {"preset": "screen"})
    second, _ = prepare(handle, "reduce_size", {"preset": "print"})
    assert error(apply(handle, first["token"]))["code"] == STALE_JOB
    assert ok(call("jobs.abort", {"handle": handle, "token": second["token"]})) == {"state": None}


def test_a_prepare_refuses_while_a_mutating_job_is_prepared(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("images").read_bytes())
    other = open_data(fixture_pdf("text_multipage").read_bytes(), "other.pdf")
    mutating, _ = prepare(handle, "action", sanitize_args())
    err = error(
        call(
            "jobs.prepare",
            {"handle": other, "job": "reduce_size", "args": {"preset": "ebook"}},
        )
    )
    assert err["code"] == BUSY
    assert err["details"] == {"task": SANITIZE}
    state = ok(call("jobs.abort", {"handle": handle, "token": mutating["token"]}))["state"]
    assert state["busy"] == ""


def test_an_encrypted_document_gives_a_decrypted_copy_and_no_password(
    web: None, fixture_pdf: Any
) -> None:
    # The audit is read-only and writes no PDF, so it shows the copy the job worker gets.
    handle = open_data(fixture_pdf("encrypted").read_bytes(), "encrypted.pdf", password="user")
    prepared, copy = prepare(handle, "audit", {})
    assert "password" not in prepared  # the job worker never gets a password
    record("page_count_pikepdf", copy, pages=1)  # the copy opens with no password
    record("page_count_pdfium", copy, pages=1)
    reply, _ = run_job("audit", {}, copy)
    assert ok(reply)["kind"] == "report"
    # The source itself stays encrypted.
    _, source_out = call_raw("save.save_bytes", {"handle": handle, "mode": "copy"})
    record("refuses_without_password_pikepdf", source_out[0])


def test_a_reduce_of_an_encrypted_document_is_refused_at_prepare(
    web: None, fixture_pdf: Any
) -> None:
    # Desktop keeps the encryption; the web's copy has none, so the reduced file would be open.
    handle = open_data(fixture_pdf("encrypted").read_bytes(), "encrypted.pdf", password="user")
    session = REGISTRY.get(handle)
    err = error(
        call("jobs.prepare", {"handle": handle, "job": "reduce_size", "args": {"preset": "screen"}})
    )
    assert err["code"] == REFUSED
    assert err["details"] == {"reason": "encrypted_reduce"}
    assert len(jobs.PREPARED) == 0
    assert session.busy == ""


# -- reduce_size: custom options and the space audit ------------------------------------------


def test_custom_options_reduce_the_images_and_reopen(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("images").read_bytes(), "images.pdf")
    args = custom_reduce(image_dpi=72, jpeg_quality=40, grayscale=True)
    _, copy = prepare(handle, "reduce_size", args)
    reply, out = run_job("reduce_size", args, copy)
    result = ok(reply)
    assert result["value"]["after"] < result["value"]["before"]
    assert result["value"]["audit_before"] is None  # the audit is opt-in
    data = binary(result["files"][0]["data"], out)
    record("page_count_pikepdf", data, pages=page_total(handle))
    record("render_pdfium", data, page=0, scale=0.5)


def test_custom_options_equal_to_a_preset_give_the_same_size(web: None, fixture_pdf: Any) -> None:
    # The same options must give the same result. Raw byte lengths are not compared: the writer's
    # trailer ID and compression vary between runs (Pyodide's output differs from CPython's by a
    # few bytes), so the pages, their sizes and the opening and rendering are what must match.
    handle = open_data(fixture_pdf("images").read_bytes(), "images.pdf")
    outputs: list[tuple[dict[str, Any], bytes]] = []
    for args in ({"preset": "screen"}, custom_reduce()):
        _, copy = prepare(handle, "reduce_size", args)
        reply, out = run_job("reduce_size", args, copy)
        result = ok(reply)
        data = binary(result["files"][0]["data"], out)
        record("page_count_pikepdf", data, pages=page_total(handle))
        record("render_first_page_pdfium", data)
        outputs.append((result["value"], data))
    pages = [pages_of(data) for _, data in outputs]
    assert len(pages[0]) == page_total(handle)
    assert pages[0] == pages[1]
    # The one size relation between the two files. A byte-independent check cannot express it,
    # because the writer's random trailer ID alone moves the length by a few bytes, so it is held
    # to 1% of the file.
    after = [value["after"] for value, _ in outputs]
    assert abs(after[0] - after[1]) <= after[0] // 100


def test_custom_remove_metadata_drops_the_title(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("images").read_bytes(), "images.pdf")
    args = custom_reduce(remove_metadata=True)
    _, copy = prepare(handle, "reduce_size", args)
    reply, out = run_job("reduce_size", args, copy)
    data = binary(ok(reply)["files"][0]["data"], out)
    record("docinfo_lacks_key_pikepdf", data, key="/Title")


def test_audit_gives_the_space_before_and_after_in_the_same_job(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_data(fixture_pdf("images").read_bytes(), "images.pdf")
    # Grayscale and a lower JPEG quality: the screen preset leaves this fixture's images alone.
    args = {**custom_reduce(image_dpi=72, jpeg_quality=40, grayscale=True), "audit": True}
    prepared, copy = prepare(handle, "reduce_size", args)
    assert prepared["mutating"] is False  # one read-only job: no task, no document change
    notices: list[dict[str, Any]] = []
    reply, out = run_job("reduce_size", args, copy, notify=notices.append)
    value = ok(reply)["value"]
    before, after = value["audit_before"], value["audit_after"]
    assert before is not None
    assert after is not None
    for audit in (before, after):
        assert audit["total"] > 0
        for item in audit["categories"]:
            assert set(item) == {"key", "name", "size"}
            assert item["key"] in jobs.SPACE_CATEGORY_KEYS
            assert item["key"] != "other" or item["name"] == "Other objects"
    images = {"before": 0, "after": 0}
    for stage, audit in (("before", before), ("after", after)):
        images[stage] = sum(item["size"] for item in audit["categories"] if item["key"] == "images")
    assert images["after"] < images["before"]  # the reduce shrank the images
    # The audit's total is the stored size of the copy the audit reads, close to the file's size.
    assert abs(after["total"] - value["after"]) <= max(1024, value["after"] // 10)
    # Five steps (audit before, the reduce, audit after, done). The job worker coalesces the
    # notices, so only the first and the last are certain to arrive.
    assert {notice["data"]["total"] for notice in notices} == {5}
    assert notices[0]["data"]["done"] == 0
    assert notices[-1]["data"]["done"] == 5
    assert binary(ok(reply)["files"][0]["data"], out).startswith(b"%PDF")


def test_without_the_audit_the_values_are_null_and_the_steps_are_three(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_data(fixture_pdf("images").read_bytes(), "images.pdf")
    _, copy = prepare(handle, "reduce_size", {"preset": "screen"})
    notices: list[dict[str, Any]] = []
    reply, _ = run_job("reduce_size", {"preset": "screen"}, copy, notify=notices.append)
    value = ok(reply)["value"]
    assert value["audit_before"] is None
    assert value["audit_after"] is None
    assert {notice["data"]["total"] for notice in notices} == {3}


def test_a_failed_audit_still_returns_the_reduced_file_with_null_audits(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    handle = open_data(fixture_pdf("images").read_bytes(), "images.pdf")
    args = {"preset": "screen", "audit": True}
    _, copy = prepare(handle, "reduce_size", args)

    def audit_fails(*_: Any, **__: Any) -> Any:
        raise EngineError("audit broke")

    monkeypatch.setattr(jobs, "space_audit", audit_fails)
    with caplog.at_level("WARNING", logger="pdfeditor.webapi.jobs"):
        reply, out = run_job("reduce_size", args, copy)
    value = ok(reply)["value"]
    assert value["audit_before"] is None
    assert value["audit_after"] is None
    assert value["before"] > 0 and value["after"] > 0  # the reduce itself ran
    assert binary(ok(reply)["files"][0]["data"], out).startswith(b"%PDF")
    assert "space audit failed" in caplog.text


def test_a_failed_after_audit_keeps_the_before_audit(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The before-audit succeeds and the after-audit fails: the outcome carries the before-audit,
    # the after-audit is None, and the reduced file is still returned.
    handle = open_data(fixture_pdf("images").read_bytes(), "images.pdf")
    args = {"preset": "screen", "audit": True}
    _, copy = prepare(handle, "reduce_size", args)
    real_audit = jobs.space_audit
    calls: list[int] = []

    def audit_then_fail(*a: Any, **k: Any) -> Any:
        calls.append(1)
        if len(calls) == 1:
            return real_audit(*a, **k)
        raise EngineError("after-audit broke")

    monkeypatch.setattr(jobs, "space_audit", audit_then_fail)
    reply, out = run_job("reduce_size", args, copy)
    value = ok(reply)["value"]
    assert value["audit_before"] is not None
    assert value["audit_before"]["total"] > 0
    assert value["audit_after"] is None
    assert value["before"] > 0 and value["after"] > 0
    assert binary(ok(reply)["files"][0]["data"], out).startswith(b"%PDF")


def test_a_reduced_copy_that_cannot_be_reopened_still_returns_the_file(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    # The reopen for the after-audit is inside the audit's protection: a reopen failure drops the
    # after-audit, and the reduced file is still what the user gets.
    handle = open_data(fixture_pdf("images").read_bytes(), "images.pdf")
    args = {"preset": "screen", "audit": True}
    _, copy = prepare(handle, "reduce_size", args)
    real_reduce = jobs.reduce_size
    reduced: list[bytes] = []

    def capture_reduce(*a: Any, **k: Any) -> Any:
        result = real_reduce(*a, **k)
        reduced.append(result.data)
        return result

    engine = get_engine()
    real_open = engine.open

    def open_unless_reduced(source: Any, password: Any = None) -> Any:
        if reduced and source == reduced[0]:
            raise EngineError("cannot read the reduced copy")
        return real_open(source, password)

    monkeypatch.setattr(jobs, "reduce_size", capture_reduce)
    monkeypatch.setattr(engine, "open", open_unless_reduced)
    with caplog.at_level("WARNING", logger="pdfeditor.webapi.jobs"):
        reply, out = run_job("reduce_size", args, copy)
    value = ok(reply)["value"]
    assert value["audit_after"] is None
    assert value["before"] > 0 and value["after"] > 0
    assert binary(ok(reply)["files"][0]["data"], out).startswith(b"%PDF")
    assert "cannot be reopened" in caplog.text


def test_a_cancel_before_the_after_audit_stops_the_job(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle = open_data(fixture_pdf("images").read_bytes(), "images.pdf")
    args = {"preset": "screen", "audit": True}
    _, copy = prepare(handle, "reduce_size", args)
    token = CancelToken()
    real_reduce = jobs.reduce_size

    def reduce_then_cancel(*call_args: Any, **call_kwargs: Any) -> Any:
        result = real_reduce(*call_args, **call_kwargs)
        token.cancel()  # the reduce is done; the job's check before the audit after stops it
        return result

    monkeypatch.setattr(jobs, "reduce_size", reduce_then_cancel)
    reply, _ = run_job("reduce_size", args, copy, cancel=token)
    assert error(reply)["code"] == CANCELLED


# -- mutating jobs ----------------------------------------------------------------------------


def test_mutating_job_blocks_edits_then_applies_as_one_undoable_step(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_data(fixture_pdf("images").read_bytes(), "images.pdf")
    session = REGISTRY.get(handle)
    prepared, copy = prepare(handle, "action", sanitize_args())
    assert prepared["mutating"] is True
    assert prepared["label"] == SANITIZE
    assert session.busy == SANITIZE

    blocked = error(rotate(handle))
    assert blocked["code"] == BUSY
    assert blocked["details"] == {"task": SANITIZE}

    reply, out = run_job("action", sanitize_args(), copy)
    result = ok(reply)
    assert result["kind"] == "document"
    assert result["label"] == SANITIZE_LABEL
    assert result["require_full_save"] is True
    document = binary(result["document"], out)

    applied = ok(apply(handle, prepared["token"], document, result["label"], True))
    assert applied["applied"] is True
    assert applied["changed"] is not None
    assert applied["state"]["undo_label"] == SANITIZE_LABEL
    assert applied["state"]["can_undo"] is True
    assert applied["state"]["require_full_save"] is True
    assert applied["state"]["busy"] == ""
    assert session.busy == ""
    assert session.require_full_save is True

    undone = ok(call("actions.undo", {"handle": handle}))
    assert undone["done"] is True
    assert undone["label"] == SANITIZE_LABEL
    assert undone["state"]["can_undo"] is False  # the job was one step, not several
    assert session.require_full_save is True  # a flag an undo does not clear

    assert ok(rotate(handle))["executed"] is True  # edits are open again


def test_a_mutated_document_saves_and_reopens(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("images").read_bytes(), "images.pdf")
    prepared, copy = prepare(handle, "action", sanitize_args())
    reply, out = run_job("action", sanitize_args(), copy)
    result = ok(reply)
    ok(apply(handle, prepared["token"], binary(result["document"], out), result["label"], True))
    reply, save_out = call_raw("save.save_bytes", {"handle": handle, "mode": "copy"})
    saved = ok(reply)
    assert saved["verified"] is True
    assert saved["incremental"] is False
    data = binary(saved["data"], save_out)
    record("page_count_pikepdf", data, pages=page_total(handle))
    record("render_width_pdfium", data, scale=0.5)


def test_a_cancel_during_a_read_only_job_stops_it(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("images").read_bytes())
    _, copy = prepare(handle, "reduce_size", {"preset": "print"})
    token = CancelToken()
    notices: list[dict[str, Any]] = []

    def notify(notice: dict[str, Any]) -> None:
        notices.append(notice)
        token.cancel()  # the next check in the job stops it

    reply, _ = run_job("reduce_size", {"preset": "print"}, copy, notify=notify, cancel=token)
    assert error(reply)["code"] == CANCELLED
    assert len(notices) == 1  # the job stopped at its first check after the notice


def test_a_mutating_job_on_an_encrypted_document_is_refused_at_prepare(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_data(fixture_pdf("encrypted").read_bytes(), "encrypted.pdf", password="user")
    session = REGISTRY.get(handle)
    before = (session.undo_stack.can_undo, session.structure_version, session.is_dirty)
    err = error(call("jobs.prepare", {"handle": handle, "job": "action", "args": sanitize_args()}))
    assert err["code"] == REFUSED
    assert err["details"] == {"reason": "encrypted_mutating_job"}
    assert len(jobs.PREPARED) == 0  # nothing was prepared
    assert session.busy == ""  # no task was begun
    assert (session.undo_stack.can_undo, session.structure_version, session.is_dirty) == before
    # The document is untouched: a save still needs its password.
    _, saved_out = call_raw("save.save_bytes", {"handle": handle, "mode": "copy"})
    record("refuses_without_password_pikepdf", saved_out[0])
    record("encrypted_pages_pikepdf", saved_out[0], pages=1, password="user")


def test_a_cancelled_mutating_job_is_aborted_and_leaves_the_document_alone(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_data(fixture_pdf("images").read_bytes())
    session = REGISTRY.get(handle)
    before = session.structure_version
    prepared, copy = prepare(handle, "action", sanitize_args())
    token = CancelToken()
    token.cancel()
    reply, _ = run_job("action", sanitize_args(), copy, cancel=token)
    assert error(reply)["code"] == CANCELLED
    assert session.busy == SANITIZE  # still prepared until the client aborts it
    state = ok(call("jobs.abort", {"handle": handle, "token": prepared["token"]}))["state"]
    assert state["busy"] == ""
    assert session.busy == ""
    assert session.structure_version == before
    assert session.undo_stack.can_undo is False
    # After the abort the job is gone: a late apply is refused.
    assert error(apply(handle, prepared["token"], copy, SANITIZE_LABEL))["code"] == STALE_JOB


def test_abort_is_idempotent_and_an_unknown_token_is_stale(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("images").read_bytes())
    session = REGISTRY.get(handle)
    prepared, _ = prepare(handle, "action", sanitize_args())
    state = ok(call("jobs.abort", {"handle": handle, "token": prepared["token"]}))["state"]
    assert state["busy"] == ""
    assert ok(call("jobs.abort", {"handle": handle, "token": prepared["token"]})) == {"state": None}
    assert session.busy == ""
    assert error(call("jobs.abort", {"handle": handle, "token": UNKNOWN_TOKEN}))["code"] == (
        STALE_JOB
    )
    assert error(apply(handle, UNKNOWN_TOKEN, b"", ""))["code"] == STALE_JOB


def test_a_mutating_apply_needs_its_document(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("images").read_bytes())
    prepared, _ = prepare(handle, "action", sanitize_args())
    err = error(apply(handle, prepared["token"], None, SANITIZE_LABEL))
    assert err["code"] == INVALID_ARGS
    assert err["details"]["path"] == "params.document"
    assert (
        ok(call("jobs.abort", {"handle": handle, "token": prepared["token"]}))["state"]["busy"]
        == ""
    )


# -- errors -----------------------------------------------------------------------------------


def test_an_unknown_handle_is_no_document(web: None) -> None:
    err = error(
        call(
            "jobs.prepare", {"handle": "0" * 32, "job": "reduce_size", "args": {"preset": "screen"}}
        )
    )
    assert err["code"] == NO_DOCUMENT


@pytest.mark.parametrize(
    ("job", "args", "path"),
    [
        ("no_such_job", {}, "params.job"),  # not a job type
        ("action", {}, "args.name"),  # a missing field
        ("action", {"name": 5, "args": {}}, "args.name"),  # a wrong type
        ("action", {"name": "no.such.action", "args": {}}, "args.name"),
        ("action", {"name": "pages.rotate", "args": {}}, "args.name"),  # not a long action
        (
            "action",
            {"name": SANITIZE, "args": {"options": {"metadata": "yes"}}},
            "args.args.options.metadata",
        ),
        ("reduce_size", {"preset": "huge"}, "args.preset"),
        ("reduce_size", {}, "args.preset"),
        ("reduce_size", {"preset": "custom"}, "args.options"),  # custom needs options
        ("reduce_size", {"preset": "screen", "options": SCREEN_OPTIONS}, "args.options"),
        ("reduce_size", custom_reduce(image_dpi=35), "args.options.image_dpi"),
        ("reduce_size", custom_reduce(image_dpi=1201), "args.options.image_dpi"),
        ("reduce_size", custom_reduce(jpeg_quality=9), "args.options.jpeg_quality"),
        ("reduce_size", custom_reduce(jpeg_quality=101), "args.options.jpeg_quality"),
        ("reduce_size", custom_reduce(extra=1), "args.options.extra"),  # not an option
        ("reduce_size", {"preset": "screen", "audit": "yes"}, "args.audit"),
    ],
)
def test_a_bad_job_spec_is_invalid_args_with_its_path(
    web: None, fixture_pdf: Any, job: str, args: dict[str, Any], path: str
) -> None:
    handle = open_data(fixture_pdf("images").read_bytes())
    err = error(call("jobs.prepare", {"handle": handle, "job": job, "args": args}))
    assert err["code"] == INVALID_ARGS
    assert err["details"]["path"] == path
    assert len(jobs.PREPARED) == 0  # a bad spec begins no task and keeps no token


def test_the_job_worker_refuses_an_unknown_job_type(web: None, fixture_pdf: Any) -> None:
    _, copy = prepare(
        open_data(fixture_pdf("images").read_bytes()), "reduce_size", {"preset": "ebook"}
    )
    err = error(run_job("no_such_job", {}, copy)[0])
    assert err["code"] == INVALID_ARGS
    assert err["details"]["path"] == "params.job"


def test_a_document_over_the_job_limit_is_refused(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle = open_data(fixture_pdf("images").read_bytes())
    monkeypatch.setattr(limits, "MAX_JOB_BYTES", 100)
    err = error(
        call("jobs.prepare", {"handle": handle, "job": "reduce_size", "args": {"preset": "ebook"}})
    )
    assert err["code"] == FILE_TOO_LARGE
    assert err["details"]["max_bytes"] == 100
    assert err["details"]["size"] > 100
    assert REGISTRY.get(handle).busy == ""


def test_extract_is_a_split_into_one_range_that_changes_nothing(
    web: None, fixture_pdf: Any
) -> None:
    """The organizer's extract (W6.1b): the split job with one range, in the order chosen."""
    handle = open_data(fixture_pdf("text_multipage").read_bytes(), "text_multipage.pdf")
    session = REGISTRY.get(handle)
    before = (session.is_dirty, session.undo_stack.can_undo, session.structure_version)
    args = {"mode": "ranges", "pages_per_file": 1, "ranges": [[2, 0]], "max_bytes": 0}

    prepared, copy = prepare(handle, "split", args)
    assert prepared["mutating"] is False
    reply, out = run_job("split", args, copy)
    result = ok(reply)
    assert result["kind"] == "files"
    assert len(result["files"]) == 1
    extracted = binary(result["files"][0]["data"], out)
    assert extracted.startswith(b"%PDF")
    record("page_count_pikepdf", extracted, pages=2)
    record("page_count_pdfium", extracted, pages=2)

    assert ok(apply(handle, prepared["token"]))["applied"] is False
    assert (session.is_dirty, session.undo_stack.can_undo, session.structure_version) == before
    assert page_total(handle) == 5


# -- reduce_size: the baseline is the file the user holds (issue #610) ------------------------


def test_a_lossless_run_on_a_compact_copy_compares_with_the_opened_size(
    web: None, fixture_pdf: Any
) -> None:
    """Regression for #610: the baseline is the opened file's size while the document is clean.
    The re-save of the open copy is larger than the file, so comparing with it offered a copy that
    was bigger than the one the user holds. Now the run compares with the opened size and offers
    nothing (the copy is not smaller)."""
    heavy = fixture_pdf("heavy").read_bytes()
    first, copy = prepare(open_data(heavy, "heavy.pdf"), "reduce_size", {"preset": "screen"})
    reply, out = run_job("reduce_size", {"preset": "screen", "before": first["baseline"]}, copy)
    compact = binary(ok(reply)["files"][0]["data"], out)
    assert len(compact) < len(heavy)

    handle = open_data(compact, "reduced.pdf")
    prepared, copy = prepare(handle, "reduce_size", {"preset": "lossless"})
    assert prepared["baseline"] == len(compact)
    reply, _ = run_job("reduce_size", {"preset": "lossless", "before": prepared["baseline"]}, copy)
    value = ok(reply)["value"]
    assert value["before"] == len(compact)  # the opened file, not a re-save of the copy
    assert value["after"] >= value["before"]  # so the web offers no download (after < before)


def test_a_dirty_document_has_no_baseline(web: None, fixture_pdf: Any) -> None:
    """A changed document is not the file on disk, so the job falls back to a re-save (the desktop
    compares with the on-disk file only while the document is clean)."""
    handle = open_data(fixture_pdf("images").read_bytes(), "images.pdf")
    prepared, _ = prepare(handle, "reduce_size", {"preset": "screen"})
    assert prepared["baseline"] == len(fixture_pdf("images").read_bytes())
    assert ok(apply(handle, prepared["token"]))["applied"] is False
    assert ok(rotate(handle))["executed"] is True
    prepared, _ = prepare(handle, "reduce_size", {"preset": "screen"})
    assert prepared["baseline"] is None


def test_a_negative_before_is_invalid_args_in_the_job_worker(web: None, fixture_pdf: Any) -> None:
    _, copy = prepare(
        open_data(fixture_pdf("images").read_bytes()), "reduce_size", {"preset": "screen"}
    )
    err = error(run_job("reduce_size", {"preset": "screen", "before": -1}, copy)[0])
    assert err["code"] == INVALID_ARGS
    assert err["details"]["path"] == "args.before"


def test_a_lossless_run_without_a_baseline_falls_back_to_a_resave(
    web: None, fixture_pdf: Any
) -> None:
    """No ``before`` sent (an older client, or a dirty document): the job still compares with a
    re-save of the copy, so the result carries a positive size to compare with."""
    _, copy = prepare(
        open_data(fixture_pdf("images").read_bytes()), "reduce_size", {"preset": "lossless"}
    )
    value = ok(run_job("reduce_size", {"preset": "lossless"}, copy)[0])["value"]
    assert value["before"] > 0


def test_a_non_reduce_job_has_no_baseline(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("text_multipage").read_bytes(), "text_multipage.pdf")
    args = {"mode": "ranges", "pages_per_file": 1, "ranges": [[2, 0]], "max_bytes": 0}
    prepared, _ = prepare(handle, "split", args)
    assert prepared["baseline"] is None


def test_a_save_the_browser_did_not_write_keeps_the_opened_size_as_the_baseline(
    web: None, fixture_pdf: Any
) -> None:
    """Regression for the held size (F2): save_bytes returns bytes the browser may fail to write.
    Until mark_saved says they were written, the user still holds the opened file, so after an
    undo back to the clean state the baseline is the opened size, not the unwritten save."""
    data = fixture_pdf("images").read_bytes()
    handle = open_data(data, "images.pdf")
    assert ok(rotate(handle))["executed"] is True
    reply, out = call_raw("save.save_bytes", {"handle": handle, "mode": "copy"})
    saved = binary(ok(reply)["data"], out)
    assert len(saved) != len(data)  # otherwise the test could not tell the two sizes apart

    assert ok(call("actions.undo", {"handle": handle}))  # back to the clean state
    assert not REGISTRY.get(handle).is_dirty
    prepared, _ = prepare(handle, "reduce_size", {"preset": "screen"})
    assert prepared["baseline"] == len(data)


def test_mark_saved_makes_the_saved_size_the_baseline(web: None, fixture_pdf: Any) -> None:
    data = fixture_pdf("images").read_bytes()
    handle = open_data(data, "images.pdf")
    assert ok(rotate(handle))["executed"] is True
    reply, out = call_raw("save.save_bytes", {"handle": handle, "mode": "copy"})
    saved = binary(ok(reply)["data"], out)
    assert ok(call("save.mark_saved", {"handle": handle}))["saved"] is True
    prepared, _ = prepare(handle, "reduce_size", {"preset": "screen"})
    assert prepared["baseline"] == len(saved)
