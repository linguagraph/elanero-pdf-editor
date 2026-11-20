"""The change events of the reply envelope and session.open's state, through dispatch (W1.2
sections 4 and 7, W3.5).

A call that changes content carries ``changed`` and ``state`` events built from the same DTOs as
the result's own fields; a read-only call carries none. A failed call carries the events it caused
(a refused edit gives ``blocked``, a partial action its ``changed`` and ``state``), and a failure
before anything changed carries none. The helpers are the ones of the actions tests.
"""

from __future__ import annotations

import ast
import json
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from pdfeditor import actions as layer
from pdfeditor.actions.base import Refused
from pdfeditor.core.commands.base import Change, ChangeKind
from pdfeditor.core.session import EventKind, SessionEvent
from pdfeditor.model import platform as model_platform
from pdfeditor.webapi import dispatch, jobs
from pdfeditor.webapi.errors import BUSY, NO_DOCUMENT, REFUSED, STALE_OBJECT
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.hostcheck import record
from tests.unit.test_webapi_actions import (
    ROTATE_RIGHT,
    call,
    call_raw,
    error,
    ok,
    open_bytes,
    redo,
    revision_of,
    rotate,
    undo,
)
from tests.unit.test_webapi_jobs import SANITIZE, open_data, prepare, sanitize_args
from tests.unit.test_webapi_save import page_total, saved_bytes


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


def events_of(reply: dict[str, Any], kind: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = reply["events"]
    return [event for event in events if event["kind"] == kind]


def test_an_action_reply_carries_changed_and_state_events(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf)
    reply = rotate(handle)
    result = ok(reply)
    assert [event["kind"] for event in reply["events"]] == ["changed", "state"]
    changed, state = reply["events"]
    assert changed["handle"] == handle and state["handle"] == handle
    # Revisions are keyed by page index as strings, and hold the revision after the change.
    # A rotate is a structure change, which names no pages: every page's revision is sent.
    pages = int(ok(call("session.info", {"handle": handle}))["page_count"])
    assert list(changed["revisions"]) == [str(i) for i in range(pages)]
    assert changed["revisions"]["0"] == revision_of(handle, 0)
    assert {c["kind"] for c in changed["changes"]} == {"structure"}
    assert changed["changes"] == result["changed"]["changes"]
    assert changed["revisions"] == result["changed"]["revisions"]
    assert state["state"] == result["state"]


def test_a_structure_change_moves_structure_version_in_the_state_event(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_bytes(fixture_pdf)
    reply = rotate(handle)
    kinds = {c["kind"] for c in events_of(reply, "changed")[0]["changes"]}
    assert kinds == {"structure"}
    state = events_of(reply, "state")[0]["state"]
    assert state["structure_version"] == 1
    assert state["undo_label"] == ROTATE_RIGHT and state["dirty"] is True


def test_undo_and_redo_carry_events(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf)
    rotate(handle)
    undo_reply = undo(handle)
    assert [e["kind"] for e in undo_reply["events"]] == ["changed", "state"]
    state = events_of(undo_reply, "state")[0]["state"]
    assert state["can_undo"] is False and state["can_redo"] is True
    assert state["redo_label"] == ROTATE_RIGHT
    redo_reply = redo(handle)
    assert [e["kind"] for e in redo_reply["events"]] == ["changed", "state"]
    assert events_of(redo_reply, "state")[0]["state"]["can_redo"] is False


def test_a_call_that_changes_nothing_carries_no_events(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf)
    reply = undo(handle)  # the stack is empty: nothing changed
    assert ok(reply)["done"] is False
    assert reply["events"] == []


def test_read_only_calls_carry_no_events(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf)
    for method, params in (
        ("text.layer", {"handle": handle, "page": 0}),
        ("session.info", {"handle": handle}),
        ("session.pages", {"handle": handle}),
        ("actions.available", {"handle": handle}),
    ):
        reply = call(method, params)
        ok(reply)
        assert reply["events"] == [], method


def test_session_open_returns_the_clean_state(web: None, fixture_pdf: Any) -> None:
    data = fixture_pdf("text_multipage").read_bytes()
    reply, _, out = call_raw(
        "session.open",
        {"name": "text_multipage.pdf", "data": {"$bin": 0}, "password": None},
        [data],
    )
    assert out == []
    result = ok(reply)
    state = result["state"]
    assert state["dirty"] is False
    assert state["can_undo"] is False and state["can_redo"] is False
    assert state["undo_label"] == "" and state["redo_label"] == ""
    assert state["structure_version"] == 0
    assert state["page_count"] == result["pages"] == result["info"]["page_count"]
    assert reply["events"] == []


def test_session_close_gives_a_closed_event(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf)
    reply = call("session.close", {"handle": handle})
    ok(reply)
    assert reply["events"] == [{"kind": "closed", "handle": handle}]
    assert error(call("session.info", {"handle": handle}))["code"] == NO_DOCUMENT


def test_the_old_changed_and_state_fields_match_the_events(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf)
    for reply in (rotate(handle), undo(handle), redo(handle)):
        result = ok(reply)
        changed = events_of(reply, "changed")[0]
        assert result["changed"] == {
            "changes": changed["changes"],
            "revisions": changed["revisions"],
        }
        assert result["state"] == events_of(reply, "state")[0]["state"]


def test_a_refused_edit_fails_with_busy_and_a_blocked_event(web: None, fixture_pdf: Any) -> None:
    """W1.2 sections 2 and 7: a failed call carries the events it caused. A refused edit gives
    ``blocked`` (the task label) and fails with BUSY; the document state did not change."""
    handle = open_bytes(fixture_pdf)
    session = REGISTRY.get(handle)
    session.begin_task("Test task")
    try:
        reply = rotate(handle)
        assert error(reply)["code"] == BUSY
        assert error(reply)["details"] == {"task": "Test task"}
        assert reply["events"] == [{"kind": "blocked", "handle": handle, "task": "Test task"}]
    finally:
        session.end_task("Test task")
    failed = call("actions.run", {"handle": handle, "name": "no.such", "args": {}})
    assert failed["ok"] is False and failed["events"] == []


def test_events_are_json_with_string_revision_keys(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf)
    reply_json, _ = dispatch(
        json.dumps(
            {
                "v": 1,
                "id": 3,
                "method": "actions.run",
                "params": {
                    "handle": handle,
                    "name": "pages.rotate",
                    "args": {"pages": [0, 1], "delta": 90},
                },
            }
        ),
        [],
    )
    reply = json.loads(reply_json)
    changed = events_of(reply, "changed")[0]
    assert all(isinstance(key, str) for key in changed["revisions"])
    pages = int(ok(call("session.info", {"handle": handle}))["page_count"])
    assert set(changed["revisions"]) == {str(i) for i in range(pages)}


# -- save.mark_saved (W1.2 sections 4, 7 and 12; W3.5) ------------------------------------------


def save_copy(handle: str) -> None:
    """Write the document the way the front end does (its bytes are not needed here)."""
    ok(call("save.save_bytes", {"handle": handle, "mode": "copy"}))


def mark_saved(handle: str) -> dict[str, Any]:
    return call("save.mark_saved", {"handle": handle})


def test_mark_saved_after_a_save_clears_dirty_and_gives_a_saved_event(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_bytes(fixture_pdf)
    ok(rotate(handle))
    save_copy(handle)
    reply = mark_saved(handle)
    result = ok(reply)
    assert result["saved"] is True
    assert result["state"]["dirty"] is False
    assert reply["events"][0] == {"kind": "saved", "handle": handle}
    assert [event["kind"] for event in reply["events"]] == ["saved", "state"]
    assert reply["events"][1]["state"] == result["state"]
    assert REGISTRY.get(handle).is_dirty is False


def test_a_second_mark_saved_is_a_no_op_with_no_event(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf)
    ok(rotate(handle))
    save_copy(handle)
    ok(mark_saved(handle))
    reply = mark_saved(handle)
    result = ok(reply)
    assert result["saved"] is False
    assert result["state"]["dirty"] is False
    assert reply["events"] == []


def test_an_edit_after_the_save_makes_mark_saved_refuse(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf)
    ok(rotate(handle))
    save_copy(handle)
    ok(rotate(handle))  # the front end holds the bytes of the save, which are now out of date
    reply = mark_saved(handle)
    assert error(reply)["code"] == STALE_OBJECT
    assert reply["events"] == []  # refused before anything changed, so no state event
    assert REGISTRY.get(handle).is_dirty is True
    # A save of the new state makes the call succeed again.
    save_copy(handle)
    assert ok(mark_saved(handle))["state"]["dirty"] is False


def test_mark_saved_on_a_document_never_saved_through_the_web_is_refused(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_bytes(fixture_pdf)
    ok(rotate(handle))
    assert error(mark_saved(handle))["code"] == STALE_OBJECT
    assert REGISTRY.get(handle).is_dirty is True


def test_undo_after_a_saved_save_makes_the_document_dirty_again(
    web: None, fixture_pdf: Any
) -> None:
    # A save is a read, so the undo history is the one the edit left. Undo after the saved copy
    # changes the document again: its state event reports it dirty (W4.8 S1 shows the dot).
    handle = open_bytes(fixture_pdf)
    ok(rotate(handle))
    session = REGISTRY.get(handle)
    label = session.undo_stack.undo_label
    save_copy(handle)
    ok(mark_saved(handle))
    assert session.is_dirty is False
    assert session.undo_stack.can_undo is True
    assert session.undo_stack.undo_label == label
    reply = undo(handle)
    assert ok(reply)["done"] is True
    states = [event["state"] for event in events_of(reply, "state")]
    assert states[-1]["dirty"] is True
    assert states[-1]["can_undo"] is False
    assert session.is_dirty is True


def test_read_only_calls_after_a_save_emit_no_saved_event(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf)
    ok(rotate(handle))
    save_copy(handle)
    for method in ("session.info", "session.pages", "session.capabilities", "actions.available"):
        reply = call(method, {"handle": handle})
        ok(reply)
        assert reply["events"] == [], method
    assert REGISTRY.get(handle).is_dirty is True


# -- the busy flag of the jobs calls (W3.5) -------------------------------------------------------


def prepare_job(handle: str, job: str, args: dict[str, Any]) -> dict[str, Any]:
    return call("jobs.prepare", {"handle": handle, "job": job, "args": args})


def test_a_mutating_prepare_gives_a_busy_state_event(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("images").read_bytes())
    reply = prepare_job(handle, "action", sanitize_args())
    result = ok(reply)
    assert result["mutating"] is True
    assert [event["kind"] for event in reply["events"]] == ["state"]
    state = reply["events"][0]
    assert state["handle"] == handle
    assert state["state"]["busy"] == SANITIZE
    assert state["state"] == result["state"]  # the same DTO as the result's own field
    assert REGISTRY.get(handle).busy == SANITIZE
    assert ok(call("jobs.abort", {"handle": handle, "token": result["token"]}))["state"]


def test_a_read_only_prepare_gives_no_state_event(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("images").read_bytes())
    reply = prepare_job(handle, "reduce_size", {"preset": "screen"})
    result = ok(reply)
    assert result["mutating"] is False
    assert reply["events"] == []
    assert result["state"] is None
    assert REGISTRY.get(handle).busy == ""
    token = result["token"]
    assert ok(call("jobs.abort", {"handle": handle, "token": token}))["state"] is None


def test_aborting_a_mutating_job_gives_a_clear_busy_state_event(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_data(fixture_pdf("images").read_bytes())
    token = ok(prepare_job(handle, "action", sanitize_args()))["token"]
    reply = call("jobs.abort", {"handle": handle, "token": token})
    assert ok(reply)["state"]["busy"] == ""
    assert [event["kind"] for event in reply["events"]] == ["state"]
    assert reply["events"][0]["handle"] == handle
    assert reply["events"][0]["state"]["busy"] == ""
    assert reply["events"][0]["state"] == ok(reply)["state"]
    assert REGISTRY.get(handle).busy == ""


def test_a_repeated_abort_gives_no_event(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("images").read_bytes())
    token = ok(prepare_job(handle, "action", sanitize_args()))["token"]
    ok(call("jobs.abort", {"handle": handle, "token": token}))
    reply = call("jobs.abort", {"handle": handle, "token": token})
    assert ok(reply) == {"state": None}
    assert reply["events"] == []


def test_a_refused_prepare_on_an_encrypted_document_gives_no_event(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_data(fixture_pdf("encrypted").read_bytes(), "encrypted.pdf", password="user")
    session = REGISTRY.get(handle)
    before = (
        session.busy,
        session.undo_stack.can_undo,
        session.structure_version,
        session.is_dirty,
    )
    reply = prepare_job(handle, "action", sanitize_args())
    assert error(reply)["code"] == REFUSED
    assert reply["events"] == []  # refused before the task began, so no state event
    assert len(jobs.PREPARED) == 0
    assert (
        session.busy,
        session.undo_stack.can_undo,
        session.structure_version,
        session.is_dirty,
    ) == before


# -- failed calls and the recorder (W1.2 sections 2, 4 and 7; W3.5) -----------------------------


def test_a_refused_undo_or_redo_gives_blocked_and_busy(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf)
    ok(rotate(handle))
    ok(undo(handle))
    session = REGISTRY.get(handle)
    session.begin_task("Test task")
    try:
        for method in (redo, undo):
            reply = method(handle)
            assert error(reply)["code"] == BUSY, method.__name__
            assert [e["kind"] for e in reply["events"]] == ["blocked"], method.__name__
            assert reply["events"][0]["task"] == "Test task"
    finally:
        session.end_task("Test task")


def test_a_stale_apply_reports_the_busy_flag_it_cleared(web: None, fixture_pdf: Any) -> None:
    """jobs.apply ends the task before it checks the document. The stale failure must still say
    so: its state event carries busy "", and the token is spent (a later abort is a no-op)."""
    handle = open_data(fixture_pdf("images").read_bytes(), "images.pdf")
    prepared, copy = prepare(handle, "action", sanitize_args())
    token = prepared["token"]
    session = REGISTRY.get(handle)
    session.end_task(SANITIZE)
    ok(rotate(handle))  # an edit while no task runs: the job's copy is now stale
    session.begin_task(SANITIZE)
    reply, _, _ = call_raw(
        "jobs.apply",
        {
            "handle": handle,
            "token": token,
            "document": {"$bin": 0},
            "label": "Sanitize",
            "require_full_save": False,
        },
        [copy],
    )
    assert error(reply)["code"] == STALE_OBJECT
    assert [e["kind"] for e in reply["events"]] == ["state"]
    assert reply["events"][0]["state"]["busy"] == ""
    assert session.busy == ""
    aborted = call("jobs.abort", {"handle": handle, "token": token})
    assert ok(aborted) == {"state": None} and aborted["events"] == []


def test_a_refused_action_after_a_change_reports_the_change(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An action that changed a page and then refused: the failure carries what it changed."""
    handle = open_bytes(fixture_pdf)
    real_run = layer.run

    def run_then_refuse(session: Any, name: str, args: Any) -> Any:
        real_run(session, name, args)
        raise Refused("stopped after the first step")

    monkeypatch.setattr(layer, "run", run_then_refuse)
    reply = rotate(handle)
    monkeypatch.undo()
    assert error(reply)["code"] == REFUSED
    assert [e["kind"] for e in reply["events"]] == ["changed", "state"]
    assert reply["events"][0]["revisions"]["0"] == revision_of(handle, 0)
    assert reply["events"][1]["state"]["undo_label"] == ROTATE_RIGHT


def test_a_change_that_leaves_the_state_alone_gives_changed_only(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A CHANGED that moves no state (a merged edit, in effect) gives ``changed`` and no state."""
    handle = open_bytes(fixture_pdf)
    session = REGISTRY.get(handle)

    def announce_only(_session: Any, name: str, args: Any) -> Any:
        change = Change(ChangeKind.CONTENT, frozenset({0}))
        session._emit(SessionEvent(EventKind.CHANGED, (change,)))
        return SimpleNamespace(label=name, executed=True, value=None)

    monkeypatch.setattr(layer, "run", announce_only)
    reply = rotate(handle)
    monkeypatch.undo()
    assert ok(reply)["executed"] is True
    assert [e["kind"] for e in reply["events"]] == ["changed"]
    assert reply["events"][0]["revisions"] == {"0": revision_of(handle, 0)}


def test_a_signal_outside_a_call_is_not_recorded(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf)
    session = REGISTRY.get(handle)
    session.begin_task("Test task")
    try:
        assert session.refuse_while_busy() is True  # a BLOCKED event, but no call is running
        reply = call("session.info", {"handle": handle})
        ok(reply)
        assert reply["events"] == []
    finally:
        session.end_task("Test task")


def test_a_document_has_one_recorder_and_closing_it_removes_it(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf)
    session = REGISTRY.get(handle)
    assert len(session._listeners) == 1  # the registry's recorder, and nothing else
    ok(call("session.close", {"handle": handle}))
    assert session._listeners == []


# -- a saved output after a run of events (AGENTS round-trip rule) --------------------------------


def test_events_round_trip_save(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("images").read_bytes(), "images.pdf")
    ok(rotate(handle))
    ok(undo(handle))
    ok(redo(handle))
    token = ok(prepare_job(handle, "action", sanitize_args()))["token"]
    refused = undo(handle)  # a task is prepared: the undo is refused
    assert error(refused)["code"] == BUSY
    assert [e["kind"] for e in refused["events"]] == ["blocked"]
    aborted = call("jobs.abort", {"handle": handle, "token": token})
    assert [e["kind"] for e in aborted["events"]] == ["state"]
    assert aborted["events"][0]["state"]["busy"] == ""

    result, saved = saved_bytes(handle, "copy")
    assert result["incremental"] is False
    record("page_count_pikepdf", saved, pages=page_total(handle))
    record("rotation_pikepdf", saved, page=0, degrees=90)
    record("render_width_pdfium", saved, scale=0.5)

    reopened = open_data(saved, "saved.pdf")
    pages = ok(call("session.pages", {"handle": reopened}))["pages"]
    assert pages[0]["rotation"] == 90


def test_the_job_event_modules_import_no_pikepdf_or_pypdfium2_at_module_level() -> None:
    # The web worker runs these modules in Pyodide, where those packages are not installed.
    root = Path(__file__).resolve().parents[2]
    for rel in (
        "src/pdfeditor/webapi/events.py",
        "src/pdfeditor/webapi/jobs.py",
        "tests/unit/test_webapi_events.py",
    ):
        tree = ast.parse((root / rel).read_text(encoding="utf-8"))
        for node in tree.body:
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [node.module or ""]
            else:
                continue
            for name in names:
                top = name.split(".")[0]
                assert top not in {"pikepdf", "pypdfium2"}, (rel, name)
