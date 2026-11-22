"""The font calls of W6.9 slice 2 through dispatch: ``fonts.add``, ``fonts.list`` and
``fonts.remove``, the store's quotas, the ``FILE`` ref guard against the store, and the refusal of
uploaded fonts in jobs.

The store writes to a temporary folder here (``use_root``), so the tests never touch ``/fonts``.
The round trip of an uploaded font (the engine reads ``/fonts``) is the next slice's test.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.webapi import fontstore, limits
from pdfeditor.webapi.errors import (
    FILE_TOO_LARGE,
    FONT_NOT_EMBEDDABLE,
    FONT_STORAGE_FULL,
    INVALID_ARGS,
    INVALID_FONT,
    NOT_SUPPORTED,
)
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.unit.test_webapi_jobs import call, error, ok, open_data

FONTS = Path(__file__).resolve().parents[1] / "fixtures" / "generated" / "fonts"
SANS = "TestSans-Regular.ttf"
SANS_BOLD = "TestSans-Bold.ttf"


def _fixture(name: str) -> bytes:
    return (FONTS / name).read_bytes()


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@pytest.fixture(autouse=True)
def store_root(tmp_path: Path) -> Iterator[Path]:
    """Every test gets a fresh store in its own folder, and the worker's store is reset after."""
    root = tmp_path / "fonts"
    fontstore.use_root(root)
    try:
        yield root
    finally:
        fontstore.use_root(None)


@pytest.fixture
def web() -> Iterator[None]:
    previous = model_platform.current()
    configure_web()
    try:
        yield
    finally:
        REGISTRY.close_all()
        model_platform.configure(previous)


def _add(name: str, data: bytes) -> dict[str, Any]:
    reply = call("fonts.add", {"name": name, "data": {"$bin": 0}}, [data])
    return reply


def _added(name: str, data: bytes) -> dict[str, Any]:
    return ok(_add(name, data))


def _spy_validate(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    """Count the parses: ``fontstore`` calls ``validate_font_bytes`` once per file it reads."""
    calls: list[int] = []
    real = fontstore.validate_font_bytes

    def spy(data: bytes, label: str) -> Any:
        calls.append(len(data))
        return real(data, label)

    monkeypatch.setattr(fontstore, "validate_font_bytes", spy)
    return calls


def _files(root: Path) -> list[str]:
    """The font files in the store's folder (the catalogue's cache file is not a font)."""
    if not root.exists():
        return []
    return sorted(p.name for p in root.iterdir() if p.name != fontstore.CATALOG_CACHE)


# -- fonts.add ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "fmt", "ext"),
    [
        (SANS, "truetype", "ttf"),
        ("TestCff-Regular.otf", "opentype", "otf"),
        ("TestCollection.ttc", "collection", "ttc"),
    ],
)
def test_add_stores_the_file_under_its_hash(
    store_root: Path, name: str, fmt: str, ext: str
) -> None:
    data = _fixture(name)
    reply = _add(name.lower(), data)
    result = ok(reply)
    font_id = _sha(data)
    assert result["added"] is True
    assert result["used_bytes"] == len(data)
    assert result["max_bytes"] == limits.MAX_FONT_STORE_BYTES
    font = result["font"]
    assert font["id"] == font_id
    assert font["name"] == name.lower()
    assert font["format"] == fmt
    assert font["size"] == len(data)
    assert font["path"] == f"/fonts/{font_id}.{ext}"
    assert font["refused"] == []
    assert font["faces"], "a stored font has at least one embeddable face"
    assert (store_root / f"{font_id}.{ext}").read_bytes() == data
    assert reply["events"] == []


def test_add_names_the_file_by_its_hash_never_by_the_user_name(store_root: Path) -> None:
    data = _fixture(SANS)
    result = _added("../../etc/x.ttf", data)
    assert result["font"]["name"] == "../../etc/x.ttf"  # kept for display only
    assert _files(store_root) == [f"{_sha(data)}.ttf"]


def test_the_same_bytes_again_add_nothing(
    store_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    data = _fixture(SANS)
    first = _added("first.ttf", data)
    parses = _spy_validate(monkeypatch)
    second = _added("second.ttf", data)
    assert second["added"] is False
    assert second["font"]["name"] == "first.ttf"  # the first name stays
    assert second["used_bytes"] == first["used_bytes"]
    assert parses == []  # not parsed again
    assert _files(store_root).count(f"{_sha(data)}.ttf") == 1


def test_a_name_of_256_characters_is_refused_and_nothing_is_written(store_root: Path) -> None:
    err = error(_add("n" * 256, _fixture(SANS)))
    assert err["code"] == INVALID_ARGS
    assert err["details"] == {"path": "params.name"}
    assert not store_root.exists()


def test_a_font_over_the_size_limit_is_refused_before_parsing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(limits, "MAX_FONT_BYTES", 100)
    parses = _spy_validate(monkeypatch)
    err = error(_add(SANS, _fixture(SANS)))
    assert err["code"] == FILE_TOO_LARGE
    assert err["details"]["max_bytes"] == 100
    assert parses == []


@pytest.mark.parametrize(
    ("name", "code", "reason"),
    [
        ("Garbage.ttf", INVALID_FONT, "not_a_font"),
        ("TestNoCmap-Regular.ttf", INVALID_FONT, "no_usable_face"),
        ("TestRestricted-Regular.ttf", FONT_NOT_EMBEDDABLE, "restricted"),
        ("TestRestrictedCollection.ttc", FONT_NOT_EMBEDDABLE, "restricted"),
    ],
)
def test_a_file_the_validator_refuses_is_not_stored(
    store_root: Path, name: str, code: str, reason: str
) -> None:
    err = error(_add(name, _fixture(name)))
    assert err["code"] == code
    assert err["details"]["reason"] == reason
    assert not store_root.exists() or _files(store_root) == []


def test_a_mixed_collection_is_stored_with_its_refused_face(store_root: Path) -> None:
    result = _added("mixed.ttc", _fixture("TestMixedCollection.ttc"))
    font = result["font"]
    assert [face["family"] for face in font["faces"]] == ["Test Mixed One"]
    assert font["refused"] == [
        {"index": 1, "family": "Test Mixed Two", "style": "Regular", "reason": "restricted"}
    ]


def test_too_many_fonts_is_full_and_checked_before_parsing(
    store_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(limits, "MAX_UPLOADED_FONTS", 1)
    _added(SANS, _fixture(SANS))
    parses = _spy_validate(monkeypatch)
    err = error(_add(SANS_BOLD, _fixture(SANS_BOLD)))
    assert err["code"] == FONT_STORAGE_FULL
    assert err["details"]["limit"] == "count"
    assert err["details"]["max_fonts"] == 1
    assert parses == []


def test_too_many_bytes_is_full_and_checked_before_parsing(
    store_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = _fixture(SANS)
    monkeypatch.setattr(limits, "MAX_FONT_STORE_BYTES", len(first) + 10)
    _added(SANS, first)
    parses = _spy_validate(monkeypatch)
    err = error(_add(SANS_BOLD, _fixture(SANS_BOLD)))
    assert err["code"] == FONT_STORAGE_FULL
    assert err["details"]["limit"] == "bytes"
    assert err["details"]["size"] == len(_fixture(SANS_BOLD))
    assert parses == []


def test_a_write_the_file_system_refuses_is_full_and_leaves_nothing(
    store_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def refuse(src: object, dst: object) -> None:
        raise OSError("no room")

    monkeypatch.setattr(fontstore.os, "replace", refuse)
    err = error(_add(SANS, _fixture(SANS)))
    assert err["code"] == FONT_STORAGE_FULL
    assert err["details"]["limit"] == "memory"
    assert _files(store_root) == []  # the temporary file is gone too
    assert ok(call("fonts.list", {}))["fonts"] == []


# -- fonts.list and fonts.remove ----------------------------------------------------------------


def test_list_is_empty_until_a_font_is_added() -> None:
    result = ok(call("fonts.list", {}))
    assert result == {
        "fonts": [],
        "used_bytes": 0,
        "max_bytes": limits.MAX_FONT_STORE_BYTES,
    }


def test_list_gives_the_fonts_in_the_order_they_were_added() -> None:
    sans = _added(SANS, _fixture(SANS))["font"]
    coll = _added("mixed.ttc", _fixture("TestMixedCollection.ttc"))["font"]
    result = ok(call("fonts.list", {}))
    assert [font["id"] for font in result["fonts"]] == [sans["id"], coll["id"]]
    assert result["fonts"][0]["faces"] == sans["faces"]
    assert result["fonts"][1]["refused"] == coll["refused"]
    assert result["used_bytes"] == sans["size"] + coll["size"]


def test_remove_deletes_the_file_and_the_entry(store_root: Path) -> None:
    data = _fixture(SANS)
    font = _added(SANS, data)["font"]
    before = ok(call("fonts.list", {}))["used_bytes"]
    reply = call("fonts.remove", {"id": font["id"]})
    assert ok(reply) == {}
    assert reply["events"] == []
    assert not (store_root / f"{font['id']}.ttf").exists()
    after = ok(call("fonts.list", {}))
    assert after["fonts"] == []
    assert after["used_bytes"] == before - len(data)


def test_remove_of_an_unknown_id_is_a_no_op() -> None:
    kept = _added(SANS, _fixture(SANS))["font"]
    ok(call("fonts.remove", {"id": "b" * 64}))
    assert [font["id"] for font in ok(call("fonts.list", {}))["fonts"]] == [kept["id"]]


def test_remove_then_add_the_same_bytes_adds_again() -> None:
    data = _fixture(SANS)
    font = _added(SANS, data)["font"]
    ok(call("fonts.remove", {"id": font["id"]}))
    again = _added(SANS, data)
    assert again["added"] is True
    assert again["font"]["path"] == font["path"]


@pytest.mark.parametrize("bad", ["", "A" * 64, "a" * 63, "../" + "a" * 61, "g" * 64])
def test_remove_refuses_a_malformed_id(bad: str) -> None:
    err = error(call("fonts.remove", {"id": bad}))
    assert err["code"] == INVALID_ARGS
    assert err["details"] == {"path": "params.id"}


# -- the FILE ref guard against the store -------------------------------------------------------


def _ref(path: str, index: int = 0) -> dict[str, Any]:
    return {"kind": "file", "name": "Probe", "path": path, "index": index}


def _add_text(handle: str, font_ref: dict[str, Any]) -> dict[str, Any]:
    args = {
        "page": 0,
        "rect": {"x0": 10, "y0": 10, "x1": 200, "y1": 60},
        "text": "probe",
        "style": {"font_ref": font_ref},
    }
    return call("actions.run", {"handle": handle, "name": "content.add_text", "args": args})


def test_a_face_the_catalogue_no_longer_reads_is_refused(
    store_root: Path, web: None, fixture_pdf: Any
) -> None:
    # The manifest still lists the font, but its file now reads as junk, so the rescan that the
    # second add makes drops its faces: the list shows none and the guard refuses the ref.
    font = _added(SANS, _fixture(SANS))["font"]
    (store_root / f"{font['id']}.ttf").write_bytes(_fixture("Garbage.ttf"))
    _added(SANS_BOLD, _fixture(SANS_BOLD))
    listed = {f["id"]: f for f in ok(call("fonts.list", {}))["fonts"]}
    assert listed[font["id"]]["faces"] == []
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    err = error(_add_text(handle, _ref(font["path"])))
    assert err["code"] == INVALID_ARGS


def test_a_ref_to_a_stored_face_passes_the_guard(web: None, fixture_pdf: Any) -> None:
    font = _added(SANS, _fixture(SANS))["font"]
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    reply = _add_text(handle, _ref(font["path"]))
    if reply["ok"] is False:  # on the desktop the engine cannot read /fonts: not the guard's error
        assert reply["error"]["code"] != INVALID_ARGS
    else:
        ok(reply)


def test_a_ref_to_a_removed_font_is_refused(web: None, fixture_pdf: Any) -> None:
    font = _added(SANS, _fixture(SANS))["font"]
    ok(call("fonts.remove", {"id": font["id"]}))
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    err = error(_add_text(handle, _ref(font["path"])))
    assert err["code"] == INVALID_ARGS
    assert err["details"] == {"path": "args.style.font_ref"}


def test_a_ref_to_another_face_index_is_refused(web: None, fixture_pdf: Any) -> None:
    font = _added(SANS, _fixture(SANS))["font"]
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    err = error(_add_text(handle, _ref(font["path"], index=3)))
    assert err["code"] == INVALID_ARGS


def test_a_ref_to_a_font_never_stored_is_refused(web: None, fixture_pdf: Any) -> None:
    _added(SANS, _fixture(SANS))
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    err = error(_add_text(handle, _ref(f"/fonts/{'c' * 64}.ttf")))
    assert err["code"] == INVALID_ARGS


def test_a_font_in_a_job_is_refused(web: None, fixture_pdf: Any) -> None:
    font = _added(SANS, _fixture(SANS))["font"]
    handle = open_data(fixture_pdf("text_multipage").read_bytes(), "text_multipage.pdf")
    spec = {"text": "CONFIDENTIAL", "font_size": 60.0, "font_ref": _ref(font["path"])}
    args = {"spec": spec, "pages": [0], "replace_existing": False}
    err = error(
        call(
            "jobs.prepare",
            {
                "handle": handle,
                "job": "action",
                "args": {"name": "marks.watermark", "args": args},
            },
        )
    )
    assert err["code"] == NOT_SUPPORTED
    assert err["details"] == {"path": "args.args.spec.font_ref"}
