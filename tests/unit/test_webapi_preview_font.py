"""The font preview of the text editor (W6.8a S2): ``services.font_preview`` and the read-only
``content.preview_font`` call. A program without a character map, or one fontTools can't read,
gives "not found" and the editor falls back to a generic family.
"""

from __future__ import annotations

import hashlib
import io
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.services import font_preview
from pdfeditor.webapi.errors import INVALID_ARGS
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.hostcheck import record
from tests.unit.test_webapi_jobs import call, call_raw, error, ok, open_data

FONT = Path(__file__).resolve().parents[1] / "fixtures" / "generated" / "fonts"
# Embedded TrueType faces with a character map (scripts/make_fixtures.py licensed_fonts).
EMBEDDED_FONT = "Free Sans Regular"


@pytest.fixture
def web() -> Iterator[None]:
    previous = model_platform.current()
    configure_web()
    try:
        yield
    finally:
        REGISTRY.close_all()
        model_platform.configure(previous)


def _font_bytes() -> bytes:
    return (FONT / "TestSans-Regular.ttf").read_bytes()


def _without_cmap(data: bytes) -> bytes:
    from fontTools.ttLib import TTFont

    font = TTFont(io.BytesIO(data))
    del font["cmap"]
    out = io.BytesIO()
    font.save(out)
    return out.getvalue()


def _preview(handle: str, font_name: str, page: int = 0) -> dict[str, Any]:
    return ok(
        call("content.preview_font", {"handle": handle, "page": page, "font_name": font_name})
    )


def _state(handle: str) -> tuple[tuple[int, ...], int, bool]:
    session = REGISTRY.get(handle)
    with session.lock:
        revisions = tuple(session.document.page(i).revision for i in range(session.page_count))
    return revisions, session.undo_stack.version, session.is_dirty


def test_a_program_with_a_character_map_is_usable() -> None:
    pytest.importorskip("fontTools")
    data = _font_bytes()
    assert font_preview.preview_font_program(data) == data


def test_a_program_without_a_character_map_is_not_usable() -> None:
    pytest.importorskip("fontTools")
    assert font_preview.preview_font_program(_without_cmap(_font_bytes())) is None


@pytest.mark.parametrize("data", [b"", b"not a font program at all"])
def test_garbage_is_not_usable(data: bytes) -> None:
    pytest.importorskip("fontTools")
    assert font_preview.preview_font_program(data) is None


def test_without_fonttools_nothing_is_usable(monkeypatch: pytest.MonkeyPatch) -> None:
    # A None entry makes ``from fontTools... import`` raise ImportError, as in the web build.
    monkeypatch.setitem(sys.modules, "fontTools", None)
    monkeypatch.setitem(sys.modules, "fontTools.ttLib", None)
    assert font_preview.preview_font_program(_font_bytes()) is None


def test_the_call_returns_the_program_of_an_embedded_font(web: None, fixture_pdf: Any) -> None:
    pytest.importorskip("fontTools")
    data = fixture_pdf("licensed_fonts").read_bytes()
    handle = open_data(data, "licensed.pdf")
    reply, buffers = call_raw(
        "content.preview_font",
        {"handle": handle, "page": 0, "font_name": EMBEDDED_FONT},
    )
    result = ok(reply)
    assert result["found"] is True
    assert result["family"] == "sans-serif"
    # The program travels as a buffer, not inline JSON, and is the embedded bytes unchanged.
    assert "$bin" in result["program"]
    program = buffers[result["program"]["$bin"]]
    # The expected bytes are the PDF's own FontFile2 stream, read with pikepdf in the host
    # check (not the engine call under test); the SHA-256 keeps the recorded arguments small.
    record(
        "font_program_sha256_pikepdf",
        data,
        resource="/F0",
        sha256=hashlib.sha256(program).hexdigest(),
    )


def test_the_call_names_the_generic_family(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    assert _preview(handle, "Courier-Bold")["family"] == "monospace"
    assert _preview(handle, "Times-Roman")["family"] == "serif"
    assert _preview(handle, "Helvetica")["family"] == "sans-serif"


def test_a_base_font_that_is_not_embedded_is_not_found(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    assert _preview(handle, "Helvetica") == {
        "found": False,
        "family": "sans-serif",
        "program": None,
    }


def test_a_subset_font_is_not_found(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("subset_fonts").read_bytes(), "subset.pdf")
    result = _preview(handle, "Droid Sans Fallback Regu")
    assert result["found"] is False
    assert result["program"] is None


def test_the_call_changes_no_document(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("licensed_fonts").read_bytes(), "licensed.pdf")
    before = _state(handle)
    _preview(handle, EMBEDDED_FONT)
    _preview(handle, "NoSuchFontAnywhere")
    assert _state(handle) == before


def test_invalid_arguments_are_refused(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    out_of_range = error(
        call("content.preview_font", {"handle": handle, "page": 99, "font_name": "Helvetica"})
    )
    assert out_of_range["code"] == INVALID_ARGS
    too_long = error(
        call("content.preview_font", {"handle": handle, "page": 0, "font_name": "x" * 257})
    )
    assert too_long["code"] == INVALID_ARGS
