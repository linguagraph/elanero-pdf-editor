"""The web's image adds (W6.7b slice 2a): content.add_image through actions.run, as the Edit tab
sends it after a file is picked and placed. The bytes travel as a $bin buffer. Each test edits
through the same dispatch, then saves and checks the file with the host checks (pikepdf reads the
XObject, pypdfium2 renders the page; ``tests.hostcheck.record``).
"""

from __future__ import annotations

import io
from collections.abc import Iterator
from typing import Any

import pytest
from PIL import Image

from pdfeditor.model import platform as model_platform
from pdfeditor.webapi.errors import INVALID_ARGS, REFUSED
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.hostcheck import record
from tests.unit.test_webapi_jobs import call, error, ok, open_data
from tests.unit.test_webapi_save import saved_bytes

PLACED = {"x0": 100.0, "y0": 300.0, "x1": 300.0, "y1": 500.0}


@pytest.fixture
def web() -> Iterator[None]:
    previous = model_platform.current()
    configure_web()
    try:
        yield
    finally:
        REGISTRY.close_all()
        model_platform.configure(previous)


def png() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (60, 50), (0, 200, 0)).save(buf, format="PNG")
    return buf.getvalue()


def gif() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (60, 50), (0, 0, 200)).save(buf, format="GIF")
    return buf.getvalue()


def add_image(
    handle: str, data: bytes | None, buffers: bool = True, **extra: Any
) -> dict[str, Any]:
    args: dict[str, Any] = {"page": 0, "rect": PLACED, "data": {"$bin": 0}, **extra}
    return call(
        "actions.run",
        {"handle": handle, "name": "content.add_image", "args": args},
        [data] if buffers and data is not None else None,
    )


def revision_of(handle: str, page: int = 0) -> int:
    session = REGISTRY.get(handle)
    with session.lock:
        return int(session.document.page(page).revision)


def images_on(handle: str, page: int = 0) -> list[dict[str, Any]]:
    listed = ok(call("content.objects", {"handle": handle, "page": page}))
    return [o for o in listed["objects"] if o["type"] == "image"]


def test_a_png_is_added_fitted_to_the_box_and_saved(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("rotated_pages").read_bytes(), "pages.pdf")
    before = revision_of(handle)
    reply = ok(add_image(handle, png()))
    assert reply["label"] == "Add Image" and reply["executed"] is True
    assert reply["changed"]["revisions"]["0"] > before
    assert len(images_on(handle)) == 1

    _, saved = saved_bytes(handle, "copy")
    record("opens_pikepdf", saved)
    # 60 x 50 in a 200 x 200 box: fitted to 200 wide, centred, so (200, 400) is green.
    record("pixel_green_pdfium", saved, page=0, x=200, y=400)


def test_keep_proportion_false_stretches_to_the_box(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("rotated_pages").read_bytes(), "pages.pdf")
    ok(add_image(handle, png(), keep_proportion=False))
    _, saved = saved_bytes(handle, "copy")
    record("opens_pikepdf", saved)
    record("pixel_green_pdfium", saved, page=0, x=110, y=310)


def test_a_gif_is_refused_with_the_browser_message(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("rotated_pages").read_bytes(), "pages.pdf")
    before = revision_of(handle)
    err = error(add_image(handle, gif()))
    assert err["code"] == REFUSED
    assert "PNG and JPEG" in err["message"]
    assert err["details"] == {"reason": "image_format"}
    assert revision_of(handle) == before
    assert images_on(handle) == []


def test_a_missing_buffer_is_invalid_args(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("rotated_pages").read_bytes(), "pages.pdf")
    err = error(add_image(handle, None, buffers=False))
    assert err["code"] == INVALID_ARGS
    assert images_on(handle) == []
