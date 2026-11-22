"""The guard on ``FILE`` font refs in ``actions.run`` (W6.9 slice 2, design section 6).

A ``FILE`` ref is accepted only when its path is ``/fonts/<64 hex>.(ttf|otf|ttc)`` and the
catalogue holds that face. Until the upload storage lands no face is in the catalogue, so the
accepted forms are tested with the catalogue lookup replaced.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.model.fonts import FontRef, FontRefKind
from pdfeditor.model.objects import TextStyle
from pdfeditor.webapi import fontrefs
from pdfeditor.webapi.errors import INVALID_ARGS, RpcFailure
from pdfeditor.webapi.fontrefs import check_font_refs
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.unit.test_webapi_jobs import call, error, ok, open_data

HASH = "a" * 64
GOOD = f"/fonts/{HASH}.ttf"


@pytest.fixture
def web() -> Iterator[None]:
    previous = model_platform.current()
    configure_web()
    try:
        yield
    finally:
        REGISTRY.close_all()
        model_platform.configure(previous)


def _file_ref(path: str, index: int = 0) -> FontRef:
    return FontRef(FontRefKind.FILE, "Test", path, index)


def _refused(path: str, index: int = 0) -> None:
    with pytest.raises(RpcFailure) as info:
        check_font_refs(_file_ref(path, index), "args.style.font_ref")
    assert info.value.code == INVALID_ARGS
    assert info.value.details == {"path": "args.style.font_ref"}


def _accept_only(monkeypatch: pytest.MonkeyPatch, path: str, index: int = 0) -> None:
    """Pretend the catalogue holds exactly one face (the upload storage's job)."""

    def lookup(p: str, i: int) -> bool:
        return p == path and i == index

    monkeypatch.setattr(fontrefs, "face_in_catalogue", lookup)


# Each refused form: a path the guard must not let the engine read as a font.
REFUSED_PATHS = [
    "",  # empty
    GOOD.replace(".ttf", ""),  # no extension
    f"/fonts/{HASH}.woff",  # another format
    f"/fonts/{HASH}.TTF",  # upper-case extension
    f"/fonts/{HASH}.ttf.exe",  # a second extension
    f"/fonts/{HASH}.ttf\n",  # a trailing newline ($ would match it; fullmatch does not)
    f"/fonts/{HASH}.ttf ",  # a trailing space
    f"/fonts/{'A' * 64}.ttf",  # upper-case hex
    f"/fonts/{'a' * 63}.ttf",  # one hex digit short
    f"/fonts/{'a' * 65}.ttf",  # one hex digit long
    f"/fonts/{'g' * 64}.ttf",  # not hex
    f"/fonts/{HASH}.ttf/../{HASH}.ttf",  # a file name followed by traversal
    f"/fonts/../{HASH}.ttf",  # path traversal out of the folder
    f"/fonts/../../etc/{HASH}.ttf",  # deeper traversal
    f"/fonts/./{HASH}.ttf",  # a dot segment
    f"/fonts//{HASH}.ttf",  # an empty segment
    f"/fonts/%2e%2e/{HASH}.ttf",  # percent-encoded traversal (never decoded, so refused)
    f"\\fonts\\..\\{HASH}.ttf",  # Windows separators
    f"/fonts/sub/{HASH}.ttf",  # a sub-folder
    f"/fonts{HASH}.ttf",  # no folder separator
    f"fonts/{HASH}.ttf",  # relative
    f"/home/pyodide/{HASH}.ttf",  # another folder in the worker's file system
    f"/tmp/{HASH}.ttf",
    "/etc/passwd",  # an ordinary file
    "/fonts/catalog.json",  # the catalogue's own cache
    f"file:///fonts/{HASH}.ttf",  # a URL form
]


@pytest.mark.parametrize("path", REFUSED_PATHS)
def test_a_file_ref_outside_the_upload_form_is_refused(path: str) -> None:
    _refused(path)


def test_a_valid_path_is_refused_until_the_catalogue_holds_the_face() -> None:
    # No upload storage yet, so the catalogue is empty: every well-formed path is refused too.
    _refused(GOOD)
    _refused(f"/fonts/{HASH}.otf")
    _refused(f"/fonts/{HASH}.ttc", index=1)


def test_a_face_missing_from_the_catalogue_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    _accept_only(monkeypatch, GOOD, index=0)
    _refused(GOOD, index=1)  # the same file, another face index
    _refused(f"/fonts/{'b' * 64}.ttf")  # another stored file


@pytest.mark.parametrize(
    ("path", "index"),
    [
        (GOOD, 0),  # TrueType
        (f"/fonts/{HASH}.otf", 0),  # OpenType
        (f"/fonts/{HASH}.ttc", 0),  # the first face of a collection
        (f"/fonts/{HASH}.ttc", 2),  # a later face of a collection
    ],
)
def test_an_uploaded_face_in_the_catalogue_is_accepted(
    monkeypatch: pytest.MonkeyPatch, path: str, index: int
) -> None:
    _accept_only(monkeypatch, path, index)
    check_font_refs(_file_ref(path, index), "args.style.font_ref")


def test_standard_and_document_refs_are_not_touched() -> None:
    check_font_refs(FontRef.standard("Helvetica"), "args.style.font_ref")
    check_font_refs(FontRef.document("F1"), "args.style.font_ref")
    check_font_refs(None, "args.style.font_ref")


def test_a_file_ref_nested_in_a_list_is_found() -> None:
    refs = (FontRef.standard("Courier"), _file_ref("/etc/passwd"))
    with pytest.raises(RpcFailure) as info:
        check_font_refs(refs, "args.fonts")
    assert info.value.details == {"path": "args.fonts[1]"}


def test_the_rpc_refuses_a_traversal_path_before_the_engine_reads_it(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    args = {
        "page": 0,
        "rect": {"x0": 10, "y0": 10, "x1": 200, "y1": 60},
        "text": "probe",
        "style": {
            "font_ref": {
                "kind": "file",
                "name": "Probe",
                "path": "/fonts/../../etc/passwd",
                "index": 0,
            }
        },
    }
    err = error(call("actions.run", {"handle": handle, "name": "content.add_text", "args": args}))
    assert err["code"] == INVALID_ARGS
    assert err["details"] == {"path": "args.style.font_ref"}


def test_the_rpc_passes_an_accepted_ref_to_the_action(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    # With the face in the catalogue the guard lets the call through, so the reply is no longer
    # the guard's INVALID_ARGS. (The file is not in the worker here, so the engine reports its
    # own error for it.)
    _accept_only(monkeypatch, GOOD, 0)
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    args = {
        "page": 0,
        "rect": {"x0": 10, "y0": 10, "x1": 200, "y1": 60},
        "text": "probe",
        "style": {"font_ref": {"kind": "file", "name": "Probe", "path": GOOD, "index": 0}},
    }
    reply = call("actions.run", {"handle": handle, "name": "content.add_text", "args": args})
    if reply["ok"] is False:
        assert reply["error"]["code"] != INVALID_ARGS
    else:
        ok(reply)


def test_a_text_style_with_no_ref_passes_the_guard(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    args = {
        "page": 0,
        "rect": {"x0": 10, "y0": 10, "x1": 200, "y1": 60},
        "text": "plain",
        "style": {"font": "Helvetica"},
    }
    ok(call("actions.run", {"handle": handle, "name": "content.add_text", "args": args}))


def test_the_guard_takes_a_dataclass_style() -> None:
    style = TextStyle(font_ref=_file_ref("/fonts/../x.ttf"))
    with pytest.raises(RpcFailure) as info:
        check_font_refs(style, "args.style")
    assert info.value.details == {"path": "args.style.font_ref"}
