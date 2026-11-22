"""The web's image calls: content.add_image (W6.7b slice 2a), content.replace_image and the
read-only content.image export (slice 2b), through actions.run and the RPC dispatch, as the Edit
tab sends them. The bytes travel as a $bin buffer. Each edit test saves and checks the file with
the host checks (pikepdf reads the XObject, pypdfium2 renders the page; ``tests.hostcheck.record``).
"""

from __future__ import annotations

import io
from collections.abc import Iterator
from typing import Any

import pytest
from PIL import Image, features

from pdfeditor.model import platform as model_platform
from pdfeditor.services.export.images import browser_image
from pdfeditor.webapi import limits
from pdfeditor.webapi.errors import FILE_TOO_LARGE, INVALID_ARGS, REFUSED, STALE_OBJECT
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.hostcheck import record
from tests.unit.test_webapi_jobs import binary, call, call_raw, error, ok, open_data
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


# -- replace and export (W6.7b slice 2b) ------------------------------------------------------


def listing(handle: str, page: int = 0) -> tuple[int, list[dict[str, Any]]]:
    """The page's revision and its images, as content.objects lists them."""
    reply = ok(call("content.objects", {"handle": handle, "page": page}))
    return int(reply["revision"]), [o for o in reply["objects"] if o["type"] == "image"]


def replace(
    handle: str, key: str, revision: int, data: bytes | None, page: int = 0
) -> dict[str, Any]:
    args: dict[str, Any] = {"object": {"page": page, "key": key, "revision": revision}}
    if data is None:
        return call(
            "actions.run", {"handle": handle, "name": "content.replace_image", "args": args}
        )
    args["data"] = {"$bin": 0}
    return call(
        "actions.run",
        {"handle": handle, "name": "content.replace_image", "args": args},
        [data],
    )


def export(
    handle: str, key: str, revision: int, page: int = 0
) -> tuple[dict[str, Any], list[bytes]]:
    return call_raw(
        "content.image", {"handle": handle, "page": page, "key": key, "revision": revision}
    )


def decoded(data: bytes) -> Image.Image:
    return Image.open(io.BytesIO(data)).convert("RGB")


def test_replace_then_export_round_trip(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    revision, pictures = listing(handle)
    (picture,) = pictures
    reply = ok(replace(handle, picture["key"], revision, png()))
    assert reply["label"] == "Replace Image" and reply["executed"] is True
    replaced_at = int(reply["changed"]["revisions"]["0"])
    assert replaced_at > revision

    _, saved = saved_bytes(handle, "copy")
    record("opens_pikepdf", saved)
    # The box is the old picture's (420..540, 80..180): its centre is green in the saved file.
    record("pixel_green_pdfium", saved, page=0, x=480, y=130)

    moved_to, pictures = listing(handle)
    assert moved_to == replaced_at
    result_reply, out = export(handle, pictures[0]["key"], moved_to)
    result = ok(result_reply)
    assert result["ext"] == "png" and result["mime"] == "image/png"
    assert (result["width"], result["height"]) == (60, 50)
    assert decoded(binary(result["data"], out)).getpixel((30, 25)) == (0, 200, 0)


def test_export_of_an_added_jpeg_is_a_jpeg(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("rotated_pages").read_bytes(), "pages.pdf")
    buf = io.BytesIO()
    Image.new("RGB", (60, 50), (200, 40, 40)).save(buf, format="JPEG")
    ok(add_image(handle, buf.getvalue()))
    revision, pictures = listing(handle)
    result_reply, out = export(handle, pictures[0]["key"], revision)
    result = ok(result_reply)
    assert result["ext"] == "jpeg" and result["mime"] == "image/jpeg"
    data = binary(result["data"], out)
    assert data[:3] == b"\xff\xd8\xff"
    assert decoded(data).size == (60, 50)


def test_export_is_the_engine_bytes_and_changes_nothing(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    session = REGISTRY.get(handle)
    revision, pictures = listing(handle)
    with session.lock:
        expected, expected_ext = session.document.page(0).image_data(pictures[0]["key"])
    result_reply, out = export(handle, pictures[0]["key"], revision)
    result = ok(result_reply)
    assert binary(result["data"], out) == expected
    assert result["ext"] == expected_ext
    assert listing(handle)[0] == revision
    assert not session.is_dirty
    assert not session.undo_stack.can_undo


def test_export_with_a_stale_revision_is_stale(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    revision, pictures = listing(handle)
    reply, _ = export(handle, pictures[0]["key"], revision - 1)
    assert error(reply)["code"] == STALE_OBJECT


def test_replace_with_a_stale_revision_is_stale_and_changes_nothing(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    revision, pictures = listing(handle)
    err = error(replace(handle, pictures[0]["key"], revision - 1, png()))
    assert err["code"] == STALE_OBJECT
    assert listing(handle)[0] == revision
    assert not REGISTRY.get(handle).undo_stack.can_undo


def test_export_of_an_inline_picture_is_refused(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("inline_image").read_bytes(), "inline.pdf")
    revision, pictures = listing(handle)
    (picture,) = pictures
    reply, _ = export(handle, picture["key"], revision)
    err = error(reply)
    assert err["code"] == REFUSED
    assert err["details"] == {"reason": "inline_image"}


def test_replace_of_an_inline_picture_is_refused_with_no_undo_step(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_data(fixture_pdf("inline_image").read_bytes(), "inline.pdf")
    revision, pictures = listing(handle)
    err = error(replace(handle, pictures[0]["key"], revision, png()))
    assert err["code"] == REFUSED
    assert err["details"] == {"reason": "inline_image"}
    assert listing(handle)[0] == revision
    assert not REGISTRY.get(handle).undo_stack.can_undo


def test_replace_refuses_a_gif_on_the_web(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    revision, pictures = listing(handle)
    err = error(replace(handle, pictures[0]["key"], revision, gif()))
    assert err["code"] == REFUSED
    assert err["details"] == {"reason": "image_format"}
    assert listing(handle)[0] == revision


def test_replace_without_a_buffer_is_invalid_args(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    revision, pictures = listing(handle)
    reply = call(
        "actions.run",
        {
            "handle": handle,
            "name": "content.replace_image",
            "args": {
                "object": {"page": 0, "key": pictures[0]["key"], "revision": revision},
                "data": {"$bin": 0},
            },
        },
    )
    assert error(reply)["code"] == INVALID_ARGS


def test_export_over_the_pixel_ceiling_is_too_large_before_any_bytes(
    web: None, fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    revision, pictures = listing(handle)
    monkeypatch.setattr(limits, "MAX_RENDER_PIXELS", 100)
    reply, _ = export(handle, pictures[0]["key"], revision)
    err = error(reply)
    assert err["code"] == FILE_TOO_LARGE
    assert err["details"] == {"max_pixels": 100, "pixels": 120 * 100}


def test_export_of_a_missing_page_is_invalid_args(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    reply, _ = export(handle, "image:0", 0, page=9)
    assert error(reply)["code"] == INVALID_ARGS


def test_browser_image_turns_jpeg2000_into_png() -> None:
    if not features.check("jpg_2000"):
        pytest.skip("this Pillow has no JPEG 2000 support")
    buf = io.BytesIO()
    Image.new("RGB", (16, 16), (0, 0, 200)).save(buf, format="JPEG2000")
    data, ext = browser_image(buf.getvalue(), "jpx")
    assert ext == "png"
    assert decoded(data).getpixel((8, 8)) == (0, 0, 200)


def test_browser_image_keeps_other_formats_as_stored() -> None:
    assert browser_image(b"\x00\x01", "jbig2") == (b"\x00\x01", "jbig2")
