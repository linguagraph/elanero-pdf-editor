"""The job types of W3.7 beyond the first slice (W1.2 sections 13 and 14): ``audit``, ``export``,
``split``, ``merge``, ``compare`` and ``print_pages``, through ``jobs.prepare`` and ``job.run`` on
fixtures. The read-only types run on a copy and leave the open document alone; ``merge`` takes no
document at all (its sources are in its arguments).

The job worker runs in the same process here, as in test_webapi_jobs.py. The saved files are
checked in pikepdf and pypdfium2 through ``tests.hostcheck.record``, so this module imports
neither at module level, and Pyodide can run it too.
"""

from __future__ import annotations

import base64
import io
import json
import re
import zipfile
from collections.abc import Iterator
from dataclasses import replace
from types import SimpleNamespace
from typing import Any, cast

import pytest
from PIL import Image

from pdfeditor.core.jobs import CancelToken
from pdfeditor.core.session import DocumentSession
from pdfeditor.engine import mupdf as mupdf_engine
from pdfeditor.model import platform as model_platform
from pdfeditor.services.export.fonts import program_fs_type
from pdfeditor.webapi import dispatch, dto, jobs, jobworker, limits
from pdfeditor.webapi.errors import (
    CANCELLED,
    FILE_TOO_LARGE,
    INVALID_ARGS,
    NOT_SUPPORTED,
    RENDER_TOO_LARGE,
    RpcFailure,
)
from pdfeditor.webapi.platform import WEB_SNAPSHOT_BUDGET, configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.hostcheck import record

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
ROTATE = {"name": "pages.rotate", "args": {"pages": [0], "delta": 90}}


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


# -- helpers ----------------------------------------------------------------------------------


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


def page_total(handle: str) -> int:
    return int(ok(call("session.info", {"handle": handle}))["page_count"])


# The trailer's /ID array, whatever its spacing (writers differ between platforms). Each element
# is a hex string or a literal string, and a literal string may hold any byte, ``]`` included
# (the ID is random, so a save can produce one); the escape-aware form keeps the match whole.
_ID_PATTERN = re.compile(rb"/ID\s*\[(?:\s*(?:<[0-9A-Fa-f\s]*>|\((?:\\[\s\S]|[^\\()])*\)))*\s*\]")


def strip_id(data: bytes) -> bytes:
    """``data`` without its single trailer /ID array."""
    data, count = _ID_PATTERN.subn(b"", data)
    assert count == 1, "the saved file has no single /ID array to remove"
    return data


def test_strip_id_removes_a_literal_id_whose_bytes_include_a_bracket() -> None:
    trailer = b"<</Size 2/Root 1 0 R/ID [(9Cd&:\\(*P]x)(abc)]>>"
    assert strip_id(b"%PDF" + trailer) == b"%PDF<</Size 2/Root 1 0 R>>"
    hex_id = b"<</Root 1 0 R/ID [<00ab> <CD01>]>>"
    assert strip_id(hex_id) == b"<</Root 1 0 R>>"


def saved_bytes(handle: str) -> bytes:
    """The saved file of an open document, without its trailer /ID array. The /ID is random at each
    save, and under Pyodide the bytes around it also differ between two saves of an unchanged
    document, so the whole array is removed from both sides before a comparison.
    """
    reply, out = call_raw("save.save_bytes", {"handle": handle, "mode": "copy"})
    return strip_id(binary(ok(reply)["data"], out))


def page_text(handle: str, page: int) -> str:
    return str(ok(call("text.layer", {"handle": handle, "page": page}))["text"])


def reopened_state(data: bytes) -> tuple[int, list[str]]:
    """The page count and each page's text, read by the engine after reopening saved bytes."""
    handle = open_data(data, "reopened.pdf")
    try:
        pages = page_total(handle)
        return pages, [page_text(handle, number) for number in range(pages)]
    finally:
        call("session.close", {"handle": handle})


def prepare(
    handle: str, job: str, args: dict[str, Any], extra: list[bytes] | None = None
) -> tuple[dict[str, Any], bytes]:
    """The result of jobs.prepare, and the document copy it returned."""
    reply, out = call_raw(
        "jobs.prepare",
        {"handle": handle, "job": job, "args": args},
        extra,
    )
    result = ok(reply)
    return result, binary(result["document"], out)


def run_on_copy(
    job: str,
    args: dict[str, Any],
    copy: bytes,
    extra: list[bytes] | None = None,
    *,
    notify: Any = None,
    cancel: CancelToken | None = None,
    partial: Any = None,
) -> tuple[dict[str, Any], list[bytes]]:
    """job.run on a document copy; ``extra`` holds the buffers that ``$bin`` markers in args use
    (the copy itself is buffer 0). ``partial`` receives each partial notice and its buffers."""
    request = json.dumps(
        {
            "v": 1,
            "id": 5,
            "method": "job.run",
            "params": {"job": job, "args": args, "document": {"$bin": 0}},
        }
    )
    reply_json, out = jobworker.dispatch(request, [copy, *(extra or [])], notify, cancel, partial)
    reply: dict[str, Any] = json.loads(reply_json)
    return reply, out


def run_without_document(
    job: str, args: dict[str, Any], buffers: list[bytes] | None = None
) -> tuple[dict[str, Any], list[bytes]]:
    """job.run for a job that takes no document (merge)."""
    request = json.dumps(
        {"v": 1, "id": 5, "method": "job.run", "params": {"job": job, "args": args}}
    )
    reply_json, out = jobworker.dispatch(request, buffers or [])
    reply: dict[str, Any] = json.loads(reply_json)
    return reply, out


def apply_read_only(handle: str, token: str) -> dict[str, Any]:
    return call(
        "jobs.apply",
        {
            "handle": handle,
            "token": token,
            "document": None,
            "label": "",
            "require_full_save": False,
        },
    )


def files_of(result: dict[str, Any], out: list[bytes]) -> list[tuple[str, str, bytes]]:
    return [(item["name"], item["mime"], binary(item["data"], out)) for item in result["files"]]


def png_bytes(width: int = 120, height: int = 80) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (200, 30, 30)).save(buffer, format="PNG")
    return buffer.getvalue()


def text_fixture(fixture_pdf: Any) -> bytes:
    return bytes(fixture_pdf("text_multipage").read_bytes())


# -- read-only types: prepare, run, the result shape, and an unchanged document ---------------

READ_ONLY_CASES = [
    ("audit", {}, "report"),
    ("export", {"format": "txt"}, "files"),
    ("export", {"format": "html", "pages": [0]}, "files"),
    ("export", {"format": "png", "pages": [0]}, "files"),
    ("split", {"mode": "pages", "pages_per_file": 1}, "files"),
    ("print_pages", {"pages": [0]}, "files"),
    ("extract_images", {"name": "a.pdf"}, "files"),
    ("extract_fonts", {"name": "a.pdf"}, "files"),
]


@pytest.mark.parametrize(("job", "args", "kind"), READ_ONLY_CASES)
def test_a_read_only_type_runs_on_a_copy_and_leaves_the_document_unchanged(
    web: None, fixture_pdf: Any, job: str, args: dict[str, Any], kind: str
) -> None:
    handle = open_data(text_fixture(fixture_pdf), "text.pdf")
    session = REGISTRY.get(handle)
    # Raw save bytes differ between two saves of the same document (the /ID, and under Pyodide
    # other bytes too), so the document is compared by what it contains after a reopen.
    before = saved_bytes(handle)
    before_state = reopened_state(before)
    version = session.structure_version

    prepared, copy = prepare(handle, job, args)
    assert prepared["mutating"] is False
    assert prepared["label"] == job
    assert "password" not in prepared
    assert session.busy == ""  # a read-only job takes no task
    assert copy.startswith(b"%PDF")

    reply, _ = run_on_copy(job, args, copy)
    result = ok(reply)
    assert result["kind"] == kind
    assert result["document"] is None
    assert result["name"] == ""

    applied = ok(apply_read_only(handle, prepared["token"]))
    assert applied["applied"] is False
    after = saved_bytes(handle)  # a save after the read-only job still succeeds
    assert reopened_state(after) == before_state  # page count and each page's text
    assert before_state[0] == page_total(handle)
    record(
        "same_object_count_pikepdf",
        after,
        reference=base64.b64encode(before).decode("ascii"),
    )  # the same number of objects in the saved file
    assert session.structure_version == version
    assert session.is_dirty is False


def test_audit_reports_the_stored_size_by_category(web: None, fixture_pdf: Any) -> None:
    handle = open_data(text_fixture(fixture_pdf), "text.pdf")
    _, copy = prepare(handle, "audit", {})
    result = ok(run_on_copy("audit", {}, copy)[0])
    value = result["value"]
    assert isinstance(value["total"], int)
    assert value["total"] > 0
    assert value["categories"]
    for item in value["categories"]:
        assert set(item) == {"key", "name", "size"}
        assert item["key"] in jobs.SPACE_CATEGORY_KEYS
        assert isinstance(item["size"], int)
        # A real audit's labels all have a key: only "Other objects" is "other" by its own name.
        assert item["key"] != "other" or item["name"] == "Other objects"


def test_export_text_gives_one_text_file(web: None, fixture_pdf: Any) -> None:
    handle = open_data(text_fixture(fixture_pdf), "text.pdf")
    _, copy = prepare(handle, "export", {"format": "txt"})
    reply, out = run_on_copy("export", {"format": "txt"}, copy)
    ((name, mime, data),) = files_of(ok(reply), out)
    assert (name, mime) == ("export.txt", "text/plain")
    assert "".join(data.decode("utf-8").split())  # the fixture has text


def test_export_images_name_each_page_and_multipage_tiff_is_one_file(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_data(text_fixture(fixture_pdf), "text.pdf")
    pages = page_total(handle)
    assert pages >= 2
    args = {"format": "jpeg", "pages": [0, 1], "dpi": 150}
    _, copy = prepare(handle, "export", args)
    reply, out = run_on_copy("export", args, copy)
    # Two page images come back as one ZIP, since a reply carries one buffer to the page.
    ((name, mime, data),) = files_of(ok(reply), out)
    assert (name, mime) == ("export.zip", "application/zip")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        assert archive.namelist() == ["export-1.jpg", "export-2.jpg"]
        assert Image.open(io.BytesIO(archive.read("export-1.jpg"))).format == "JPEG"

    tiff_args = {"format": "tiff", "pages": [0, 1], "dpi": 150}
    _, copy = prepare(handle, "export", tiff_args)
    reply, out = run_on_copy("export", tiff_args, copy)
    ((name, mime, data),) = files_of(ok(reply), out)
    assert (name, mime) == ("export.tif", "image/tiff")
    assert Image.open(io.BytesIO(data)).n_frames == 2


@pytest.mark.parametrize(
    ("fmt", "name", "mime"),
    [
        ("md", "export.md", "text/markdown"),
        ("html", "export.html", "text/html"),
        ("docx", "export.docx", DOCX_MIME),
    ],
)
def test_export_markdown_html_and_word_write_their_files(
    web: None, fixture_pdf: Any, fmt: str, name: str, mime: str
) -> None:
    handle = open_data(text_fixture(fixture_pdf), "text.pdf")
    args = {"format": fmt, "pages": [0]}
    _, copy = prepare(handle, "export", args)
    reply, out = run_on_copy("export", args, copy)
    files = files_of(ok(reply), out)
    assert files[0][:2] == (name, mime)
    assert files[0][2]
    if fmt == "docx":
        # A Word file is a zip package with the main document part, written without LibreOffice.
        with zipfile.ZipFile(io.BytesIO(files[0][2])) as package:
            assert "word/document.xml" in package.namelist()


def test_split_by_pages_gives_one_pdf_per_page(web: None, fixture_pdf: Any) -> None:
    handle = open_data(text_fixture(fixture_pdf), "text.pdf")
    pages = page_total(handle)
    args = {"mode": "pages", "pages_per_file": 1}
    _, copy = prepare(handle, "split", args)
    reply, out = run_on_copy("split", args, copy)
    files = files_of(ok(reply), out)
    assert len(files) == pages
    for name, mime, data in files:
        assert name.endswith(".pdf")
        assert mime == "application/pdf"
        record("page_count_pikepdf", data, pages=1)


def test_split_by_ranges_gives_each_range_as_a_part(web: None, fixture_pdf: Any) -> None:
    handle = open_data(text_fixture(fixture_pdf), "text.pdf")
    assert page_total(handle) >= 3
    args = {"mode": "ranges", "ranges": [[0], [1, 2]]}
    _, copy = prepare(handle, "split", args)
    reply, out = run_on_copy("split", args, copy)
    files = files_of(ok(reply), out)
    assert len(files) == 2
    record("page_count_pikepdf", files[0][2], pages=1)
    record("page_count_pikepdf", files[1][2], pages=2)


# -- encrypted documents ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("job", "args"),
    [
        ("audit", {}),
        ("export", {"format": "txt"}),
        ("split", {"mode": "pages", "pages_per_file": 1}),
        ("print_pages", {"pages": [0]}),
    ],
)
def test_a_read_only_type_runs_on_the_decrypted_copy_of_an_encrypted_document(
    web: None, fixture_pdf: Any, job: str, args: dict[str, Any]
) -> None:
    handle = open_data(fixture_pdf("encrypted").read_bytes(), "encrypted.pdf", password="user")
    prepared, copy = prepare(handle, job, args)
    assert "password" not in prepared  # the job worker never gets a password
    reply, out = run_on_copy(job, args, copy)
    assert ok(reply)["kind"] in {"report", "files"}
    if job == "split":
        name, _, data = files_of(ok(reply), out)[0]
        assert name.endswith(".pdf")
        record("page_count_pikepdf", data, pages=1)


# -- merge: no handle, the sources are in the arguments ---------------------------------------


def test_merge_joins_pdf_and_image_sources_into_a_new_document(web: None, fixture_pdf: Any) -> None:
    pdf = text_fixture(fixture_pdf)
    pages = page_total(open_data(pdf, "text.pdf"))
    args = {
        "sources": [
            {"name": "first.pdf", "data": {"$bin": 0}},
            {"name": "second.pdf", "data": {"$bin": 1}, "pages": [0]},
            {"name": "picture.png", "data": {"$bin": 2}},
        ],
        "bookmarks": True,
    }
    reply, out = run_without_document("merge", args, [pdf, pdf, png_bytes()])
    result = ok(reply)
    assert result["kind"] == "new_document"
    assert result["name"] == "merged.pdf"
    assert result["files"] == []
    data = binary(result["document"], out)
    assert data.startswith(b"%PDF")
    record("page_count_pikepdf", data, pages=pages + 2)


def test_merge_leaves_the_open_documents_alone(web: None, fixture_pdf: Any) -> None:
    pdf = text_fixture(fixture_pdf)
    handle = open_data(pdf, "text.pdf")
    session = REGISTRY.get(handle)
    # Raw save bytes differ between two saves of the same document (see the read-only test), so the
    # open document is compared by what it contains after a reopen.
    before = saved_bytes(handle)
    before_state = reopened_state(before)
    version = session.structure_version
    undo_depth = len(session.undo_stack)
    args = {"sources": [{"name": "first.pdf", "data": {"$bin": 0}}]}
    reply, _ = run_without_document("merge", args, [pdf])
    assert ok(reply)["kind"] == "new_document"
    after = saved_bytes(handle)
    assert reopened_state(after) == before_state  # page count and each page's text
    assert before_state[0] == page_total(handle)
    record(
        "same_object_count_pikepdf",
        after,
        reference=base64.b64encode(before).decode("ascii"),
    )  # the same number of objects in the saved file
    assert session.structure_version == version
    assert len(session.undo_stack) == undo_depth
    assert session.is_dirty is False
    assert session.busy == ""


def test_merge_takes_no_document_and_has_no_prepare(web: None, fixture_pdf: Any) -> None:
    handle = open_data(text_fixture(fixture_pdf), "text.pdf")
    err = error(call("jobs.prepare", {"handle": handle, "job": "merge", "args": {"sources": []}}))
    assert err["code"] == INVALID_ARGS
    assert err["details"]["path"] == "params.job"
    pdf = text_fixture(fixture_pdf)
    reply, _ = run_on_copy(
        "merge", {"sources": [{"name": "a.pdf", "data": {"$bin": 1}}]}, pdf, [pdf]
    )
    assert error(reply)["code"] == INVALID_ARGS
    assert error(reply)["details"]["path"] == "params.document"


# -- compare ----------------------------------------------------------------------------------


def test_compare_of_a_document_with_itself_is_identical(web: None, fixture_pdf: Any) -> None:
    pdf = text_fixture(fixture_pdf)
    handle = open_data(pdf, "text.pdf")
    pages = page_total(handle)
    prepared, copy = prepare(handle, "compare", {"other": {"$bin": 0}}, [pdf])
    assert prepared["mutating"] is False
    args = {"other": {"$bin": 1}, "text": True, "visual": True}
    reply, _ = run_on_copy("compare", args, copy, [pdf])
    value = ok(reply)["value"]
    assert ok(reply)["kind"] == "report"
    assert value["identical"] is True
    assert value["changes"] == []
    assert value["pairs"] == [[n, n] for n in range(pages)]


def test_compare_reports_a_changed_page(web: None, fixture_pdf: Any) -> None:
    pdf = text_fixture(fixture_pdf)
    handle = open_data(pdf, "text.pdf")
    _, old_copy = prepare(handle, "compare", {"other": {"$bin": 0}}, [pdf])
    # The newer document is the same file with its first page rotated, saved after the prepare.
    rotated = call(
        "actions.run", {"handle": handle, "name": ROTATE["name"], "args": ROTATE["args"]}
    )
    assert ok(rotated)["executed"] is True
    newer = saved_bytes(handle)
    reply, _ = run_on_copy("compare", {"other": {"$bin": 1}}, old_copy, [newer])
    value = ok(reply)["value"]
    assert value["identical"] is False
    assert value["changes"]
    kinds = {change["kind"] for change in value["changes"]}
    assert kinds <= {"inserted", "deleted", "replaced", "visual", "page inserted", "page deleted"}


# -- print_pages ------------------------------------------------------------------------------


def print_pages_of(
    handle: str, args: dict[str, Any]
) -> tuple[dict[str, Any], list[tuple[str, str, bytes]]]:
    """Runs print_pages and collects the pages from their partial notices, in order."""
    _, copy = prepare(handle, "print_pages", args)
    pages: list[tuple[str, str, bytes]] = []

    def partial(notice: dict[str, Any], out: list[bytes]) -> None:
        data = notice["data"]
        pages.append((data["name"], data["mime"], out[0]))

    reply, _ = run_on_copy("print_pages", args, copy, partial=partial)
    return ok(reply), pages


def test_print_pages_renders_each_page_as_a_png(web: None, fixture_pdf: Any) -> None:
    handle = open_data(text_fixture(fixture_pdf), "text.pdf")
    pages = page_total(handle)
    _, low_pages = print_pages_of(handle, {"pages": [0], "dpi": 150})
    ((name, mime, data),) = low_pages
    assert (name, mime) == ("page-1.png", "image/png")
    low = Image.open(io.BytesIO(data))
    assert low.format == "PNG"

    _, high_pages = print_pages_of(handle, {"pages": [0], "dpi": 300})
    ((_, _, data300),) = high_pages
    high = Image.open(io.BytesIO(data300))
    assert abs(high.width - 2 * low.width) <= 2  # 300 dpi is twice 150 dpi

    result, every = print_pages_of(handle, {})
    assert len(every) == pages
    assert every[0][0].startswith("page-")
    assert result["value"] == {"pages": pages}


def test_print_pages_sends_each_page_as_a_partial_in_order(web: None, fixture_pdf: Any) -> None:
    handle = open_data(text_fixture(fixture_pdf), "text.pdf")
    sizes_by_dpi: dict[int, dict[int, tuple[int, int]]] = {}
    for dpi in (150, 300):
        partials: list[dict[str, Any]] = []
        sizes: dict[int, tuple[int, int]] = {}

        def partial(
            notice: dict[str, Any],
            out: list[bytes],
            *,
            _sizes: dict[int, tuple[int, int]] = sizes,
            _partials: list[dict[str, Any]] = partials,
        ) -> None:
            # One buffer per partial: the page's PNG, under its own marker.
            assert len(out) == 1
            _partials.append(notice)
            _sizes[notice["data"]["index"]] = Image.open(io.BytesIO(out[0])).size

        args = {"pages": [0, 1], "dpi": dpi}
        _, copy = prepare(handle, "print_pages", args)
        reply, out = run_on_copy("print_pages", args, copy, partial=partial)
        result = ok(reply)
        assert result["files"] == [] and out == []  # the pages came as partials
        assert result["value"] == {"pages": 2}
        assert [item["notice"] for item in partials] == ["partial", "partial"]
        assert [item["data"]["index"] for item in partials] == [0, 1]
        assert [item["data"]["name"] for item in partials] == ["page-1.png", "page-2.png"]
        assert all(item["v"] == 1 and item["id"] == 5 for item in partials)
        sizes_by_dpi[dpi] = sizes
    # 300 dpi is twice 150 dpi, page by page.
    assert abs(sizes_by_dpi[300][0][0] - 2 * sizes_by_dpi[150][0][0]) <= 2


def test_print_pages_without_a_partial_sink_still_replies_with_the_count(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_data(text_fixture(fixture_pdf), "text.pdf")
    args = {"pages": [0]}
    _, copy = prepare(handle, "print_pages", args)
    reply, out = run_on_copy("print_pages", args, copy)
    assert ok(reply)["value"] == {"pages": 1}
    assert out == []


def test_a_print_cancelled_after_its_first_partial_sends_no_more(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_data(text_fixture(fixture_pdf), "text.pdf")
    args = {"pages": [0, 1]}
    _, copy = prepare(handle, "print_pages", args)
    token = CancelToken()
    received: list[dict[str, Any]] = []

    def partial(notice: dict[str, Any], _out: list[bytes]) -> None:
        received.append(notice)
        token.cancel()  # the next check in the job stops it

    reply, _ = run_on_copy("print_pages", args, copy, cancel=token, partial=partial)
    assert error(reply)["code"] == CANCELLED
    assert len(received) == 1


def test_print_partials_stop_at_the_byte_cap(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle = open_data(text_fixture(fixture_pdf), "text.pdf")
    args = {"pages": [0, 1]}
    _, copy = prepare(handle, "print_pages", args)
    # A one-byte cap, so the first page's PNG takes the job over it whatever the sizes are. The
    # job function runs directly, since jobworker would refuse the copy itself against the same cap.
    monkeypatch.setattr(limits, "MAX_JOB_BYTES", 1)
    session = DocumentSession.open(copy, None, snapshot_budget=WEB_SNAPSHOT_BUDGET)
    reported: list[dto.FileDto] = []
    ctx = SimpleNamespace(
        token=CancelToken(),
        report=reported.append,
        progress=lambda done, total: None,
    )
    try:
        with pytest.raises(RpcFailure) as failure:
            jobs._run_print(session, dto.PrintArgs(pages=(0, 1)), cast(Any, ctx))
    finally:
        session.close()
    assert failure.value.code == FILE_TOO_LARGE
    # The cap is checked before a page is reported, so no partial went out.
    assert reported == []


def test_print_pages_can_be_cancelled_before_it_starts(web: None, fixture_pdf: Any) -> None:
    handle = open_data(text_fixture(fixture_pdf), "text.pdf")
    _, copy = prepare(handle, "print_pages", {"pages": [0]})
    token = CancelToken()
    token.cancel()
    reply, _ = run_on_copy("print_pages", {"pages": [0]}, copy, cancel=token)
    assert error(reply)["code"] == CANCELLED


def test_a_split_cancelled_during_its_run_stops_after_the_first_part(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_data(text_fixture(fixture_pdf), "text.pdf")
    args = {"mode": "pages", "pages_per_file": 1}
    _, copy = prepare(handle, "split", args)
    token = CancelToken()
    notices: list[dict[str, Any]] = []

    def notify(notice: dict[str, Any]) -> None:
        notices.append(notice)
        token.cancel()  # the next check in the job stops it

    reply, _ = run_on_copy("split", args, copy, notify=notify, cancel=token)
    assert error(reply)["code"] == CANCELLED
    assert len(notices) == 1


def test_a_print_over_the_pixel_limit_is_refused(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle = open_data(text_fixture(fixture_pdf), "text.pdf")
    _, copy = prepare(handle, "print_pages", {"pages": [0]})
    monkeypatch.setattr(limits, "MAX_RENDER_PIXELS", 10)
    err = error(run_on_copy("print_pages", {"pages": [0]}, copy)[0])
    assert err["code"] == RENDER_TOO_LARGE
    assert err["details"]["max_pixels"] == 10


# -- errors -----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("job", "args", "path"),
    [
        ("audit", {"extra": 1}, "args.extra"),  # an unknown field
        ("export", {}, "args.format"),  # a missing field
        ("export", {"format": "xlsx"}, "args.format"),  # not an export format
        ("export", {"format": "png", "dpi": 72}, "args.dpi"),
        ("split", {"mode": "bogus"}, "args.mode"),
        ("split", {"mode": "pages", "pages_per_file": 0}, "args.pages_per_file"),
        ("split", {"mode": "size", "max_bytes": 0}, "args.max_bytes"),
        ("compare", {}, "args.other"),  # the newer document is required
        ("print_pages", {"dpi": 200}, "args.dpi"),
    ],
)
def test_a_bad_argument_is_invalid_args_with_its_path(
    web: None, fixture_pdf: Any, job: str, args: dict[str, Any], path: str
) -> None:
    handle = open_data(text_fixture(fixture_pdf), "text.pdf")
    err = error(call("jobs.prepare", {"handle": handle, "job": job, "args": args}))
    assert err["code"] == INVALID_ARGS
    assert err["details"]["path"] == path
    assert len(jobs.PREPARED) == 0  # a bad spec begins no task and keeps no token


def test_a_page_out_of_range_is_invalid_args_when_the_job_runs(web: None, fixture_pdf: Any) -> None:
    handle = open_data(text_fixture(fixture_pdf), "text.pdf")
    pages = page_total(handle)
    _, copy = prepare(handle, "export", {"format": "txt"})
    args = {"format": "txt", "pages": [pages]}
    err = error(run_on_copy("export", args, copy)[0])
    assert err["code"] == INVALID_ARGS
    assert err["details"]["path"] == "args.pages"


def test_an_out_of_range_split_range_is_invalid_args(web: None, fixture_pdf: Any) -> None:
    handle = open_data(text_fixture(fixture_pdf), "text.pdf")
    pages = page_total(handle)
    args = {"mode": "ranges", "ranges": [[pages]]}
    _, copy = prepare(handle, "split", args)
    err = error(run_on_copy("split", args, copy)[0])
    assert err["code"] == INVALID_ARGS
    assert err["details"]["path"] == "args.ranges"


# -- merge: per-source page ranges (the page-range rule, W6.3a) -------------------------------


def test_merge_ranges_round_trip_keeps_the_chosen_pages_and_bookmarks(
    web: None, fixture_pdf: Any
) -> None:
    outline = fixture_pdf("outline").read_bytes()
    args = {
        "sources": [
            {"name": "outline.pdf", "data": {"$bin": 0}, "ranges": "2-4"},
            {"name": "pic.png", "data": {"$bin": 1}},
        ]
    }
    reply, out = run_without_document("merge", args, [outline, png_bytes()])
    data = binary(ok(reply)["document"], out)
    # Pages 2-4 of the outline (three pages) and the picture: four pages in document order.
    record("page_count_pikepdf", data, pages=4)
    record(
        "outline_pdfium",
        data,
        rows=[
            [1, "outline", 0],
            [2, "Section 1.2", 0],  # its chapter was left out: promoted one level
            [2, "Chapter 2", 1],
            [3, "Section 2.1", 1],
            [3, "Section 2.2", 2],
            [1, "pic", 3],
        ],
    )
    record("text_contains_pdfium", data, page=0, text="Chapter 1, section 2")
    record("text_lacks_pdfium", data, page=0, text="Chapter 1, section 1")
    record("text_contains_pdfium", data, page=2, text="Chapter 2, section 2")


def test_merge_ranges_blank_or_all_takes_every_page(web: None, fixture_pdf: Any) -> None:
    pdf = text_fixture(fixture_pdf)
    pages = page_total(open_data(pdf, "text.pdf"))
    args = {
        "sources": [
            {"name": "a.pdf", "data": {"$bin": 0}, "ranges": "  "},
            {"name": "b.pdf", "data": {"$bin": 1}, "ranges": "ALL"},
        ]
    }
    reply, out = run_without_document("merge", args, [pdf, pdf])
    record("page_count_pikepdf", binary(ok(reply)["document"], out), pages=pages * 2)


def test_a_range_past_the_end_is_invalid_args_with_kind_and_page_count(
    web: None, fixture_pdf: Any
) -> None:
    pdf = text_fixture(fixture_pdf)
    pages = page_total(open_data(pdf, "text.pdf"))
    args = {
        "sources": [
            {"name": "first.pdf", "data": {"$bin": 0}},
            {"name": "second.pdf", "data": {"$bin": 1}, "ranges": f"1, {pages + 1}"},
        ]
    }
    err = error(run_without_document("merge", args, [pdf, pdf])[0])
    assert err["code"] == INVALID_ARGS
    assert err["details"] == {
        "path": "args.sources[1].ranges",
        "reason": "page_range",
        "kind": "out_of_range",
        "item": str(pages + 1),
        "page_count": pages,
    }


@pytest.mark.parametrize(
    ("ranges", "kind", "item"),
    [("3-2", "invalid", "3-2"), ("x", "invalid", "x"), ("+3", "invalid", "+3"), (",", "empty", "")],
)
def test_a_malformed_range_is_invalid_args_with_its_kind(
    web: None, fixture_pdf: Any, ranges: str, kind: str, item: str
) -> None:
    pdf = text_fixture(fixture_pdf)
    args = {"sources": [{"name": "a.pdf", "data": {"$bin": 0}, "ranges": ranges}]}
    err = error(run_without_document("merge", args, [pdf])[0])
    assert err["code"] == INVALID_ARGS
    assert err["details"]["path"] == "args.sources[0].ranges"
    assert err["details"]["reason"] == "page_range"
    assert err["details"]["kind"] == kind
    assert err["details"]["item"] == item


def test_ranges_that_clash_with_pages_or_suit_no_image_are_invalid_args(web: None) -> None:
    both = {"sources": [{"name": "a.pdf", "data": {"$bin": 0}, "pages": [0], "ranges": "1"}]}
    assert error(run_without_document("merge", both, [b"%PDF"])[0])["details"]["path"] == (
        "args.sources[0].ranges"
    )
    picture = {"sources": [{"name": "a.png", "data": {"$bin": 0}, "ranges": "1"}]}
    assert error(run_without_document("merge", picture, [png_bytes()])[0])["code"] == INVALID_ARGS
    long = {"sources": [{"name": "a.pdf", "data": {"$bin": 0}, "ranges": "1," * 1001}]}
    assert error(run_without_document("merge", long, [b"%PDF"])[0])["code"] == INVALID_ARGS


@pytest.mark.parametrize("pages", [[], [99]])
def test_pages_that_pick_nothing_are_invalid_args_naming_the_source(
    web: None, fixture_pdf: Any, pages: list[int]
) -> None:
    pdf = text_fixture(fixture_pdf)
    pages_total = page_total(open_data(pdf, "text.pdf"))
    args = {
        "sources": [
            {"name": "first.pdf", "data": {"$bin": 0}},
            {"name": "second.pdf", "data": {"$bin": 1}, "pages": pages},
        ]
    }
    err = error(run_without_document("merge", args, [pdf, pdf])[0])
    assert err["code"] == INVALID_ARGS
    assert err["details"] == {"path": "args.sources[1].pages", "page_count": pages_total}


def test_a_merge_source_that_is_not_a_pdf_or_image_is_invalid_args(web: None) -> None:
    args = {"sources": [{"name": "notes.txt", "data": {"$bin": 0}}]}
    err = error(run_without_document("merge", args, [b"hello"])[0])
    assert err["code"] == INVALID_ARGS
    assert err["details"]["path"] == "args.sources[0].name"


def test_a_merge_without_sources_is_invalid_args(web: None) -> None:
    err = error(run_without_document("merge", {"sources": []})[0])
    assert err["code"] == INVALID_ARGS
    assert err["details"]["path"] == "args.sources"


def test_an_unknown_job_type_is_invalid_args_at_prepare_and_run(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_data(text_fixture(fixture_pdf), "text.pdf")
    err = error(call("jobs.prepare", {"handle": handle, "job": "no_such_job", "args": {}}))
    assert err["code"] == INVALID_ARGS
    assert err["details"]["path"] == "params.job"
    err = error(run_on_copy("no_such_job", {}, text_fixture(fixture_pdf))[0])
    assert err["code"] == INVALID_ARGS
    assert err["details"]["path"] == "params.job"


# -- comments_export: the Comments panel's three exports, read-only -------------------------------

ANNOTATED = "annotations"  # one page with a sticky note ("A sticky note") and other annotations
CSV_HEADER = "Page,Type,Author,Date,Status,Comment,Reply to"


def comments_handle(fixture_pdf: Any, name: str = ANNOTATED) -> str:
    return open_data(fixture_pdf(name).read_bytes(), "notes.pdf")


def export_comments(handle: str, fmt: str, name: str = "notes.pdf") -> tuple[dict[str, Any], bytes]:
    """Prepares and runs comments_export on a copy; returns the job's result and its file."""
    args = {"format": fmt, "name": name}
    _, copy = prepare(handle, "comments_export", args)
    reply, out = run_on_copy("comments_export", args, copy)
    ((_, _, data),) = files_of(ok(reply), out)
    return ok(reply), data


@pytest.mark.parametrize(
    ("fmt", "file_name", "mime"),
    [
        ("xfdf", "notes.xfdf", "application/vnd.adobe.xfdf"),
        ("csv", "notes-comments.csv", "text/csv"),
        ("pdf", "notes-comments.pdf", "application/pdf"),
    ],
)
def test_comments_export_gives_one_named_file_per_format(
    web: None, fixture_pdf: Any, fmt: str, file_name: str, mime: str
) -> None:
    handle = comments_handle(fixture_pdf)
    result, data = export_comments(handle, fmt)
    ((name, got_mime, _),) = files_of(result, [data])
    assert (name, got_mime) == (file_name, mime)
    assert len(data) > 0
    assert result["kind"] == "files"


def test_the_csv_export_has_a_bom_and_the_panels_header(web: None, fixture_pdf: Any) -> None:
    handle = comments_handle(fixture_pdf)
    _, data = export_comments(handle, "csv")
    assert data.startswith(bytes([0xEF, 0xBB, 0xBF]))  # the BOM the desktop writes
    lines = data.decode("utf-8-sig").splitlines()
    assert lines[0] == CSV_HEADER
    assert any("A sticky note" in line for line in lines[1:])


def test_the_xfdf_export_names_the_document_and_holds_the_comment(
    web: None, fixture_pdf: Any
) -> None:
    handle = comments_handle(fixture_pdf)
    _, data = export_comments(handle, "xfdf", name="Quarterly Review.pdf")
    text = data.decode("utf-8")
    assert text.startswith("<?xml")
    assert "A sticky note" in text
    assert '<f href="Quarterly Review.pdf"' in text
    assert 'xmlns="http://ns.adobe.com/xfdf/"' in text


def test_the_summary_pdf_holds_the_comment_text(web: None, fixture_pdf: Any) -> None:
    handle = comments_handle(fixture_pdf)
    _, data = export_comments(handle, "pdf")
    assert data.startswith(b"%PDF")
    record("text_contains_pdfium", data, page=0, text="A sticky note")
    record("page_count_pikepdf", data, pages=1)


def test_an_empty_document_still_exports_its_summary(web: None, fixture_pdf: Any) -> None:
    handle = open_data(text_fixture(fixture_pdf), "text.pdf")
    _, data = export_comments(handle, "csv", name="text.pdf")
    lines = data.decode("utf-8-sig").splitlines()
    assert lines == [CSV_HEADER]


def annotations_of(handle: str) -> list[tuple[int, Any]]:
    """Every page's annotations, in page order, read through the open document."""
    session = REGISTRY.get(handle)
    with session.lock:
        return [
            (index, annotation)
            for index in range(session.document.page_count)
            for annotation in session.document.page(index).annotations()
        ]


def test_a_comments_export_leaves_the_document_and_its_undo_stack_alone(
    web: None, fixture_pdf: Any
) -> None:
    handle = comments_handle(fixture_pdf)
    session = REGISTRY.get(handle)
    before = (
        page_total(handle),
        session.undo_stack.is_clean,
        session.structure_version,
        saved_bytes(handle),
        annotations_of(handle),
    )
    assert before[4], "the fixture should carry annotations for this check to mean anything"
    args = {"format": "xfdf", "name": "notes.pdf"}
    prepared, copy = prepare(handle, "comments_export", args)
    assert prepared["mutating"] is False
    reply, _ = run_on_copy("comments_export", args, copy)
    assert ok(reply)["kind"] == "files"
    applied = ok(apply_read_only(handle, prepared["token"]))
    assert applied["applied"] is False
    after = (
        page_total(handle),
        session.undo_stack.is_clean,
        session.structure_version,
        saved_bytes(handle),
        annotations_of(handle),
    )
    assert after == before


def test_an_empty_name_exports_under_the_document_fallback(web: None, fixture_pdf: Any) -> None:
    handle = comments_handle(fixture_pdf)
    result, data = export_comments(handle, "csv", name="")
    ((name, _, _),) = files_of(result, [data])
    assert name == "document-comments.csv"


def test_the_pdf_export_is_refused_when_the_engine_cannot_lay_out_html(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle = comments_handle(fixture_pdf)
    args = {"format": "pdf", "name": "notes.pdf"}
    _, copy = prepare(handle, "comments_export", args)
    # The engine reads its capability set from this module at each access, so the job's
    # worker (same process here) sees the switched-off flag.
    monkeypatch.setattr(
        mupdf_engine,
        "_CAPABILITIES",
        replace(mupdf_engine._CAPABILITIES, html_layout=False),
    )
    reply, _ = run_on_copy("comments_export", args, copy)
    assert error(reply)["code"] == NOT_SUPPORTED


def test_a_comments_export_of_an_encrypted_document_uses_the_decrypted_copy(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_data(fixture_pdf("encrypted").read_bytes(), "encrypted.pdf", password="user")
    prepared, copy = prepare(handle, "comments_export", {"format": "csv", "name": "encrypted.pdf"})
    assert "password" not in prepared
    reply, out = run_on_copy("comments_export", {"format": "csv", "name": "encrypted.pdf"}, copy)
    ((name, _, data),) = files_of(ok(reply), out)
    assert name == "encrypted-comments.csv"
    assert data.decode("utf-8-sig").splitlines()[0] == CSV_HEADER


def test_a_comments_export_cancelled_before_it_starts_is_cancelled(
    web: None, fixture_pdf: Any
) -> None:
    handle = comments_handle(fixture_pdf)
    args = {"format": "pdf", "name": "notes.pdf"}
    _, copy = prepare(handle, "comments_export", args)
    token = CancelToken()
    token.cancel()
    reply, _ = run_on_copy("comments_export", args, copy, cancel=token)
    assert error(reply)["code"] == CANCELLED


def test_a_comments_export_with_an_unknown_format_is_invalid_args(
    web: None, fixture_pdf: Any
) -> None:
    handle = comments_handle(fixture_pdf)
    err = error(
        call(
            "jobs.prepare",
            {"handle": handle, "job": "comments_export", "args": {"format": "docx", "name": "a"}},
        )
    )
    assert err["code"] == INVALID_ARGS
    assert err["details"]["path"] == "args.format"
    assert len(jobs.PREPARED) == 0


# -- extract_images (W4.15): the document's images, as stored, read-only -----------------------


def images_bytes(fixture_pdf: Any) -> bytes:
    return bytes(fixture_pdf("images").read_bytes())


def test_extract_images_saves_each_image_as_stored(web: None, fixture_pdf: Any) -> None:
    handle = open_data(images_bytes(fixture_pdf), "images.pdf")
    args = {"name": "images.pdf"}
    _, copy = prepare(handle, "extract_images", args)
    reply, out = run_on_copy("extract_images", args, copy)
    result = ok(reply)
    files = files_of(result, out)
    count = result["value"]["count"]
    assert result["value"]["too_large"] == 0
    assert count >= 1
    assert len(files) >= 1
    for name, mime, data in files:
        assert re.fullmatch(r"page\d+-image\d+\.(jpg|png|tiff|bmp|gif)", name) or name.endswith(
            "-images.zip"
        ), name
        assert mime in {
            "image/jpeg",
            "image/png",
            "image/tiff",
            "image/bmp",
            "image/gif",
            "application/zip",
        }
        assert data


def test_extract_images_of_several_images_is_one_flat_stored_zip(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_data(bytes(fixture_pdf("several_images").read_bytes()), "My: Report.pdf")
    args = {"name": "My: Report.pdf"}
    _, copy = prepare(handle, "extract_images", args)
    reply, out = run_on_copy("extract_images", args, copy)
    result = ok(reply)
    assert result["value"] == {"count": 3, "too_large": 0}
    ((name, mime, data),) = files_of(result, out)
    assert (name, mime) == ("My_ Report-images.zip", "application/zip")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = archive.namelist()
        assert len(names) == 3
        assert all("/" not in n and re.fullmatch(r"page\d+-image\d+\.\w+", n) for n in names)
        assert all(info.compress_type == zipfile.ZIP_STORED for info in archive.infolist())


def test_extract_images_of_one_page_takes_only_its_images(web: None, fixture_pdf: Any) -> None:
    handle = open_data(bytes(fixture_pdf("several_images").read_bytes()), "several.pdf")
    args = {"name": "several.pdf", "pages": [1]}
    _, copy = prepare(handle, "extract_images", args)
    reply, out = run_on_copy("extract_images", args, copy)
    ((name, mime, data),) = files_of(ok(reply), out)
    assert (name, mime) == ("page2-image1.png", "image/png")
    assert Image.open(io.BytesIO(data)).size == (228, 220)


def test_extract_images_of_a_page_with_no_images_is_empty(web: None, fixture_pdf: Any) -> None:
    handle = open_data(text_fixture(fixture_pdf), "text.pdf")
    args = {"name": "text.pdf", "pages": [0]}
    _, copy = prepare(handle, "extract_images", args)
    reply, _ = run_on_copy("extract_images", args, copy)
    result = ok(reply)
    assert result["files"] == []
    assert result["value"] == {"count": 0, "too_large": 0}


def test_extract_images_pages_must_be_non_empty_and_in_range(web: None, fixture_pdf: Any) -> None:
    handle = open_data(images_bytes(fixture_pdf), "images.pdf")
    for pages, path in (([], "args.pages"), ([999], "args.pages")):
        args = {"name": "images.pdf", "pages": pages}
        _, copy = prepare(handle, "extract_images", args)
        err = error(run_on_copy("extract_images", args, copy)[0])
        assert err["code"] == INVALID_ARGS
        assert err["details"]["path"] == path


def test_an_image_above_the_pixel_ceiling_is_skipped_and_counted(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle = open_data(images_bytes(fixture_pdf), "images.pdf")
    args = {"name": "images.pdf"}
    _, copy = prepare(handle, "extract_images", args)
    before = ok(run_on_copy("extract_images", args, copy)[0])["value"]["count"]
    monkeypatch.setattr(limits, "MAX_RENDER_PIXELS", 10)
    result = ok(run_on_copy("extract_images", args, copy)[0])
    assert result["files"] == []
    assert result["value"] == {"count": 0, "too_large": before}


def test_extract_images_can_be_cancelled_before_it_starts(web: None, fixture_pdf: Any) -> None:
    handle = open_data(images_bytes(fixture_pdf), "images.pdf")
    args = {"name": "images.pdf"}
    _, copy = prepare(handle, "extract_images", args)
    token = CancelToken()
    token.cancel()
    reply, _ = run_on_copy("extract_images", args, copy, cancel=token)
    assert error(reply)["code"] == CANCELLED


@pytest.mark.parametrize("name", ["..", ".", "..."])
def test_a_dot_only_document_name_gives_a_zip_name_that_does_not_start_with_a_dot(
    web: None, fixture_pdf: Any, name: str
) -> None:
    # Several images, so the job answers with one ZIP whose name comes from the stem.
    handle = open_data(bytes(fixture_pdf("several_images").read_bytes()), name)
    args = {"name": name}
    _, copy = prepare(handle, "extract_images", args)
    reply, out = run_on_copy("extract_images", args, copy)
    ((zip_name, _, _),) = files_of(ok(reply), out)
    assert not zip_name.startswith(".")
    assert zip_name == "document-images.zip"


# -- extract_fonts (W4.16): the embedded fonts whose licence allows saving them, read-only ------


def licensed_fonts_bytes(fixture_pdf: Any) -> bytes:
    return bytes(fixture_pdf("licensed_fonts").read_bytes())


def test_extract_fonts_refuses_a_font_whose_licence_forbids_it(web: None, fixture_pdf: Any) -> None:
    handle = open_data(licensed_fonts_bytes(fixture_pdf), "licensed.pdf")
    args = {"name": "licensed.pdf"}
    _, copy = prepare(handle, "extract_fonts", args)
    reply, out = run_on_copy("extract_fonts", args, copy)
    result = ok(reply)
    # the refused fonts are reported by name, and nothing is saved for them
    assert result["value"] == {
        "saved": ["Free Sans Regular.ttf", "Print Sans Regular.ttf"],
        "not_embedded": [],
        "refused": [
            {"name": "Bitmap Sans Regular", "reason": "bitmap_only"},
            {"name": "Mixed Sans Regular", "reason": "restricted"},
            {"name": "Restricted Sans Regular", "reason": "restricted"},
        ],
    }
    ((name, mime, data),) = files_of(result, out)
    assert (name, mime) == ("licensed-fonts.zip", "application/zip")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        assert sorted(archive.namelist()) == [
            "Free Sans Regular.ttf",
            "Print Sans Regular.ttf",
        ]
        # each saved program reads back as the TrueType font it was, with its own fsType
        fs_types = {program_fs_type(archive.read(n)) for n in archive.namelist()}
    assert fs_types == {0, 0x0004}


def test_extract_fonts_of_a_document_without_embedded_fonts(web: None, fixture_pdf: Any) -> None:
    handle = open_data(text_fixture(fixture_pdf), "text.pdf")
    args = {"name": "text.pdf"}
    _, copy = prepare(handle, "extract_fonts", args)
    reply, _ = run_on_copy("extract_fonts", args, copy)
    result = ok(reply)
    assert result["files"] == []
    assert result["value"]["saved"] == []
    assert result["value"]["refused"] == []
    # the base-14 fonts have no program in the file, so they are named as not embedded
    assert result["value"]["not_embedded"]


# -- split: document order, names, ZIP, the output cap and the preview (W6.2) -------------------


def test_split_by_bookmarks_gives_the_parts_in_document_order(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("outline_unsorted").read_bytes(), "unsorted.pdf")
    args = {"mode": "bookmarks", "name": "Report.pdf"}
    _, copy = prepare(handle, "split", args)
    reply, out = run_on_copy("split", args, copy)
    names = [name for name, _, _ in files_of(ok(reply), out)]
    # Document order, not alphabetical: "Zebra" comes after "Intro", and the second "Appendix"
    # gets its own name.
    assert names == [
        "Report_Intro.pdf",
        "Report_Zebra.pdf",
        "Report_Appendix.pdf",
        "Report_Appendix (2).pdf",
    ]


@pytest.mark.parametrize(
    ("name", "stem"),
    [("Report.pdf", "Report"), ("", "document"), ("...", "document")],
)
def test_the_part_names_take_the_document_name_as_their_stem(
    web: None, fixture_pdf: Any, name: str, stem: str
) -> None:
    handle = open_data(text_fixture(fixture_pdf), "text.pdf")
    args = {"mode": "pages", "pages_per_file": 1, "name": name}
    _, copy = prepare(handle, "split", args)
    reply, out = run_on_copy("split", args, copy)
    names = [file_name for file_name, _, _ in files_of(ok(reply), out)]
    assert names[0] == f"{stem}_part1.pdf"


def test_split_as_zip_gives_one_stored_archive_of_the_parts(web: None, fixture_pdf: Any) -> None:
    handle = open_data(text_fixture(fixture_pdf), "text.pdf")
    pages = page_total(handle)
    args = {"mode": "pages", "pages_per_file": 1, "name": "Report.pdf", "zip": True}
    _, copy = prepare(handle, "split", args)
    reply, out = run_on_copy("split", args, copy)
    files = files_of(ok(reply), out)
    assert [(name, mime) for name, mime, _ in files] == [("Report-split.zip", "application/zip")]
    part_names = [f"Report_part{number}.pdf" for number in range(1, pages + 1)]
    with zipfile.ZipFile(io.BytesIO(files[0][2])) as archive:
        assert all(info.compress_type == zipfile.ZIP_STORED for info in archive.infolist())
    record("zip_parts_pdf", files[0][2], names=part_names, pages=[1] * pages)


def test_a_split_with_one_part_as_zip_is_the_pdf_itself(web: None, fixture_pdf: Any) -> None:
    handle = open_data(text_fixture(fixture_pdf), "text.pdf")
    args = {"mode": "ranges", "ranges": [[0, 1]], "name": "Report.pdf", "zip": True}
    _, copy = prepare(handle, "split", args)
    reply, out = run_on_copy("split", args, copy)
    files = files_of(ok(reply), out)
    assert len(files) == 1
    assert files[0][1] == "application/pdf"
    record("page_count_pikepdf", files[0][2], pages=2)


def test_a_split_over_the_output_cap_stops_before_the_next_part(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle = open_data(text_fixture(fixture_pdf), "text.pdf")
    args = {"mode": "pages", "pages_per_file": 1}
    _, copy = prepare(handle, "split", args)
    monkeypatch.setattr(limits, "MAX_SPLIT_BYTES", 1)
    notices: list[dict[str, Any]] = []
    reply, _ = run_on_copy("split", args, copy, notify=notices.append)
    err = error(reply)
    assert err["code"] == FILE_TOO_LARGE
    assert err["details"]["max_bytes"] == 1
    assert len(notices) < page_total(handle)


def test_split_plan_gives_the_names_and_pages_the_job_writes(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("outline_unsorted").read_bytes(), "unsorted.pdf")
    before = ok(call("session.info", {"handle": handle}))
    cases: list[dict[str, Any]] = [
        {"mode": "pages", "pages_per_file": 2},
        {"mode": "ranges", "ranges": [[0], [1, 2]]},
        {"mode": "bookmarks"},
    ]
    for case in cases:
        params = {"handle": handle, "name": "Report.pdf", **case}
        plan = ok(call("split.plan", params))["parts"]
        _, copy = prepare(handle, "split", {**case, "name": "Report.pdf"})
        reply, out = run_on_copy("split", {**case, "name": "Report.pdf"}, copy)
        files = files_of(ok(reply), out)
        assert [part["name"] for part in plan] == [name for name, _, _ in files]
        assert [part["page_count"] for part in plan] == [
            reopened_state(data)[0] for _, _, data in files
        ]
    # The preview writes nothing: the document reads the same as before.
    assert ok(call("session.info", {"handle": handle})) == before


def test_split_plan_refuses_a_size_split_and_bad_pages(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("outline_unsorted").read_bytes(), "unsorted.pdf")
    size = call("split.plan", {"handle": handle, "mode": "size", "name": ""})
    assert error(size)["code"] == INVALID_ARGS
    ranges = call("split.plan", {"handle": handle, "mode": "ranges", "ranges": [[9]], "name": ""})
    assert error(ranges)["code"] == INVALID_ARGS
