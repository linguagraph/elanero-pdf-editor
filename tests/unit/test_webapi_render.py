"""The render call of W3.3 (``render.page``) through dispatch, on a real fixture, host CPython.

Pixels come back as the reply's buffers, so the helpers here return both the JSON reply and the
buffers, unlike the session tests, whose calls return no bytes.
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


def render_params(handle: str, **overrides: Any) -> dict[str, Any]:
    params: dict[str, Any] = {
        "handle": handle,
        "page": 0,
        "revision": 0,
        "scale_milli": 1000,
        "rotation": 0,
        "annotations": False,
    }
    params.update(overrides)
    return params


def render(handle: str, **overrides: Any) -> tuple[dict[str, Any], bytes]:
    """The reply and the pixels (empty when the reply is an error)."""
    reply, out = call("render.page", render_params(handle, **overrides))
    if reply["ok"] is not True:
        assert out == []
        return reply, b""
    assert len(out) == 1
    return reply, out[0]


def current_revision(handle: str, page: int = 0) -> int:
    # A revision that can't match: the reply has no pixels and names the current revision.
    reply, _ = render(handle, page=page, revision=-1)
    assert reply["ok"] is True, reply
    return int(reply["result"]["revision"])


def page_size(handle: str, page: int = 0) -> tuple[float, float]:
    reply, _ = call("session.pages", {"handle": handle})
    size = reply["result"]["pages"][page]
    return float(size["width"]), float(size["height"])


def test_render_returns_rgba_pixels_of_the_page_size(fixture_pdf: Any) -> None:
    handle = open_handle(fixture_pdf("text_multipage"))
    width, height = page_size(handle)
    reply, pixels = render(handle, revision=current_revision(handle))
    assert reply["ok"] is True, reply
    result = reply["result"]
    assert result["format"] == "rgba"
    assert result["width"] == math.ceil(width)
    assert result["height"] == math.ceil(height)
    assert result["pixels"] == {"$bin": 0}  # the pixels are the reply's buffer, not JSON numbers
    assert len(pixels) == result["width"] * result["height"] * 4
    # The page has text, so some pixels are opaque and dark: the image is not blank.
    assert any(a == 255 and r < 128 for a, r in zip(pixels[3::4], pixels[0::4], strict=False))


def test_the_same_request_gives_identical_bytes(fixture_pdf: Any) -> None:
    handle = open_handle(fixture_pdf("text_multipage"))
    revision = current_revision(handle)
    _, first = render(handle, revision=revision, scale_milli=1500)
    _, second = render(handle, revision=revision, scale_milli=1500)
    assert first == second
    assert len(first) > 0


def test_a_larger_scale_gives_proportionally_more_pixels(fixture_pdf: Any) -> None:
    handle = open_handle(fixture_pdf("text_multipage"))
    revision = current_revision(handle)
    small, _ = render(handle, revision=revision, scale_milli=1000)
    large, _ = render(handle, revision=revision, scale_milli=2000)
    assert abs(large["result"]["width"] - 2 * small["result"]["width"]) <= 2
    assert abs(large["result"]["height"] - 2 * small["result"]["height"]) <= 2


def test_a_quarter_turn_swaps_the_width_and_height(fixture_pdf: Any) -> None:
    handle = open_handle(fixture_pdf("text_multipage"))
    revision = current_revision(handle)
    upright, _ = render(handle, revision=revision)
    turned, pixels = render(handle, revision=revision, rotation=90)
    assert turned["result"]["width"] == upright["result"]["height"]
    assert turned["result"]["height"] == upright["result"]["width"]
    assert len(pixels) == turned["result"]["width"] * turned["result"]["height"] * 4


def test_a_stale_revision_returns_no_pixels_and_the_current_revision(fixture_pdf: Any) -> None:
    handle = open_handle(fixture_pdf("text_multipage"))
    revision = current_revision(handle)
    reply, pixels = render(handle, revision=revision + 7)
    assert reply["ok"] is True, reply
    assert reply["result"]["width"] == 0
    assert reply["result"]["height"] == 0
    assert reply["result"]["revision"] == revision
    assert pixels == b""


def test_an_unknown_handle_is_no_document(fixture_pdf: Any) -> None:
    reply, _ = render("00" * 16)
    assert reply["error"]["code"] == NO_DOCUMENT


def test_a_page_past_the_end_is_invalid_args(fixture_pdf: Any) -> None:
    handle = open_handle(fixture_pdf("text_multipage"))
    reply, _ = render(handle, page=10_000)
    assert reply["error"]["code"] == INVALID_ARGS
    assert reply["error"]["details"] == {"path": "params.page"}


def test_a_negative_page_is_invalid_args(fixture_pdf: Any) -> None:
    handle = open_handle(fixture_pdf("text_multipage"))
    reply, _ = render(handle, page=-1)
    assert reply["error"]["code"] == INVALID_ARGS
    assert reply["error"]["details"] == {"path": "params.page"}


@pytest.mark.parametrize(
    ("overrides", "path"),
    [
        ({"scale_milli": 0}, "params.scale_milli"),
        ({"scale_milli": "1000"}, "params.scale_milli"),
        ({"rotation": 45}, "params.rotation"),
        ({"annotations": 1}, "params.annotations"),
        ({"revision": 1.5}, "params.revision"),
    ],
)
def test_bad_arguments_name_their_field(
    fixture_pdf: Any, overrides: dict[str, Any], path: str
) -> None:
    handle = open_handle(fixture_pdf("text_multipage"))
    reply, _ = render(handle, **overrides)
    assert reply["error"]["code"] == INVALID_ARGS
    assert reply["error"]["details"] == {"path": path}


def test_a_missing_field_is_invalid_args(fixture_pdf: Any) -> None:
    handle = open_handle(fixture_pdf("text_multipage"))
    params = render_params(handle)
    del params["scale_milli"]
    reply, _ = call("render.page", params)
    assert reply["error"]["code"] == INVALID_ARGS
    assert reply["error"]["details"] == {"path": "params.scale_milli"}


def test_an_unknown_field_is_invalid_args(fixture_pdf: Any) -> None:
    handle = open_handle(fixture_pdf("text_multipage"))
    reply, _ = call("render.page", render_params(handle, tile_x=0))
    assert reply["error"]["code"] == INVALID_ARGS
    assert reply["error"]["details"] == {"path": "params.tile_x"}


def test_a_scale_above_the_limit_is_too_large(fixture_pdf: Any) -> None:
    handle = open_handle(fixture_pdf("text_multipage"))
    over = limits.MAX_RENDER_SCALE_MILLI + 1
    reply, _ = render(handle, scale_milli=over)
    assert reply["error"]["code"] == RENDER_TOO_LARGE
    assert reply["error"]["details"] == {
        "max_scale_milli": limits.MAX_RENDER_SCALE_MILLI,
        "scale_milli": over,
    }


def test_a_page_above_the_pixel_limit_is_too_large(
    fixture_pdf: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle = open_handle(fixture_pdf("text_multipage"))
    monkeypatch.setattr(limits, "MAX_RENDER_PIXELS", 1000)
    reply, pixels = render(handle, scale_milli=1000)
    assert reply["error"]["code"] == RENDER_TOO_LARGE
    assert reply["error"]["details"]["max_pixels"] == 1000
    assert reply["error"]["details"]["pixels"] > 1000
    assert pixels == b""


def test_the_default_pixel_limit_refuses_a_huge_scale(fixture_pdf: Any) -> None:
    handle = open_handle(fixture_pdf("text_multipage"))
    # 200x a letter-sized page is far above 64 MP, and the scale itself is under the scale cap.
    reply, _ = render(handle, scale_milli=200_000)
    assert reply["error"]["code"] == RENDER_TOO_LARGE
    assert reply["error"]["details"]["max_pixels"] == limits.MAX_RENDER_PIXELS
