"""The read-only attachment calls of W7.9 S2 (``attachments.list`` and ``attachments.get``) through
dispatch, on the ``images`` fixture (it embeds ``notes``, a 15-byte ``notes.txt``).

Neither call changes the document: the saved bytes are the same before and after. The saved copy
must keep the attachment, open in pikepdf and render in pypdfium2, through
``tests.hostcheck.record``, so this module imports neither at module level.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from pdfeditor.core.session import DocumentSession
from pdfeditor.model import platform as model_platform
from pdfeditor.webapi import dispatch, limits
from pdfeditor.webapi.jobs import document_fingerprint
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.hostcheck import record
from tests.unit.test_webapi_session import handle_of, open_bytes

NOTES = b"attached notes\n"


@pytest.fixture
def web() -> Iterator[None]:
    previous = model_platform.current()
    configure_web()
    try:
        yield
    finally:
        REGISTRY.close_all()
        model_platform.configure(previous)


def call(
    method: str, params: dict[str, Any], buffers: list[bytes] | None = None
) -> tuple[dict[str, Any], list[bytes]]:
    request = json.dumps({"v": 1, "id": 1, "method": method, "params": params})
    reply_json, out = dispatch(request, buffers or [])
    return json.loads(reply_json), out


def ok(reply: dict[str, Any]) -> dict[str, Any]:
    assert reply["ok"] is True, reply
    result: dict[str, Any] = reply["result"]
    return result


def saved_copy(handle: str) -> bytes:
    reply, out = call("save.save_bytes", {"handle": handle, "mode": "copy"})
    assert ok(reply)["verified"] is True
    return out[0]


def test_list_gives_name_filename_size_and_description(web: None, fixture_pdf: Any) -> None:
    handle = handle_of(open_bytes(fixture_pdf("images").read_bytes()))
    reply, _ = call("attachments.list", {"handle": handle})
    assert ok(reply) == {
        "entries": [
            {
                "name": "notes",
                "filename": "notes.txt",
                "size": len(NOTES),
                "description": "Attached notes",
            }
        ]
    }


def test_get_returns_the_bytes_as_one_buffer(web: None, fixture_pdf: Any) -> None:
    handle = handle_of(open_bytes(fixture_pdf("images").read_bytes()))
    reply, out = call("attachments.get", {"handle": handle, "name": "notes"})
    result = ok(reply)
    assert result["filename"] == "notes.txt"
    assert out == [NOTES]
    assert result["data"] == {"$bin": 0}


def test_an_unknown_name_is_stale(web: None, fixture_pdf: Any) -> None:
    handle = handle_of(open_bytes(fixture_pdf("images").read_bytes()))
    reply, _ = call("attachments.get", {"handle": handle, "name": "gone"})
    assert reply["ok"] is False
    assert reply["error"]["code"] == "STALE_OBJECT"


def test_a_document_without_attachments_lists_nothing(web: None, fixture_pdf: Any) -> None:
    handle = handle_of(open_bytes(fixture_pdf("text_multipage").read_bytes()))
    reply, _ = call("attachments.list", {"handle": handle})
    assert ok(reply) == {"entries": []}


def test_an_empty_embedded_files_tree_lists_nothing(web: None, fixture_pdf: Any) -> None:
    handle = handle_of(open_bytes(fixture_pdf("incremental_sigflags_empty_embedded").read_bytes()))
    reply, _ = call("attachments.list", {"handle": handle})
    assert ok(reply) == {"entries": []}


def test_an_attachment_over_the_limit_is_refused(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(limits, "MAX_JOB_BYTES", 10)
    handle = handle_of(open_bytes(fixture_pdf("images").read_bytes()))
    reply, _ = call("attachments.get", {"handle": handle, "name": "notes"})
    assert reply["ok"] is False
    assert reply["error"]["code"] == "FILE_TOO_LARGE"
    assert reply["error"]["details"] == {"max_bytes": 10, "size": len(NOTES)}


def state(session: DocumentSession) -> tuple[object, ...]:
    """The structure version and every page revision, plus the undo label. Two saves of an
    unchanged document are not byte-identical (the trailer's date), so the state is compared."""
    with session.lock:
        return (*document_fingerprint(session), session.undo_stack.undo_label)


def test_the_calls_leave_the_document_unchanged(web: None, fixture_pdf: Any) -> None:
    handle = handle_of(open_bytes(fixture_pdf("images").read_bytes()))
    session = REGISTRY.get(handle)
    before = state(session)

    call("attachments.list", {"handle": handle})
    call("attachments.get", {"handle": handle, "name": "notes"})

    assert state(session) == before


def test_the_attachment_survives_a_save_and_renders(
    web: None, fixture_pdf: Any, tmp_path: Path
) -> None:
    handle = handle_of(open_bytes(fixture_pdf("images").read_bytes()))
    saved = saved_copy(handle)

    record("opens_pikepdf", saved)
    record("embedded_file_name_pikepdf", saved, attachment="notes")
    record("render_first_page_pdfium", saved)

    # The same file, read back by the desktop side: the attachment is listed with its bytes.
    path = tmp_path / "saved.pdf"
    path.write_bytes(saved)
    reopened = DocumentSession.open(path)
    try:
        with reopened.lock:
            files = reopened.document.embedded_files()
            assert [(f.name, f.filename, f.size) for f in files] == [
                ("notes", "notes.txt", len(NOTES))
            ]
            assert reopened.document.extract_embedded_file("notes") == NOTES
    finally:
        with reopened.lock:
            reopened.document.close()
