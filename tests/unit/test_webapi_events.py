"""The change events of the reply envelope and session.open's state, through dispatch (W1.2
sections 4 and 7, W3.5).

A call that changes content carries ``changed`` and ``state`` events built from the same DTOs as
the result's own fields; a read-only call carries none; a failure keeps the error envelope, which
has no events. The helpers are the ones of the actions tests.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.webapi import dispatch
from pdfeditor.webapi.errors import BUSY, NO_DOCUMENT
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
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


@pytest.fixture
def web() -> Iterator[None]:
    previous = model_platform.current()
    configure_web()
    try:
        yield
    finally:
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


def test_a_failed_call_keeps_the_error_envelope_without_events(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf)
    session = REGISTRY.get(handle)
    session.begin_task("Test task")
    try:
        reply = rotate(handle)
        assert error(reply)["code"] == BUSY
        assert "events" not in reply
    finally:
        session.end_task("Test task")
    failed = call("actions.run", {"handle": handle, "name": "no.such", "args": {}})
    assert failed["ok"] is False and "events" not in failed


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
