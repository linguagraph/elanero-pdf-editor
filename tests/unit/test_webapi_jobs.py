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


def sanitize_args(options: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"name": SANITIZE, "args": {} if options is None else {"options": options}}


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
    handle = open_data(fixture_pdf("encrypted").read_bytes(), "encrypted.pdf", password="user")
    prepared, copy = prepare(handle, "reduce_size", {"preset": "lossless"})
    assert "password" not in prepared  # the job worker never gets a password
    record("page_count_pikepdf", copy, pages=1)  # the copy opens with no password
    record("page_count_pdfium", copy, pages=1)
    reply, out = run_job("reduce_size", {"preset": "lossless"}, copy)
    assert binary(ok(reply)["files"][0]["data"], out).startswith(b"%PDF")
    # The source itself stays encrypted.
    _, source_out = call_raw("save.save_bytes", {"handle": handle, "mode": "copy"})
    record("refuses_without_password_pikepdf", source_out[0])


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
