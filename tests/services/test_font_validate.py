"""The uploaded-font check (W6.9 slice 1): ``services.fonts.validate_font_bytes``.

Not desktop_only: the check runs in the web worker, under Pyodide, so it must pass there too.
The fixtures are synthetic (scripts/make_fixtures.py generate_fonts), never real font programs.
"""

from __future__ import annotations

import io
import struct
import sys
from collections.abc import Callable
from pathlib import Path

import pytest
from fontTools.ttLib import TTFont

from pdfeditor.services.fonts import (
    MAX_COLLECTION_FACES,
    FontRejected,
    read_faces,
    validate_font_bytes,
)


@pytest.fixture
def fonts(fixtures_dir: Path) -> Path:
    return fixtures_dir / "fonts"


def _edited(data: bytes, edit: Callable[[TTFont], None]) -> bytes:
    """``data`` after ``edit(font)`` (a fontTools TTFont), saved again."""
    font = TTFont(io.BytesIO(data))
    edit(font)
    out = io.BytesIO()
    font.save(out)
    return out.getvalue()


def _with_fs_type(data: bytes, fs_type: int) -> bytes:
    def edit(font: TTFont) -> None:
        font["OS/2"].fsType = fs_type

    return _edited(data, edit)


def test_truetype_face_is_accepted(fonts: Path) -> None:
    data = (fonts / "TestSans-Bold.ttf").read_bytes()
    fmt, faces, refused = validate_font_bytes(data, "bold.ttf")
    assert fmt == "truetype"
    assert refused == []
    (face,) = faces
    assert (face.family, face.style, face.weight, face.index) == ("Test Sans", "Bold", 700, 0)
    assert face.scripts == frozenset({"latin"})
    assert face.embeddable and not face.variable


def test_italic_is_read_from_the_font(fonts: Path) -> None:
    _, faces, _ = validate_font_bytes((fonts / "TestSans-Italic.ttf").read_bytes(), "i.ttf")
    assert faces[0].italic is True


def test_cff_opentype_is_accepted(fonts: Path) -> None:
    fmt, faces, _ = validate_font_bytes((fonts / "TestCff-Regular.otf").read_bytes(), "c.otf")
    assert fmt == "opentype"
    assert [face.family for face in faces] == ["Test Cff"]


def test_collection_lists_each_face_in_order(fonts: Path) -> None:
    fmt, faces, refused = validate_font_bytes((fonts / "TestCollection.ttc").read_bytes(), "c.ttc")
    assert fmt == "collection"
    assert [(f.family, f.index) for f in faces] == [
        ("Test Collection One", 0),
        ("Test Collection Two", 1),
    ]
    assert refused == []


def test_mixed_collection_accepts_the_free_face_and_lists_the_refused_one(fonts: Path) -> None:
    fmt, faces, refused = validate_font_bytes(
        (fonts / "TestMixedCollection.ttc").read_bytes(), "m.ttc"
    )
    assert fmt == "collection"
    assert [f.family for f in faces] == ["Test Mixed One"]
    assert [(f.family, f.index, f.reason) for f in refused] == [("Test Mixed Two", 1, "restricted")]


def test_restricted_face_is_refused_with_its_code(fonts: Path) -> None:
    with pytest.raises(FontRejected) as caught:
        validate_font_bytes((fonts / "TestRestricted-Regular.ttf").read_bytes(), "r.ttf")
    assert caught.value.kind == "not_embeddable"
    assert caught.value.reason == "restricted"
    assert [f.reason for f in caught.value.refused] == ["restricted"]


def test_bitmap_only_face_is_refused_with_its_code(fonts: Path) -> None:
    with pytest.raises(FontRejected) as caught:
        validate_font_bytes((fonts / "TestBitmapOnly-Regular.ttf").read_bytes(), "b.ttf")
    assert (caught.value.kind, caught.value.reason) == ("not_embeddable", "bitmap_only")


def test_restricted_wins_over_bitmap_only_when_both_bits_are_set(fonts: Path) -> None:
    with pytest.raises(FontRejected) as caught:
        validate_font_bytes((fonts / "TestMixedBits-Regular.ttf").read_bytes(), "x.ttf")
    assert caught.value.reason == "restricted"


def test_preview_and_print_with_the_restricted_bit_is_refused_like_the_desktop(fonts: Path) -> None:
    with pytest.raises(FontRejected) as caught:
        validate_font_bytes((fonts / "TestPreviewRestricted-Regular.ttf").read_bytes(), "p.ttf")
    assert caught.value.reason == "restricted"


def test_a_collection_with_only_refused_faces_is_not_embeddable(fonts: Path) -> None:
    with pytest.raises(FontRejected) as caught:
        validate_font_bytes((fonts / "TestRestrictedCollection.ttc").read_bytes(), "r.ttc")
    assert caught.value.kind == "not_embeddable"
    assert len(caught.value.refused) == 2


@pytest.mark.parametrize(
    ("fs_type", "accepted"),
    [
        (0x0000, True),  # installable
        (0x0004, True),  # preview and print
        (0x0008, True),  # editable
        (0x0100, True),  # no subsetting: the desktop ignores it
        (0x0001, True),  # reserved bit: ignored
        (0x0002, False),  # restricted
        (0x0006, False),  # restricted with preview and print
        (0x0202, False),  # restricted with bitmap only
        (0x0200, False),  # bitmap embedding only
        (0x0204, False),
    ],
)
def test_fstype_rules_match_the_desktop_catalogue(
    fonts: Path, tmp_path: Path, fs_type: int, accepted: bool
) -> None:
    """The web check and the desktop catalogue read the same bits: no third copy of the rules."""
    data = _with_fs_type((fonts / "TestSans-Regular.ttf").read_bytes(), fs_type)
    path = tmp_path / "f.ttf"
    path.write_bytes(data)
    assert read_faces(path)[0].embeddable is accepted
    try:
        _, faces, _ = validate_font_bytes(data, "f.ttf")
    except FontRejected as exc:
        assert not accepted and exc.kind == "not_embeddable"
    else:
        assert accepted and len(faces) == 1


def test_a_font_without_an_os2_table_is_accepted(fonts: Path) -> None:
    def drop_os2(font: TTFont) -> None:
        del font["OS/2"]

    data = _edited((fonts / "TestSans-Regular.ttf").read_bytes(), drop_os2)
    _, faces, refused = validate_font_bytes(data, "old.ttf")
    assert len(faces) == 1 and refused == []


@pytest.mark.parametrize("magic", [b"wOFF", b"wOF2"])
def test_woff_is_refused(magic: bytes) -> None:
    with pytest.raises(FontRejected) as caught:
        validate_font_bytes(magic + bytes(64), "web.woff")
    assert (caught.value.kind, caught.value.reason) == ("invalid", "woff")


@pytest.mark.parametrize("data", [b"", b"just some text, not a font" * 4, b"\x00\x01"])
def test_non_fonts_are_not_a_font(data: bytes) -> None:
    with pytest.raises(FontRejected) as caught:
        validate_font_bytes(data, "x")
    assert caught.value.reason == "not_a_font"


def test_garbage_named_ttf_is_not_a_font(fonts: Path) -> None:
    with pytest.raises(FontRejected) as caught:
        validate_font_bytes((fonts / "Garbage.ttf").read_bytes(), "Garbage.ttf")
    assert caught.value.reason == "not_a_font"


def test_truncated_truetype_is_rejected_not_raised(fonts: Path) -> None:
    data = (fonts / "TestSans-Regular.ttf").read_bytes()[:64]
    with pytest.raises(FontRejected) as caught:
        validate_font_bytes(data, "cut.ttf")
    assert caught.value.reason in {"unreadable", "no_usable_face"}


def test_collection_header_claiming_too_many_faces_is_refused_before_parsing() -> None:
    header = b"ttcf" + struct.pack(">I", 0x00010000) + struct.pack(">I", 1_000_000)
    with pytest.raises(FontRejected) as caught:
        validate_font_bytes(header + bytes(64), "forged.ttc")
    assert caught.value.reason == "too_many_faces"


def test_a_collection_at_the_face_cap_is_not_refused_for_its_count() -> None:
    header = b"ttcf" + struct.pack(">I", 0x00010000) + struct.pack(">I", MAX_COLLECTION_FACES)
    with pytest.raises(FontRejected) as caught:
        validate_font_bytes(header, "edge.ttc")
    assert caught.value.reason != "too_many_faces"


def test_a_truncated_collection_header_is_unreadable() -> None:
    with pytest.raises(FontRejected) as caught:
        validate_font_bytes(b"ttcf\x00\x01", "short.ttc")
    assert caught.value.reason == "unreadable"


def test_a_font_without_a_character_map_has_no_usable_face(fonts: Path) -> None:
    with pytest.raises(FontRejected) as caught:
        validate_font_bytes((fonts / "TestNoCmap-Regular.ttf").read_bytes(), "nocmap.ttf")
    assert (caught.value.kind, caught.value.reason) == ("invalid", "no_usable_face")


def test_a_font_without_outlines_has_no_usable_face(fonts: Path) -> None:
    def drop_outlines(font: TTFont) -> None:
        del font["glyf"]
        del font["loca"]

    data = _edited((fonts / "TestSans-Regular.ttf").read_bytes(), drop_outlines)
    with pytest.raises(FontRejected) as caught:
        validate_font_bytes(data, "nooutline.ttf")
    assert caught.value.reason == "no_usable_face"


def test_the_outlines_are_not_decompiled(fonts: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Only the tables the checks need are read: a later change can't quietly load glyphs."""
    import fontTools.ttLib as ttlib

    opened: list[TTFont] = []
    real = ttlib.TTFont

    def recording(*args: object, **kwargs: object) -> TTFont:
        font = real(*args, **kwargs)  # type: ignore[arg-type]
        opened.append(font)
        return font

    monkeypatch.setattr(ttlib, "TTFont", recording)
    validate_font_bytes((fonts / "TestSans-Regular.ttf").read_bytes(), "s.ttf")
    (font,) = opened
    assert not font.isLoaded("glyf")
    assert not font.isLoaded("loca")


def test_a_memory_error_is_not_turned_into_a_rejection(
    fonts: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import fontTools.ttLib as ttlib

    def exhausted(*args: object, **kwargs: object) -> TTFont:
        raise MemoryError

    monkeypatch.setattr(ttlib, "TTFont", exhausted)
    with pytest.raises(MemoryError):
        validate_font_bytes((fonts / "TestSans-Regular.ttf").read_bytes(), "s.ttf")


def test_without_fonttools_the_check_raises_import_error(
    fonts: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for name in ("fontTools", "fontTools.ttLib", "fontTools.ttLib.ttCollection"):
        monkeypatch.setitem(sys.modules, name, None)
    with pytest.raises(ImportError):
        validate_font_bytes((fonts / "TestSans-Regular.ttf").read_bytes(), "s.ttf")
