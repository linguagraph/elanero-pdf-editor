"""The XFDF round trip of W7.2 through the web: a comment with a reply is exported by the
``comments_export`` job, imported into another document by ``annotations.import_xfdf`` through
``actions.run``, and saved. The saved bytes are checked in pikepdf (the comments and the reply's
/IRT link) through ``tests.hostcheck.record``, as in test_webapi_save.py. Nothing here imports
pikepdf or pypdfium2 at module level, so the module runs under Pyodide too.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.webapi import dispatch, jobs, jobworker
from pdfeditor.webapi.errors import REFUSED
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.hostcheck import record

# A note and a reply to it on page 1. The names are real (/NM), so the reply links to the note.
SOURCE_XFDF = """<?xml version="1.0" encoding="UTF-8"?>
<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">
<annots>
<text name="note-1" page="0" rect="72,600,92,620" title="Ana"
      date="D:20260101120000Z" color="#FFFF00">
<contents>Please check the total</contents>
</text>
<text name="reply-1" page="0" rect="72,600,92,620" inreplyto="note-1" title="Ben"
      date="D:20260101130000Z">
<contents>Checked, it is right</contents>
</text>
</annots>
</xfdf>
"""


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
    request = json.dumps({"v": 1, "id": 13, "method": method, "params": params})
    reply_json, out = dispatch(request, buffers or [])
    return json.loads(reply_json), out


def call(method: str, params: dict[str, Any]) -> dict[str, Any]:
    reply, _ = call_raw(method, params)
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
    reply, _ = call_raw(
        "session.open", {"name": name, "data": {"$bin": 0}, "password": None}, [data]
    )
    return str(ok(reply)["handle"])


def text_fixture(fixture_pdf: Any) -> bytes:
    return bytes(fixture_pdf("text_multipage").read_bytes())


def import_xfdf(handle: str, text: str) -> dict[str, Any]:
    return call(
        "actions.run", {"handle": handle, "name": "annotations.import_xfdf", "args": {"text": text}}
    )


def export_xfdf(handle: str, name: str) -> str:
    """The comments_export job's XFDF, run on the job's copy as the web runs it."""
    args = {"format": "xfdf", "name": name}
    reply, out = call_raw(
        "jobs.prepare", {"handle": handle, "job": "comments_export", "args": args}
    )
    copy = out[ok(reply)["document"]["$bin"]]
    request = json.dumps(
        {
            "v": 1,
            "id": 14,
            "method": "job.run",
            "params": {"job": "comments_export", "args": args, "document": {"$bin": 0}},
        }
    )
    reply_json, run_out = jobworker.dispatch(request, [copy])
    item = json.loads(reply_json)["result"]["files"][0]
    return run_out[item["data"]["$bin"]].decode("utf-8")


def page_total(handle: str) -> int:
    return int(ok(call("session.info", {"handle": handle}))["page_count"])


def annotations_of(handle: str) -> list[Any]:
    return list(REGISTRY.get(handle).document.page(0).annotations())


def test_an_exported_comment_and_its_reply_import_into_another_document(
    web: None, fixture_pdf: Any
) -> None:
    source = open_data(text_fixture(fixture_pdf), "source.pdf")
    imported = ok(import_xfdf(source, SOURCE_XFDF))
    assert imported["executed"] is True
    assert imported["value"] == 2

    exported = export_xfdf(source, "source.pdf")
    assert 'inreplyto="note-1"' in exported
    assert "Please check the total" in exported

    target = open_data(text_fixture(fixture_pdf), "target.pdf")
    assert ok(import_xfdf(target, exported))["value"] == 2
    annots = annotations_of(target)
    replies = [a for a in annots if a.in_reply_to is not None]
    assert len(replies) == 1
    parent = next(a for a in annots if a.id == replies[0].in_reply_to)
    assert parent.contents == "Please check the total"
    assert replies[0].contents == "Checked, it is right"

    reply, out = call_raw("save.save_bytes", {"handle": target, "mode": "copy"})
    saved_result = ok(reply)
    assert saved_result["verified"] is True
    saved = out[saved_result["data"]["$bin"]]
    record("comments_pikepdf", saved, comments=2, replies=1)
    record("page_count_pikepdf", saved, pages=page_total(target))
    record("render_width_pdfium", saved, scale=0.5)


def test_a_malformed_or_entity_xfdf_is_refused_and_changes_nothing(
    web: None, fixture_pdf: Any
) -> None:
    target = open_data(text_fixture(fixture_pdf), "target.pdf")
    session = REGISTRY.get(target)
    before = (len(annotations_of(target)), session.undo_stack.is_clean)
    for text in (
        "<xfdf><annots>",  # not well-formed
        '<?xml version="1.0"?><!DOCTYPE xfdf [<!ENTITY e "x">]><xfdf/>',  # DOCTYPE guard (S1)
    ):
        err = error(import_xfdf(target, text))
        assert err["code"] == REFUSED
    assert (len(annotations_of(target)), session.undo_stack.is_clean) == before
