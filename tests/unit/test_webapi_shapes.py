"""The web's shape adds (W6.7b): content.add_shape through actions.run, as the Edit tab's shape
tools send it. Each test edits through the same dispatch, then saves and checks the file with the
host checks: pikepdf reads the operators, pypdfium2 renders the page (``tests.hostcheck.record``).
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.webapi.errors import INVALID_ARGS, REFUSED
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.hostcheck import record
from tests.unit.test_webapi_jobs import call, error, ok, open_data
from tests.unit.test_webapi_save import saved_bytes

BLACK = {"r": 0.0, "g": 0.0, "b": 0.0, "a": 1.0}
BOX = {"x0": 100.0, "y0": 500.0, "x1": 200.0, "y1": 560.0}


@pytest.fixture
def web() -> Iterator[None]:
    previous = model_platform.current()
    configure_web()
    try:
        yield
    finally:
        REGISTRY.close_all()
        model_platform.configure(previous)


def add(handle: str, spec: dict[str, Any], page: int = 0) -> dict[str, Any]:
    args = {"page": page, "spec": {"stroke": BLACK, "fill": None, "width": 1.5, **spec}}
    return call("actions.run", {"handle": handle, "name": "content.add_shape", "args": args})


def revision_of(handle: str, page: int = 0) -> int:
    session = REGISTRY.get(handle)
    with session.lock:
        return int(session.document.page(page).revision)


def paths_on(handle: str, page: int = 0) -> list[dict[str, Any]]:
    listed = ok(call("content.objects", {"handle": handle, "page": page}))
    return [o for o in listed["objects"] if o["type"] == "path"]


def test_an_ellipse_is_added_and_saved_as_four_curves(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("text_multipage").read_bytes(), "pages.pdf")
    before = revision_of(handle)
    reply = ok(add(handle, {"kind": "ellipse", "rect": BOX}))
    assert reply["label"] == "Add Ellipse" and reply["executed"] is True
    assert reply["changed"]["revisions"]["0"] > before
    assert len(paths_on(handle)) == 1

    _, saved = saved_bytes(handle, "copy")
    record("opens_pikepdf", saved)
    record("shape_operators_pikepdf", saved, page=0, kind="ellipse")
    record("ink_region_pdfium", saved, page=0, clip=[97, 527, 103, 533])


def test_a_line_is_added_between_its_two_ends(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("text_multipage").read_bytes(), "pages.pdf")
    start, end = {"x": 100.0, "y": 600.0}, {"x": 300.0, "y": 640.0}
    reply = ok(add(handle, {"kind": "line", "start": start, "end": end}))
    assert reply["label"] == "Add Line"

    _, saved = saved_bytes(handle, "copy")
    record("opens_pikepdf", saved)
    record("shape_operators_pikepdf", saved, page=0, kind="line")
    record("ink_region_pdfium", saved, page=0, clip=[197, 617, 203, 623])


def test_a_wrong_kind_is_invalid_args_at_the_spec_kind(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("text_multipage").read_bytes(), "pages.pdf")
    err = error(add(handle, {"kind": "triangle", "rect": BOX}))
    assert err["code"] == INVALID_ARGS
    assert err["details"] == {"path": "args.spec.kind"}
    assert paths_on(handle) == []


def test_a_zero_width_outline_is_refused_and_changes_nothing(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("text_multipage").read_bytes(), "pages.pdf")
    before = revision_of(handle)
    err = error(add(handle, {"kind": "rectangle", "rect": BOX, "width": 0.0}))
    assert err["code"] == REFUSED
    assert revision_of(handle) == before
    assert paths_on(handle) == []


def test_the_shape_on_a_missing_page_is_refused(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("text_multipage").read_bytes(), "pages.pdf")
    err = error(add(handle, {"kind": "rectangle", "rect": BOX}, page=99))
    assert err["code"] == REFUSED
