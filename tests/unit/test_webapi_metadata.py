"""The properties dialog's calls (W7.6): session.info carries the Info fields, and the metadata
action runs through actions.run and actions.undo like any other edit.

The web sends the whole Info block to ``document.set_metadata`` (the desktop does the same), so a
change to one field keeps the others. The saved bytes are reopened in pikepdf and rendered in
pypdfium2 (the round-trip rule in AGENTS.md); those checks go through ``tests.hostcheck.record``.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.webapi import dispatch
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.hostcheck import record

INFO_KEYS = (
    "title",
    "author",
    "subject",
    "keywords",
    "creator",
    "producer",
    "creation_date",
    "mod_date",
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


def call(method: str, params: dict[str, Any], buffers: list[bytes] | None = None) -> Any:
    request = json.dumps({"v": 1, "id": 11, "method": method, "params": params})
    reply_json, out = dispatch(request, buffers or [])
    reply = json.loads(reply_json)
    assert reply["ok"] is True, reply
    return reply["result"], out


def open_fixture(fixture_pdf: Any) -> str:
    data = fixture_pdf("text_multipage").read_bytes()
    result, _ = call(
        "session.open",
        {"name": "text_multipage.pdf", "data": {"$bin": 0}, "password": None},
        [data],
    )
    return str(result["handle"])


def info(handle: str) -> dict[str, Any]:
    result, _ = call("session.info", {"handle": handle})
    return dict(result)


def set_metadata(handle: str, **fields: str) -> dict[str, Any]:
    current = {key: info(handle)[key] for key in INFO_KEYS}
    result, _ = call(
        "actions.run",
        {
            "handle": handle,
            "name": "document.set_metadata",
            "args": {"metadata": {**current, **fields}},
        },
    )
    return dict(result)


def test_session_info_carries_every_info_field(web: None, fixture_pdf: Any) -> None:
    result = info(open_fixture(fixture_pdf))
    for key in INFO_KEYS:
        assert isinstance(result[key], str)


def test_set_metadata_changes_the_title_and_keeps_the_other_fields(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_fixture(fixture_pdf)
    before = info(handle)
    run = set_metadata(handle, title="Quarterly report", author="Finance")
    assert run["executed"] is True
    after = info(handle)
    assert after["title"] == "Quarterly report"
    assert after["author"] == "Finance"
    assert after["producer"] == before["producer"]
    assert after["creation_date"] == before["creation_date"]


def test_undo_restores_the_previous_fields(web: None, fixture_pdf: Any) -> None:
    handle = open_fixture(fixture_pdf)
    before = info(handle)
    set_metadata(handle, title="Changed")
    result, _ = call("actions.undo", {"handle": handle})
    assert result["done"] is True
    assert info(handle) == before


def test_metadata_round_trip_reopens_in_pikepdf_and_pdfium(web: None, fixture_pdf: Any) -> None:
    handle = open_fixture(fixture_pdf)
    set_metadata(handle, title="Saved title", author="Finance")
    result, out = call("save.save_bytes", {"handle": handle, "mode": "copy"})
    assert result["verified"] is True
    assert len(out) == 1
    record("docinfo_title_pikepdf", out[0], title="Saved title")
    record("opens_pdfium", out[0])
