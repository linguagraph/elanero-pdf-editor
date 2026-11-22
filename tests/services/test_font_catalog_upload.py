"""The web's font catalogue (W6.9 slice 2b): :func:`read_upload_faces` applies the validator's
rules, and a :class:`FontCatalog` built with it lists only the faces an action may use.

Not ``desktop_only``: it reads the generated fixtures from a temporary folder, which works under
Pyodide as well.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from pdfeditor.model.fonts import FontRef
from pdfeditor.services.fonts import (
    FontCatalog,
    FontFace,
    FontRejected,
    read_faces,
    read_upload_faces,
    validate_font_bytes,
)

FONTS = Path(__file__).resolve().parents[1] / "fixtures" / "generated" / "fonts"


def test_a_mixed_collection_gives_only_its_embeddable_face(tmp_path: Path) -> None:
    path = tmp_path / "mixed.ttc"
    shutil.copy(FONTS / "TestMixedCollection.ttc", path)
    faces = read_upload_faces(path)
    assert [face.family for face in faces] == ["Test Mixed One"]
    assert all(face.embeddable for face in faces)


def test_a_restricted_font_gives_no_faces(tmp_path: Path) -> None:
    path = tmp_path / "restricted.ttf"
    shutil.copy(FONTS / "TestRestricted-Regular.ttf", path)
    assert read_upload_faces(path) == []


def test_a_garbage_file_gives_no_faces(tmp_path: Path) -> None:
    path = tmp_path / "garbage.ttf"
    shutil.copy(FONTS / "Garbage.ttf", path)
    assert read_upload_faces(path) == []


def test_a_missing_file_gives_no_faces(tmp_path: Path) -> None:
    assert read_upload_faces(tmp_path / "absent.ttf") == []


def test_the_upload_reader_refuses_what_the_validator_refuses(tmp_path: Path) -> None:
    path = tmp_path / "nocmap.ttf"
    shutil.copy(FONTS / "TestNoCmap-Regular.ttf", path)
    with pytest.raises(FontRejected):
        validate_font_bytes(path.read_bytes(), str(path))
    assert read_upload_faces(path) == []


def test_the_catalogue_over_a_folder_agrees_with_the_validator(tmp_path: Path) -> None:
    folder = tmp_path / "fonts"
    folder.mkdir()
    names = [
        "TestSans-Regular.ttf",
        "TestCff-Regular.otf",
        "TestCollection.ttc",
        "TestMixedCollection.ttc",
        "TestRestricted-Regular.ttf",
        "Garbage.ttf",
    ]
    for name in names:
        shutil.copy(FONTS / name, folder / name)

    catalog = FontCatalog(
        folders=[folder], cache_path=folder / "catalog.json", reader=read_upload_faces
    )
    catalog.scan()

    for name in names:
        path = folder / name
        expected: list[FontFace] = []
        try:
            _fmt, faces, _refused = validate_font_bytes(path.read_bytes(), str(path))
            expected = faces
        except FontRejected:
            pass
        listed = [face for face in catalog.faces() if face.path == str(path)]
        assert [(f.index, f.family) for f in listed] == [
            (f.index, f.family) for f in expected
        ], name


def test_the_catalogue_resolves_a_file_ref_to_its_upload_face(tmp_path: Path) -> None:
    folder = tmp_path / "fonts"
    folder.mkdir()
    shutil.copy(FONTS / "TestCollection.ttc", folder / "coll.ttc")
    catalog = FontCatalog(
        folders=[folder], cache_path=folder / "catalog.json", reader=read_upload_faces
    )
    catalog.scan()
    faces = [face for face in catalog.faces() if face.path == str(folder / "coll.ttc")]
    assert faces, "the fixture collection has an embeddable face"
    index = faces[-1].index
    found = catalog.face_for(FontRef.file(str(folder / "coll.ttc"), index))
    assert found is not None and found.index == index
    assert catalog.face_for(FontRef.file(str(folder / "coll.ttc"), 99)) is None


def test_the_reader_is_the_one_the_catalogue_was_given(tmp_path: Path) -> None:
    folder = tmp_path / "fonts"
    folder.mkdir()
    shutil.copy(FONTS / "TestSans-Regular.ttf", folder / "sans.ttf")
    calls: list[Path] = []

    def reader(path: Path) -> list[FontFace]:
        calls.append(path)
        return read_faces(path)

    catalog = FontCatalog(folders=[folder], cache_path=folder / "catalog.json", reader=reader)
    catalog.scan()
    assert calls == [folder / "sans.ttf"]
    catalog.scan()  # unchanged: the cache answers, the reader is not called again
    assert calls == [folder / "sans.ttf"]
