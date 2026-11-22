"""The read-only document facts and the font list of W7.6 (slice S1), through dispatch.

``session.info`` carries the file facts (PDF version, tagged, forms, JavaScript, repaired, XMP),
``session.fonts`` lists the fonts with their pages, and neither changes the document. The saved
bytes are reopened in pikepdf and rendered in pypdfium2 (the round-trip rule in AGENTS.md); those
checks go through ``tests.hostcheck.record`` so the Pyodide replay runs them too.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from typing import Any

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.webapi import dispatch
from pdfeditor.webapi.events import state_of
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
OWNER_PW = "owner"
USER_PW = "user"


@pytest.fixture
def web() -> Iterator[None]:
    previous = model_platform.current()
    configure_web()
    try:
        yield
    finally:
        REGISTRY.close_all()
        model_platform.configure(previous)


def call_raw(
    method: str, params: dict[str, Any], buffers: list[bytes] | None = None
) -> tuple[dict[str, Any], list[bytes]]:
    request = json.dumps({"v": 1, "id": 13, "method": method, "params": params})
    reply_json, out = dispatch(request, buffers or [])
    return json.loads(reply_json), out


def ok(reply: dict[str, Any]) -> dict[str, Any]:
    assert reply["ok"] is True, reply
    result: dict[str, Any] = reply["result"]
    return result


def open_bytes(data: bytes, password: str | None = None) -> tuple[str, dict[str, Any]]:
    reply, _ = call_raw(
        "session.open",
        {"name": "doc.pdf", "data": {"$bin": 0}, "password": password},
        [data],
    )
    result = ok(reply)
    return str(result["handle"]), dict(result["info"])


def info(handle: str) -> dict[str, Any]:
    result: dict[str, Any] = ok(call_raw("session.info", {"handle": handle})[0])
    return result


def fonts(handle: str) -> dict[str, Any]:
    result: dict[str, Any] = ok(call_raw("session.fonts", {"handle": handle})[0])
    return result


def set_title(handle: str, title: str) -> dict[str, Any]:
    current = info(handle)
    metadata = {key: current[key] for key in INFO_KEYS}
    metadata["title"] = title
    reply, _ = call_raw(
        "actions.run",
        {
            "handle": handle,
            "name": "document.set_metadata",
            "args": {"metadata": metadata},
        },
    )
    result: dict[str, Any] = ok(reply)
    assert result["executed"] is True
    return result


def save(handle: str, mode: str) -> tuple[dict[str, Any], bytes]:
    reply, out = call_raw("save.save_bytes", {"handle": handle, "mode": mode})
    result = ok(reply)
    assert result["verified"] is True
    return result, out[result["data"]["$bin"]]


# -- session.info: the file facts -----------------------------------------------------------


def test_info_carries_the_file_facts_of_a_plain_document(web: None, fixture_pdf: Any) -> None:
    handle, opened = open_bytes(fixture_pdf("text_multipage").read_bytes())
    result = info(handle)
    assert re.fullmatch(r"\d\.\d", result["pdf_version"])
    assert result["pdf_version"] == opened["pdf_version"]
    assert result["is_tagged"] is False
    assert result["has_forms"] is False
    assert result["has_javascript"] is False
    assert result["is_repaired"] is False
    assert isinstance(result["has_xmp"], bool)
    assert result["encrypted"] is False


def test_info_flags_a_tagged_file_and_a_file_with_forms(web: None, fixture_pdf: Any) -> None:
    tagged, _ = open_bytes(fixture_pdf("tagged").read_bytes())
    assert info(tagged)["is_tagged"] is True
    forms, _ = open_bytes(fixture_pdf("annotations_form").read_bytes())
    assert info(forms)["has_forms"] is True


def test_info_of_an_encrypted_file_reports_the_encryption_and_the_version(
    web: None, fixture_pdf: Any
) -> None:
    handle, _ = open_bytes(fixture_pdf("encrypted").read_bytes(), USER_PW)
    result = info(handle)
    assert result["encrypted"] is True
    assert re.fullmatch(r"\d\.\d", result["pdf_version"])


# -- session.fonts ---------------------------------------------------------------------------


def test_fonts_lists_each_font_with_its_pages(web: None, fixture_pdf: Any) -> None:
    handle, _ = open_bytes(fixture_pdf("text_multipage").read_bytes())
    pages = info(handle)["page_count"]
    rows = fonts(handle)["fonts"]
    assert rows, "a text file uses at least one font"
    for row in rows:
        assert set(row) == {"name", "type", "encoding", "embedded", "subset", "pages"}
        assert row["pages"] == sorted(row["pages"])
        assert all(isinstance(p, int) and 0 <= p < pages for p in row["pages"])
        assert row["pages"], "a listed font is used on at least one page"
        assert "ref" not in row  # the engine object id never reaches the page
    names = [row["name"].casefold() for row in rows]
    assert names == sorted(names)


def test_fonts_of_an_image_only_file_is_empty(web: None, fixture_pdf: Any) -> None:
    handle, _ = open_bytes(fixture_pdf("scanned").read_bytes())
    assert fonts(handle) == {"fonts": []}


def test_fonts_of_a_closed_handle_is_no_document(web: None, fixture_pdf: Any) -> None:
    handle, _ = open_bytes(fixture_pdf("text_multipage").read_bytes())
    REGISTRY.close(handle)
    reply, _ = call_raw("session.fonts", {"handle": handle})
    assert reply["ok"] is False
    assert reply["error"]["code"] == "NO_DOCUMENT"


def test_fonts_is_refused_while_a_task_runs_and_reads_still_work(
    web: None, fixture_pdf: Any
) -> None:
    handle, _ = open_bytes(fixture_pdf("text_multipage").read_bytes())
    session = REGISTRY.get(handle)
    session.begin_task("OCR")
    try:
        reply, _ = call_raw("session.fonts", {"handle": handle})
        assert reply["ok"] is False
        assert reply["error"]["code"] == "BUSY"
        assert reply["error"]["details"] == {"task": "OCR"}
        assert info(handle)["page_count"] > 0
    finally:
        session.end_task("OCR")
    assert fonts(handle)["fonts"]


# -- the read changes nothing -------------------------------------------------------------------


def test_reads_leave_the_document_state_unchanged(web: None, fixture_pdf: Any) -> None:
    handle, _ = open_bytes(fixture_pdf("text_multipage").read_bytes())
    session = REGISTRY.get(handle)
    before = state_of(session)
    info(handle)
    fonts(handle)
    call_raw("session.security", {"handle": handle})
    assert state_of(session) == before
    assert before.dirty is False and before.can_undo is False


# -- round trips on a signed and an encrypted file ----------------------------------------------


def test_signed_round_trip_keeps_the_signature_and_the_facts(web: None, fixture_pdf: Any) -> None:
    original = fixture_pdf("undo_signed_catalog").read_bytes()
    handle, _ = open_bytes(original)
    before = info(handle)
    assert before["has_signatures"] is True
    set_title(handle, "Signed title")
    result, saved = save(handle, "in_place")
    assert result["incremental"] is True
    assert saved.startswith(original)  # the signed byte range is untouched
    record("docinfo_title_pikepdf", saved, title="Signed title")
    record("xmp_dc_title_pikepdf", saved, title="Signed title")
    record("pdf_version_pikepdf", saved, version=before["pdf_version"])
    record("opens_pdfium", saved)
    reopened, _ = open_bytes(saved)
    after = info(reopened)
    assert after["pdf_version"] == before["pdf_version"]
    assert after["has_signatures"] is True
    assert after["title"] == "Signed title"


def test_encrypted_round_trip_reads_back_with_the_password(web: None, fixture_pdf: Any) -> None:
    handle, _ = open_bytes(fixture_pdf("encrypted").read_bytes(), USER_PW)
    unlocked = ok(call_raw("session.unlock_owner", {"handle": handle, "password": OWNER_PW})[0])
    assert unlocked["unlocked"] is True
    set_title(handle, "Secret title")
    result, saved = save(handle, "copy")
    assert result["verified"] is True
    record("docinfo_title_pikepdf", saved, title="Secret title", password=USER_PW)
    record("xmp_dc_title_pikepdf", saved, title="Secret title", password=USER_PW)
    record("render_first_page_pdfium", saved, password=USER_PW)
    reopened, _ = open_bytes(saved, USER_PW)
    assert info(reopened)["encrypted"] is True
    assert info(reopened)["title"] == "Secret title"


def test_full_save_keeps_the_pdf_version(web: None, fixture_pdf: Any) -> None:
    # The Advanced panel shows the version as text only, so a full (non-incremental) save must
    # keep the version the file reported. Pinned in MuPDF and in pikepdf (the round-trip rule).
    handle, _ = open_bytes(fixture_pdf("text_multipage").read_bytes())
    version = info(handle)["pdf_version"]
    assert re.fullmatch(r"\d\.\d", version)
    set_title(handle, "Versioned title")
    result, saved = save(handle, "copy")
    assert result["incremental"] is False
    record("pdf_version_pikepdf", saved, version=version)
    record("opens_pdfium", saved)
    reopened, _ = open_bytes(saved)
    assert info(reopened)["pdf_version"] == version


def test_full_save_of_an_encrypted_file_keeps_the_pdf_version(web: None, fixture_pdf: Any) -> None:
    handle, _ = open_bytes(fixture_pdf("encrypted").read_bytes(), USER_PW)
    version = info(handle)["pdf_version"]
    assert re.fullmatch(r"\d\.\d", version)
    ok(call_raw("session.unlock_owner", {"handle": handle, "password": OWNER_PW})[0])
    set_title(handle, "Versioned secret")
    result, saved = save(handle, "copy")
    assert result["incremental"] is False
    record("pdf_version_pikepdf", saved, version=version, password=USER_PW)
    reopened, _ = open_bytes(saved, USER_PW)
    assert info(reopened)["pdf_version"] == version


def test_an_empty_info_block_adds_no_xmp_packet(web: None, fixture_pdf: Any) -> None:
    handle, _ = open_bytes(fixture_pdf("text_multipage").read_bytes())
    if info(handle)["has_xmp"]:
        pytest.skip("the fixture already carries an XMP packet")
    reply, _ = call_raw(
        "actions.run",
        {
            "handle": handle,
            "name": "document.set_metadata",
            "args": {"metadata": {key: "" for key in INFO_KEYS}},
        },
    )
    assert ok(reply)["executed"] is True
    _, saved = save(handle, "copy")
    record("no_xmp_pikepdf", saved)
