"""Page marks in the browser (W7.3, slice A): ``marks.list`` reads the marks the document has,
``marks.get`` reads the settings of one kind (so an Update opens with them), and the ``marks.*``
actions run as mutating action jobs (W1.2 section 13) with one undoable step each.

Every saved file is checked on its own, through ``tests.hostcheck.record``: pikepdf and pypdfium2
are independent of MuPDF, and this module imports neither at module level (the host replay runs
it under Pyodide).
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from pdfeditor.core.session import DocumentSession
from pdfeditor.model import platform as model_platform
from pdfeditor.model.color import BLACK
from pdfeditor.model.fonts import FontRef
from pdfeditor.model.geometry import Point
from pdfeditor.model.pages import MarkKind, TextStamp
from pdfeditor.services import stamping
from pdfeditor.webapi import dispatch, jobs, jobworker
from pdfeditor.webapi.errors import INVALID_ARGS
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.hostcheck import record

RED = {"r": 1.0, "g": 0.0, "b": 0.0}
PAGE_CENTRE = [200.0, 300.0, 400.0, 500.0]  # pixels, as the host checks take a clip
PAGE_CORNER = [0.0, 0.0, 60.0, 60.0]


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
    request = json.dumps({"v": 1, "id": 3, "method": method, "params": params})
    reply_json, out = dispatch(request, buffers or [])
    return json.loads(reply_json), out


def ok(reply: dict[str, Any]) -> dict[str, Any]:
    assert reply["ok"] is True, reply
    result: dict[str, Any] = reply["result"]
    return result


def binary(value: dict[str, Any], out: list[bytes]) -> bytes:
    assert set(value) == {"$bin"}
    return out[value["$bin"]]


def open_bytes(data: bytes, name: str) -> str:
    reply, _ = call_raw(
        "session.open", {"name": name, "data": {"$bin": 0}, "password": None}, [data]
    )
    return str(ok(reply)["handle"])


def marks_list(handle: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = ok(call_raw("marks.list", {"handle": handle})[0])["items"]
    return items


def run_mark(handle: str, name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Runs a marks action as the web does (prepare, job, apply) and returns the job's result."""
    action = {"name": name, "args": args}
    reply, out = call_raw("jobs.prepare", {"handle": handle, "job": "action", "args": action})
    prepared = ok(reply)
    assert prepared["mutating"] is True
    copy = binary(prepared["document"], out)

    job_reply = json.dumps(
        {
            "v": 1,
            "id": 5,
            "method": "job.run",
            "params": {"job": "action", "args": action, "document": {"$bin": 0}},
        }
    )
    job_json, job_out = jobworker.dispatch(job_reply, [copy], None, None)
    result = ok(json.loads(job_json))
    assert result["kind"] == "document"

    reply, _ = call_raw(
        "jobs.apply",
        {
            "handle": handle,
            "token": prepared["token"],
            "document": {"$bin": 0},
            "label": result["label"],
            "require_full_save": result["require_full_save"],
        },
        [binary(result["document"], job_out)],
    )
    assert ok(reply)["applied"] is True
    return dict(result)


def save(handle: str) -> bytes:
    reply, out = call_raw("save.save_bytes", {"handle": handle, "mode": "copy"})
    assert ok(reply)["verified"] is True
    return out[0]


def reopen_check(saved: bytes, tmp_path: Path) -> None:
    """The saved file opens on the desktop side too (MuPDF)."""
    path = tmp_path / "marked.pdf"
    path.write_bytes(saved)
    reopened = DocumentSession.open(path)
    try:
        with reopened.lock:
            assert reopened.document.page_count == 5
    finally:
        with reopened.lock:
            reopened.document.close()


def header_args() -> dict[str, Any]:
    return {
        "spec": {
            "texts": {"header_left": "<<file>>", "footer_right": "Page <<page>> of <<pages>>"},
            "font": "tiro",
            "font_size": 8.0,
            "color": {"r": 0.2, "g": 0.3, "b": 0.4},
        },
        "pages": [0, 1],
        "file_name": "report.pdf",
        "bates": False,
        "replace_existing": False,
    }


def bates_args() -> dict[str, Any]:
    return {
        "spec": {
            "texts": {"footer_right": "<<bates>>"},
            "bates_prefix": "ABC",
            "bates_start": 1,
            "bates_digits": 6,
        },
        "pages": [0, 1],
        "file_name": "report.pdf",
        "bates": True,
        "replace_existing": False,
    }


def watermark_args() -> dict[str, Any]:
    return {
        "spec": {"text": "CONFIDENTIAL", "font_size": 60.0, "color": RED, "opacity": 1.0},
        "pages": [0],
        "replace_existing": False,
    }


def background_args() -> dict[str, Any]:
    return {"color": RED, "opacity": 1.0, "pages": [0], "replace_existing": False}


def test_marks_list_is_empty_for_a_plain_document(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf("text_multipage").read_bytes(), "text_multipage.pdf")
    assert marks_list(handle) == []


def test_header_footer_lists_its_kind_and_pages(
    web: None, fixture_pdf: Any, tmp_path: Path
) -> None:
    handle = open_bytes(fixture_pdf("text_multipage").read_bytes(), "text_multipage.pdf")
    result = run_mark(handle, "marks.header_footer", header_args())
    assert result["label"] == "Add Header & Footer"
    assert result["value"] == 4  # two texts on two pages

    assert marks_list(handle) == [{"kind": "HeaderFooter", "pages": 2, "foreign": False}]

    saved = save(handle)
    record("opens_pikepdf", saved)
    record("page_count_pikepdf", saved, pages=5)
    record("text_contains_pdfium", saved, page=0, text="Page 1 of 5")
    record("text_contains_pdfium", saved, page=0, text="report.pdf")
    record("render_first_page_pdfium", saved)
    reopen_check(saved, tmp_path)


def test_bates_numbers_are_a_separate_kind(web: None, fixture_pdf: Any, tmp_path: Path) -> None:
    handle = open_bytes(fixture_pdf("text_multipage").read_bytes(), "text_multipage.pdf")
    run_mark(handle, "marks.header_footer", header_args())
    run_mark(handle, "marks.header_footer", bates_args())

    kinds = {item["kind"]: item["pages"] for item in marks_list(handle)}
    assert kinds == {"HeaderFooter": 2, "Bates": 2}

    saved = save(handle)
    record("opens_pikepdf", saved)
    record("text_contains_pdfium", saved, page=0, text="ABC000001")
    record("text_contains_pdfium", saved, page=1, text="ABC000002")
    reopen_check(saved, tmp_path)


def test_watermark_is_drawn_and_removed(web: None, fixture_pdf: Any, tmp_path: Path) -> None:
    handle = open_bytes(fixture_pdf("text_multipage").read_bytes(), "text_multipage.pdf")
    result = run_mark(handle, "marks.watermark", watermark_args())
    assert result["label"] == "Add Watermark"
    assert marks_list(handle) == [{"kind": "Watermark", "pages": 1, "foreign": False}]

    saved = save(handle)
    record("opens_pikepdf", saved)
    record("text_contains_pdfium", saved, page=0, text="CONFIDENTIAL")
    record("red_pixels_pdfium", saved, page=0, clip=PAGE_CENTRE, minimum=0)
    reopen_check(saved, tmp_path)

    removed = run_mark(handle, "marks.remove", {"kind": "Watermark"})
    assert removed["value"] == 1
    assert marks_list(handle) == []

    saved = save(handle)
    record("opens_pikepdf", saved)
    record("text_lacks_pdfium", saved, page=0, text="CONFIDENTIAL")
    reopen_check(saved, tmp_path)


def test_background_colour_is_painted(web: None, fixture_pdf: Any, tmp_path: Path) -> None:
    handle = open_bytes(fixture_pdf("text_multipage").read_bytes(), "text_multipage.pdf")
    result = run_mark(handle, "marks.background", background_args())
    assert result["label"] == "Add Background"
    assert marks_list(handle) == [{"kind": "Background", "pages": 1, "foreign": False}]

    saved = save(handle)
    record("opens_pikepdf", saved)
    record("render_first_page_pdfium", saved)
    record("red_pixels_pdfium", saved, page=0, clip=PAGE_CORNER, minimum=0)
    reopen_check(saved, tmp_path)


def test_undo_restores_the_document_without_the_mark(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf("text_multipage").read_bytes(), "text_multipage.pdf")
    run_mark(handle, "marks.header_footer", header_args())
    assert marks_list(handle) != []

    reply, _ = call_raw("actions.undo", {"handle": handle})
    assert ok(reply)["done"] is True
    assert marks_list(handle) == []


def test_bad_args_name_their_path(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf("text_multipage").read_bytes(), "text_multipage.pdf")

    unknown_slot = header_args()
    unknown_slot["spec"]["texts"] = {"middle": "x"}
    for args in (unknown_slot, {k: v for k, v in header_args().items() if k != "pages"}):
        reply, _ = call_raw(
            "jobs.prepare",
            {
                "handle": handle,
                "job": "action",
                "args": {"name": "marks.header_footer", "args": args},
            },
        )
        assert reply["ok"] is False
        assert reply["error"]["code"] == INVALID_ARGS
        assert "path" in reply["error"]["details"]


def mark_get(handle: str, kind: str) -> dict[str, Any]:
    result: dict[str, Any] = ok(call_raw("marks.get", {"handle": handle, "kind": kind})[0])
    return result


def test_mark_get_is_not_found_for_a_plain_document(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf("text_multipage").read_bytes(), "text_multipage.pdf")
    found = mark_get(handle, "HeaderFooter")
    assert found == {
        "found": False,
        "pages": [],
        "ranges": "",
        "foreign": False,
        "header_footer": None,
        "watermark": None,
        "background": None,
        "font_dropped": False,
    }


def test_mark_get_returns_the_header_footer_settings_and_ranges(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_bytes(fixture_pdf("text_multipage").read_bytes(), "text_multipage.pdf")
    args = header_args()
    args["pages"] = [0, 1, 3]
    run_mark(handle, "marks.header_footer", args)

    found = mark_get(handle, "HeaderFooter")
    assert found["found"] is True
    assert found["pages"] == [0, 1, 3]
    assert found["ranges"] == "1-2, 4"
    assert found["foreign"] is False
    assert found["watermark"] is None and found["background"] is None
    spec = found["header_footer"]
    assert spec["header_left"] == "<<file>>"
    assert spec["footer_right"] == "Page <<page>> of <<pages>>"
    assert spec["header_center"] == "" and spec["footer_left"] == ""
    assert spec["font"] == "tiro"
    assert spec["font_size"] == 8.0
    assert spec["color"] == {"r": 0.2, "g": 0.3, "b": 0.4}
    assert spec["margin_x"] == 36.0 and spec["margin_top"] == 24.0
    assert spec["bates_start"] == 1 and spec["bates_digits"] == 6


def test_mark_get_reads_the_bates_kind_on_its_own(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf("text_multipage").read_bytes(), "text_multipage.pdf")
    run_mark(handle, "marks.header_footer", bates_args())

    assert mark_get(handle, "HeaderFooter")["found"] is False
    bates = mark_get(handle, "Bates")
    assert bates["found"] is True
    assert bates["header_footer"]["footer_right"] == "<<bates>>"
    assert bates["header_footer"]["bates_prefix"] == "ABC"


def test_mark_get_returns_the_watermark_settings(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf("text_multipage").read_bytes(), "text_multipage.pdf")
    run_mark(handle, "marks.watermark", watermark_args())

    spec = mark_get(handle, "Watermark")["watermark"]
    assert spec == {
        "text": "CONFIDENTIAL",
        "image": False,
        "image_name": "",
        "font": "hebo",
        "font_size": 60.0,
        "color": RED,
        "opacity": 1.0,
        "angle": 45.0,
        "scale": 0.5,
        "on_top": True,
    }


def test_mark_get_returns_the_background_settings(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf("text_multipage").read_bytes(), "text_multipage.pdf")
    run_mark(handle, "marks.background", background_args())

    found = mark_get(handle, "Background")
    assert found["background"] == {"color": RED, "opacity": 1.0}
    assert found["ranges"] == "1"


def test_mark_get_is_not_found_after_a_remove(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf("text_multipage").read_bytes(), "text_multipage.pdf")
    run_mark(handle, "marks.watermark", watermark_args())
    run_mark(handle, "marks.remove", {"kind": "Watermark"})
    assert mark_get(handle, "Watermark")["found"] is False


def test_mark_get_reports_an_uploaded_font_as_its_family(web: None, fixture_pdf: Any) -> None:
    # The web cannot draw an uploaded font, so a stored one is set up here on the desktop side:
    # the mark's text uses Times-Bold, and its settings name a font file.
    handle = open_bytes(fixture_pdf("text_multipage").read_bytes(), "text_multipage.pdf")
    spec = stamping.Watermark(
        text="CONFIDENTIAL", font="tibo", font_ref=FontRef.file("C:/fonts/Uploaded.ttf")
    )
    session = REGISTRY.get(handle)
    with session.lock:
        page = session.document.page(0)
        page.stamp_text(
            TextStamp(
                "CONFIDENTIAL",
                Point(100, 300),
                60.0,
                "tibo",
                BLACK,
                0.3,
                45.0,
                True,
                MarkKind.WATERMARK,
            )
        )
        page.set_mark_settings(MarkKind.WATERMARK, stamping.watermark_settings(spec))

    found = mark_get(handle, "Watermark")
    assert found["watermark"]["font"] == "tibo"
    assert found["font_dropped"] is True


def test_mark_get_leaves_unreadable_settings_out(web: None, fixture_pdf: Any) -> None:
    handle = open_bytes(fixture_pdf("text_multipage").read_bytes(), "text_multipage.pdf")
    session = REGISTRY.get(handle)
    with session.lock:
        page = session.document.page(0)
        page.stamp_text(
            TextStamp(
                "CONFIDENTIAL",
                Point(100, 300),
                60.0,
                "helv",
                BLACK,
                0.3,
                45.0,
                True,
                MarkKind.WATERMARK,
            )
        )
        page.set_mark_settings(MarkKind.WATERMARK, "not json")

    found = mark_get(handle, "Watermark")
    assert found["found"] is True
    assert found["pages"] == [0]
    assert found["watermark"] is None


def test_mark_get_reports_acrobat_marks_as_foreign_with_no_settings(
    web: None, fixture_pdf: Any
) -> None:
    # The Acrobat-style watermark is another tool's: it is found, but none of its settings is read.
    handle = open_bytes(fixture_pdf("page_marks_acrobat_like").read_bytes(), "acrobat.pdf")
    found = mark_get(handle, "Watermark")
    assert found["found"] is True
    assert found["foreign"] is True
    assert found["pages"] == [0]
    assert found["ranges"] == "1"
    assert found["watermark"] is None
    assert found["header_footer"] is None
    assert found["background"] is None
    assert found["font_dropped"] is False
