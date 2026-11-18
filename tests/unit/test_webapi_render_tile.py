"""The tile render call of W3.3 (``render.tile``, W1.4 section 4) through dispatch, host CPython.

Tiles are checked against ``render.page`` at the same scale: the tile's pixels are the matching
window of the whole page image. Helpers are local (no import from test_webapi_render) so each test
module stands alone.
"""

from __future__ import annotations

import json
import math
from collections.abc import Iterator
from typing import Any

import pytest

from pdfeditor.webapi import dispatch, limits
from pdfeditor.webapi.errors import INVALID_ARGS, NO_DOCUMENT, RENDER_TOO_LARGE
from pdfeditor.webapi.registry import REGISTRY

TILE = 1024
# Scale 2.0 on a letter page is about 1224 x 1584 device pixels: a 2 x 2 grid whose edge tiles
# are clipped.
SCALE = 2000


@pytest.fixture(autouse=True)
def _no_documents_left_open() -> Iterator[None]:
    yield
    REGISTRY.close_all()


def call(method: str, params: dict[str, Any], buffers: list[bytes] | None = None) -> Any:
    request = json.dumps({"v": 1, "id": 1, "method": method, "params": params})
    reply_json, out = dispatch(request, buffers or [])
    return json.loads(reply_json), out


def open_handle(path: Any) -> str:
    reply, _ = call(
        "session.open",
        {"name": "a.pdf", "data": {"$bin": 0}, "password": None},
        [path.read_bytes()],
    )
    assert reply["ok"] is True, reply
    return str(reply["result"]["handle"])


def page_px(handle: str, scale_milli: int = SCALE) -> tuple[int, int]:
    """The page image size at a scale, as render.page reports it."""
    reply, _ = call("session.pages", {"handle": handle})
    size = reply["result"]["pages"][0]
    return (
        math.ceil(float(size["width"]) * scale_milli / 1000),
        math.ceil(float(size["height"]) * scale_milli / 1000),
    )


def tile_params(handle: str, **overrides: Any) -> dict[str, Any]:
    params: dict[str, Any] = {
        "handle": handle,
        "page": 0,
        "revision": 0,
        "scale_milli": SCALE,
        "rotation": 0,
        "annotations": False,
        "tile_x": 0,
        "tile_y": 0,
        "tile_px": TILE,
    }
    params.update(overrides)
    return params


def current_revision(handle: str) -> int:
    reply, _ = call(
        "render.page",
        {
            "handle": handle,
            "page": 0,
            "revision": -1,
            "scale_milli": 1000,
            "rotation": 0,
            "annotations": False,
        },
    )
    assert reply["ok"] is True, reply
    return int(reply["result"]["revision"])


def tile(handle: str, **overrides: Any) -> tuple[dict[str, Any], bytes]:
    """The reply and the pixels (empty when the reply is an error)."""
    params = tile_params(handle, **overrides)
    if "revision" not in overrides:
        params["revision"] = current_revision(handle)
    reply, out = call("render.tile", params)
    if reply["ok"] is not True:
        assert out == []
        return reply, b""
    assert len(out) == 1
    return reply, out[0]


def page(handle: str, scale_milli: int = SCALE) -> tuple[int, int, bytes]:
    """The whole page image at a scale, from render.page."""
    reply, out = call(
        "render.page",
        {
            "handle": handle,
            "page": 0,
            "revision": current_revision(handle),
            "scale_milli": scale_milli,
            "rotation": 0,
            "annotations": False,
        },
    )
    assert reply["ok"] is True, reply
    return int(reply["result"]["width"]), int(reply["result"]["height"]), out[0]


def crop(pixels: bytes, full_w: int, x0: int, y0: int, w: int, h: int) -> bytes:
    """The w x h window at (x0, y0) of a full RGBA image of width full_w."""
    row = full_w * 4
    return b"".join(
        pixels[(y0 + y) * row + x0 * 4 : (y0 + y) * row + (x0 + w) * 4] for y in range(h)
    )


def test_a_full_tile_has_tile_px_pixels_and_matches_the_page(fixture_pdf: Any) -> None:
    handle = open_handle(fixture_pdf("text_multipage"))
    full_w, full_h, whole = page(handle)
    assert full_w > TILE and full_h > TILE, "the fixture page must span more than one tile"
    reply, pixels = tile(handle, tile_x=0, tile_y=0)
    assert reply["ok"] is True, reply
    result = reply["result"]
    assert result["width"] == TILE
    assert result["height"] == TILE
    assert result["format"] == "rgba"
    assert result["revision"] == current_revision(handle)
    assert len(pixels) == TILE * TILE * 4
    # The tile is the same device window of render.page, byte for byte. Measured at scale 2.0 on
    # this fixture: every pixel matches, edges included, for all four tiles of the 2 x 2 grid.
    assert pixels == crop(whole, full_w, 0, 0, TILE, TILE)


def test_an_edge_tile_is_clipped_at_the_page_edge(fixture_pdf: Any) -> None:
    handle = open_handle(fixture_pdf("text_multipage"))
    full_w, full_h, whole = page(handle)
    last_x = math.ceil(full_w / TILE) - 1
    last_y = math.ceil(full_h / TILE) - 1
    reply, pixels = tile(handle, tile_x=last_x, tile_y=last_y)
    assert reply["ok"] is True, reply
    width = reply["result"]["width"]
    height = reply["result"]["height"]
    assert width == full_w - last_x * TILE < TILE
    assert height == full_h - last_y * TILE < TILE
    assert len(pixels) == width * height * 4
    # Its pixels are the matching window of the page image, with the tile's own origin.
    assert pixels == crop(whole, full_w, last_x * TILE, last_y * TILE, width, height)


def test_the_same_tile_twice_gives_identical_bytes(fixture_pdf: Any) -> None:
    handle = open_handle(fixture_pdf("text_multipage"))
    _, first = tile(handle, tile_x=0, tile_y=1)
    _, second = tile(handle, tile_x=0, tile_y=1)
    assert first == second
    assert len(first) > 0


def test_a_tile_outside_the_grid_is_invalid_args(fixture_pdf: Any) -> None:
    handle = open_handle(fixture_pdf("text_multipage"))
    full_w, _ = page_px(handle)
    beyond = math.ceil(full_w / TILE)  # the first column with no pixels
    reply, _ = tile(handle, tile_x=beyond)
    assert reply["error"]["code"] == INVALID_ARGS
    assert reply["error"]["details"] == {"path": "params.tile_x"}
    reply, _ = tile(handle, tile_y=10_000)
    assert reply["error"]["code"] == INVALID_ARGS
    assert reply["error"]["details"] == {"path": "params.tile_y"}


@pytest.mark.parametrize(
    ("overrides", "path"),
    [
        ({"tile_x": -1}, "params.tile_x"),
        ({"tile_y": -1}, "params.tile_y"),
        ({"tile_px": 512}, "params.tile_px"),
        ({"tile_px": 2048}, "params.tile_px"),
        ({"page": -1}, "params.page"),
        ({"page": 10_000}, "params.page"),
        ({"scale_milli": 0}, "params.scale_milli"),
        ({"rotation": 45}, "params.rotation"),
        ({"tile_x": "0"}, "params.tile_x"),
        ({"annotations": 1}, "params.annotations"),
    ],
)
def test_bad_arguments_name_their_field(
    fixture_pdf: Any, overrides: dict[str, Any], path: str
) -> None:
    handle = open_handle(fixture_pdf("text_multipage"))
    reply, _ = tile(handle, **overrides)
    assert reply["error"]["code"] == INVALID_ARGS
    assert reply["error"]["details"] == {"path": path}


def test_a_missing_field_is_invalid_args(fixture_pdf: Any) -> None:
    handle = open_handle(fixture_pdf("text_multipage"))
    params = tile_params(handle, revision=current_revision(handle))
    del params["tile_px"]
    reply, _ = call("render.tile", params)
    assert reply["error"]["code"] == INVALID_ARGS
    assert reply["error"]["details"] == {"path": "params.tile_px"}


def test_an_unknown_field_is_invalid_args(fixture_pdf: Any) -> None:
    handle = open_handle(fixture_pdf("text_multipage"))
    params = tile_params(handle, revision=current_revision(handle), tile_size=1)
    reply, _ = call("render.tile", params)
    assert reply["error"]["code"] == INVALID_ARGS
    assert reply["error"]["details"] == {"path": "params.tile_size"}


def test_an_unknown_handle_is_no_document(fixture_pdf: Any) -> None:
    reply, _ = tile("00" * 16, revision=0)
    assert reply["error"]["code"] == NO_DOCUMENT


def test_a_tile_over_the_per_tile_limit_is_too_large(
    fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle = open_handle(fixture_pdf("text_multipage"))
    monkeypatch.setattr(limits, "MAX_TILE_PIXELS", 1000)
    reply, pixels = tile(handle, tile_x=0, tile_y=0)
    assert reply["error"]["code"] == RENDER_TOO_LARGE
    assert reply["error"]["details"] == {"max_pixels": 1000, "pixels": TILE * TILE}
    assert pixels == b""


def test_the_per_tile_limit_is_inclusive(fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    handle = open_handle(fixture_pdf("text_multipage"))
    monkeypatch.setattr(limits, "MAX_TILE_PIXELS", TILE * TILE)
    assert tile(handle, tile_x=0, tile_y=0)[0]["ok"] is True
    monkeypatch.setattr(limits, "MAX_TILE_PIXELS", TILE * TILE - 1)
    assert tile(handle, tile_x=0, tile_y=0)[0]["error"]["code"] == RENDER_TOO_LARGE


def test_a_stale_revision_returns_no_pixels_and_the_current_revision(fixture_pdf: Any) -> None:
    handle = open_handle(fixture_pdf("text_multipage"))
    revision = current_revision(handle)
    reply, pixels = tile(handle, revision=revision + 7)
    assert reply["ok"] is True, reply
    assert reply["result"]["width"] == 0
    assert reply["result"]["height"] == 0
    assert reply["result"]["revision"] == revision
    assert pixels == b""
