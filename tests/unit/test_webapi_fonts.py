"""The ``fonts.validate`` call (W6.9 slice 1): the reply and each stable error code.

The bytes travel as one ``$bin`` buffer; the call takes no handle, so it gives no events.
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path
from typing import Any

import pytest

from pdfeditor.webapi import limits
from pdfeditor.webapi.errors import (
    FILE_TOO_LARGE,
    FONT_NOT_EMBEDDABLE,
    INVALID_ARGS,
    INVALID_FONT,
    NOT_SUPPORTED,
    OUT_OF_MEMORY,
)
from tests.unit.test_webapi_jobs import call, error, ok

FONTS = Path(__file__).resolve().parents[1] / "fixtures" / "generated" / "fonts"


def _validate(name: str, data: bytes) -> dict[str, Any]:
    return call("fonts.validate", {"name": name, "data": {"$bin": 0}}, [data])


def _fixture(name: str) -> bytes:
    return (FONTS / name).read_bytes()


def test_a_truetype_file_gives_its_faces() -> None:
    reply = _validate("Test Sans Bold.ttf", _fixture("TestSans-Bold.ttf"))
    result = ok(reply)
    assert result["format"] == "truetype"
    assert result["refused"] == []
    (face,) = result["faces"]
    assert face == {
        "index": 0,
        "family": "Test Sans",
        "style": "Bold",
        "weight": 700,
        "italic": False,
        "scripts": ["latin"],
        "variable": False,
    }
    assert reply["events"] == []


def test_a_cff_opentype_file_is_opentype() -> None:
    result = ok(_validate("cff.otf", _fixture("TestCff-Regular.otf")))
    assert result["format"] == "opentype"
    assert [face["family"] for face in result["faces"]] == ["Test Cff"]


def test_a_collection_lists_every_face_with_its_index() -> None:
    result = ok(_validate("coll.ttc", _fixture("TestCollection.ttc")))
    assert result["format"] == "collection"
    assert [(face["family"], face["index"]) for face in result["faces"]] == [
        ("Test Collection One", 0),
        ("Test Collection Two", 1),
    ]


def test_a_mixed_collection_lists_its_refused_face() -> None:
    result = ok(_validate("mixed.ttc", _fixture("TestMixedCollection.ttc")))
    assert [face["family"] for face in result["faces"]] == ["Test Mixed One"]
    assert result["refused"] == [
        {"index": 1, "family": "Test Mixed Two", "style": "Regular", "reason": "restricted"}
    ]


def test_a_restricted_font_is_font_not_embeddable_with_its_reason() -> None:
    err = error(_validate("r.ttf", _fixture("TestRestricted-Regular.ttf")))
    assert err["code"] == FONT_NOT_EMBEDDABLE
    assert err["details"] == {"reason": "restricted", "faces": 1}


def test_a_restricted_collection_counts_its_refused_faces() -> None:
    err = error(_validate("r.ttc", _fixture("TestRestrictedCollection.ttc")))
    assert err["code"] == FONT_NOT_EMBEDDABLE
    assert err["details"] == {"reason": "restricted", "faces": 2}


def test_a_bitmap_only_font_reports_bitmap_only() -> None:
    err = error(_validate("b.ttf", _fixture("TestBitmapOnly-Regular.ttf")))
    assert err == {
        "code": FONT_NOT_EMBEDDABLE,
        "message": err["message"],
        "details": {"reason": "bitmap_only", "faces": 1},
    }


@pytest.mark.parametrize(
    ("data", "reason"),
    [
        (b"", "not_a_font"),
        (_fixture("Garbage.ttf"), "not_a_font"),
        (b"wOFF" + bytes(64), "woff"),
        (b"ttcf" + struct.pack(">II", 0x00010000, 1_000_000) + bytes(64), "too_many_faces"),
        (_fixture("TestNoCmap-Regular.ttf"), "no_usable_face"),
    ],
)
def test_an_unusable_file_is_invalid_font_with_a_reason(data: bytes, reason: str) -> None:
    err = error(_validate("x.bin", data))
    assert err["code"] == INVALID_FONT
    assert err["details"] == {"reason": reason}


def test_the_size_is_checked_before_any_parsing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(limits, "MAX_FONT_BYTES", 100)
    import pdfeditor.webapi.fontstore as webapi_fonts  # the shared reader of fonts.add

    def must_not_parse(*args: object, **kwargs: object) -> None:
        raise AssertionError("an over-size font was parsed")

    monkeypatch.setattr(webapi_fonts, "validate_font_bytes", must_not_parse)
    data = _fixture("TestSans-Regular.ttf")
    err = error(_validate("big.ttf", data))
    assert err["code"] == FILE_TOO_LARGE
    assert err["details"] == {"max_bytes": 100, "size": len(data)}


def test_the_default_limit_is_fifty_mebibytes() -> None:
    assert limits.MAX_FONT_BYTES == 50 * 1024 * 1024


@pytest.mark.parametrize("name", ["", "x" * 256])
def test_a_name_outside_one_to_255_characters_is_invalid_args(name: str) -> None:
    err = error(_validate(name, _fixture("TestSans-Regular.ttf")))
    assert err["code"] == INVALID_ARGS


def test_a_name_of_255_characters_is_accepted() -> None:
    ok(_validate("n" * 255, _fixture("TestSans-Regular.ttf")))


def test_a_missing_data_buffer_is_invalid_args() -> None:
    reply = call("fonts.validate", {"name": "x.ttf"})
    assert error(reply)["code"] == INVALID_ARGS


def test_an_unused_buffer_is_invalid_args() -> None:
    reply = call(
        "fonts.validate",
        {"name": "x.ttf", "data": {"$bin": 0}},
        [_fixture("TestSans-Regular.ttf"), b"extra"],
    )
    assert error(reply)["code"] == INVALID_ARGS


def test_without_fonttools_the_call_is_not_supported(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("fontTools", "fontTools.ttLib", "fontTools.ttLib.ttCollection"):
        monkeypatch.setitem(sys.modules, name, None)
    err = error(_validate("x.ttf", _fixture("TestSans-Regular.ttf")))
    assert err["code"] == NOT_SUPPORTED


def test_a_memory_error_is_out_of_memory(monkeypatch: pytest.MonkeyPatch) -> None:
    import pdfeditor.webapi.fontstore as webapi_fonts  # the shared reader of fonts.add

    def exhausted(*args: object, **kwargs: object) -> None:
        raise MemoryError

    monkeypatch.setattr(webapi_fonts, "validate_font_bytes", exhausted)
    err = error(_validate("x.ttf", _fixture("TestSans-Regular.ttf")))
    assert err["code"] == OUT_OF_MEMORY
