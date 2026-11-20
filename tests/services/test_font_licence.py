"""Extracting embedded fonts respects their licence: the fsType bits decide what is saved."""

from __future__ import annotations

import io
import struct
from pathlib import Path
from typing import Any, cast

import pytest
from fontTools.ttLib import TTFont

from pdfeditor.engine.registry import get_engine
from pdfeditor.model.fonts import BITMAP_ONLY, RESTRICTED, licence_refusal
from pdfeditor.model.metadata import FontInfo
from pdfeditor.services.export.fonts import program_fs_type
from pdfeditor.services.export.images import _safe_file_name, extract_fonts

ENGINE = get_engine()


def _with_fs_type(program: bytes, fs_type: int) -> bytes:
    font = TTFont(io.BytesIO(program))
    font["OS/2"].fsType = fs_type
    buf = io.BytesIO()
    font.save(buf)
    return buf.getvalue()


@pytest.fixture
def fonts_dir(fixtures_dir: Path) -> Path:
    return fixtures_dir / "fonts"


@pytest.fixture
def sans(fonts_dir: Path) -> bytes:
    return (fonts_dir / "TestSans-Regular.ttf").read_bytes()


def test_fs_type_is_read_from_the_os2_table(sans: bytes) -> None:
    for value in (0, 0x0004, 0x0008, RESTRICTED, BITMAP_ONLY, RESTRICTED | BITMAP_ONLY):
        assert program_fs_type(_with_fs_type(sans, value)) == value


def test_fs_type_of_a_collection_is_the_first_face(fonts_dir: Path) -> None:
    data = (fonts_dir / "TestCollection.ttc").read_bytes()
    assert program_fs_type(data) == 0


def test_fs_type_missing_os2_table_is_none(sans: bytes) -> None:
    font = TTFont(io.BytesIO(sans))
    del font["OS/2"]
    buf = io.BytesIO()
    font.save(buf)
    assert program_fs_type(buf.getvalue()) is None


def test_fs_type_of_non_sfnt_programs_is_none() -> None:
    assert program_fs_type(b"%!PS-AdobeFont-1.0 garbage") is None  # Type1
    assert program_fs_type(b"\x01\x00\x04\x04 bare cff") is None  # CFF


def _os2_record(program: bytes) -> int:
    """The byte position of the OS/2 entry in the table directory."""
    count = struct.unpack_from(">H", program, 4)[0]
    for i in range(count):
        record = 12 + 16 * i
        if program[record : record + 4] == b"OS/2":
            return record
    raise AssertionError("no OS/2 table")


def _patched_os2(program: bytes, *, offset: int | None = None, length: int | None = None) -> bytes:
    patched = bytearray(program)
    record = _os2_record(program)
    if offset is not None:
        struct.pack_into(">I", patched, record + 8, offset)
    if length is not None:
        struct.pack_into(">I", patched, record + 12, length)
    return bytes(patched)


def test_os2_declared_length_shorter_than_fs_type_is_unreadable(
    sans: bytes, tmp_path: Path
) -> None:
    short = _patched_os2(sans, length=4)  # fsType (offset 8, 2 bytes) lies past the declared end
    with pytest.raises(ValueError):
        program_fs_type(short)
    doc = _FakeDoc([_FakeFont(1, "Short.ttf", short), _FakeFont(2, "Ok.ttf", sans)])
    result = extract_fonts(cast(Any, doc), tmp_path / "out")
    assert result.refused == [("Short.ttf", "unreadable")]
    assert [p.name for p in result.written] == ["Ok.ttf"]


def test_os2_table_extending_past_the_end_of_the_file_is_unreadable(
    sans: bytes, tmp_path: Path
) -> None:
    length_past_end = _patched_os2(sans, length=len(sans))
    with pytest.raises(ValueError):
        program_fs_type(length_past_end)
    offset_past_end = _patched_os2(sans, offset=len(sans) + 1000)
    with pytest.raises(ValueError):
        program_fs_type(offset_past_end)
    doc = _FakeDoc([_FakeFont(1, "Far.ttf", offset_past_end), _FakeFont(2, "Ok.ttf", sans)])
    result = extract_fonts(cast(Any, doc), tmp_path / "out")
    assert result.refused == [("Far.ttf", "unreadable")]
    assert [p.name for p in result.written] == ["Ok.ttf"]


def test_fs_type_past_the_end_of_the_data_is_an_error(sans: bytes) -> None:
    with pytest.raises(ValueError):
        program_fs_type(sans[:40])  # the table directory is cut short
    font = TTFont(io.BytesIO(sans))
    offset = font.reader.tables["OS/2"].offset
    with pytest.raises(ValueError):
        program_fs_type(sans[: offset + 4])  # the OS/2 record is cut short


@pytest.mark.parametrize(
    ("fs_type", "reason"),
    [
        (0, None),
        (0x0004, None),  # preview and print
        (0x0008, None),  # editable
        (None, None),  # no OS/2 table, or no fsType at all
        (RESTRICTED, "restricted"),
        (BITMAP_ONLY, "bitmap_only"),
        (RESTRICTED | BITMAP_ONLY, "restricted"),  # restricted is named first
    ],
)
def test_licence_refusal_table(fs_type: int | None, reason: str | None) -> None:
    assert licence_refusal(fs_type) == reason


def test_licensed_fonts_are_saved_only_where_the_licence_allows(
    fixture_pdf: Any, tmp_path: Path
) -> None:
    doc = ENGINE.open(fixture_pdf("licensed_fonts"))
    try:
        result = extract_fonts(doc, tmp_path / "fonts")
    finally:
        doc.close()
    assert result.not_embedded == []
    assert sorted(result.refused) == [
        ("Bitmap Sans Regular", "bitmap_only"),
        ("Mixed Sans Regular", "restricted"),
        ("Restricted Sans Regular", "restricted"),
    ]
    # the saved programs are real fonts, with their own licence bits intact
    families = sorted(TTFont(p)["name"].getDebugName(1) for p in result.written)
    assert families == ["Free Sans", "Print Sans"]
    assert {program_fs_type(p.read_bytes()) for p in result.written} == {0, 0x0004}


def test_progress_counts_refused_fonts_too(fixture_pdf: Any, tmp_path: Path) -> None:
    seen: list[tuple[int, int]] = []
    doc = ENGINE.open(fixture_pdf("licensed_fonts"))
    try:
        extract_fonts(doc, tmp_path / "fonts", progress=lambda n, total: seen.append((n, total)))
        total = len(doc.fonts())
    finally:
        doc.close()
    assert seen == [(n, total) for n in range(1, total + 1)]


class _FakeFont:
    """One font of the engine document, as extract_fonts reads it."""

    info: FontInfo
    file_name: str
    program: bytes

    def __init__(self, ref: int, file_name: str, program: bytes, embedded: bool = True) -> None:
        self.info = FontInfo(file_name, "TrueType", "", embedded, False, ref)
        self.file_name = file_name
        self.program = program


class _FakeDoc:
    def __init__(self, fonts: list[_FakeFont]) -> None:
        self._fonts = fonts

    def fonts(self) -> list[FontInfo]:
        return [f.info for f in self._fonts]

    def extract_font(self, ref: int) -> tuple[str, bytes]:
        font = next(f for f in self._fonts if f.info.ref == ref)
        if not font.info.embedded:
            raise ValueError("this font is not embedded")
        return font.file_name, font.program


def test_names_from_the_pdf_cannot_leave_the_folder(sans: bytes, tmp_path: Path) -> None:
    hostile = "../../escape.ttf"
    doc = _FakeDoc([_FakeFont(1, hostile, sans)])
    folder = tmp_path / "out"
    result = extract_fonts(cast(Any, doc), folder)
    assert len(result.written) == 1
    assert result.written[0].parent == folder
    assert ".." not in result.written[0].name and "/" not in result.written[0].name
    assert not (tmp_path / "escape.ttf").exists()


def test_safe_file_names() -> None:
    assert _safe_file_name("Free Sans Regular.ttf") == "Free Sans Regular.ttf"
    assert _safe_file_name("../../x.ttf") == "____x.ttf"
    assert _safe_file_name("a" + chr(92) + "b:c*.otf") == "a_b_c_.otf"
    assert _safe_file_name("#2F.cff") == "_2F.cff"
    assert _safe_file_name("..") == "_"
    assert _safe_file_name("") == "font"
    assert _safe_file_name("x" * 300 + ".ttf") == "x" * 100 + ".ttf"
    assert _safe_file_name("CON.ttf") == "_CON.ttf"
    assert _safe_file_name("nul") == "_nul"
    assert _safe_file_name("com1.ttf") == "_com1.ttf"
    assert _safe_file_name("LPT9.a.otf") == "_LPT9.a.otf"
    assert _safe_file_name("CONSOLE.ttf") == "CONSOLE.ttf"  # only the exact device names


@pytest.mark.parametrize(
    ("font_name", "written_name"),
    [
        ("CON.ttf", "_CON.ttf"),
        ("nul.ttf", "_nul.ttf"),
        ("COM1.otf", "_COM1.otf"),
        ("LPT9", "_LPT9"),
    ],
)
def test_reserved_device_names_are_written_as_ordinary_files(
    sans: bytes, tmp_path: Path, font_name: str, written_name: str
) -> None:
    doc = _FakeDoc([_FakeFont(1, font_name, sans)])
    result = extract_fonts(cast(Any, doc), tmp_path / "out")
    assert [p.name for p in result.written] == [written_name]
    assert result.written[0].read_bytes() == sans


def test_unreadable_os2_table_is_refused(sans: bytes, tmp_path: Path) -> None:
    broken = sans[:40]  # sfnt header, but the table directory is cut short
    doc = _FakeDoc([_FakeFont(1, "Broken.ttf", broken), _FakeFont(2, "Ok.ttf", sans)])
    result = extract_fonts(cast(Any, doc), tmp_path / "out")
    assert result.refused == [("Broken.ttf", "unreadable")]
    assert [p.name for p in result.written] == ["Ok.ttf"]


def test_fonts_without_a_program_are_not_embedded(sans: bytes, tmp_path: Path) -> None:
    doc = _FakeDoc([_FakeFont(1, "Helvetica", b"", embedded=False)])
    result = extract_fonts(cast(Any, doc), tmp_path / "out")
    assert result.not_embedded == ["Helvetica"] and result.written == [] and result.refused == []
