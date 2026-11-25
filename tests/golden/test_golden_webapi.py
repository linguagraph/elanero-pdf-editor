"""The web API's render calls (L2 of docs/web/design/W8.2-visual-golden.md) against the same
reference PNGs as the engine goldens in ``test_golden_render.py``.

Each case goes through ``webapi.dispatch``: ``render.page`` at scale 1.0 and rotation 0 must match
its reference, with the same tolerance. The RGBA reply is composited over white first. Runs on the
host and under Pyodide (no desktop-only imports, no new PNGs).
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from pdfeditor.webapi import dispatch
from pdfeditor.webapi.registry import REGISTRY
from tests.golden.compare import compare, compare_arrays, load_rgb, rgba_to_rgb
from tests.golden.test_golden_render import CASES, DATA, REDACTED, TOLERANCE, UPDATE_HINT

ACTUAL = Path(__file__).parent / "_actual"

# The redaction case needs the web's redaction job (marks, apply, then render), which these
# render calls do not cover; it stays with the engine goldens in test_golden_render.py.
WEB_CASES = [(name, page) for name, page in CASES if name != REDACTED]

# Three cases for the quarter turn: text, an image and CJK text.
ROTATED_CASES = [("text_multipage", 0), ("images", 0), ("cjk_text", 0)]

# The tile seam test: text_multipage at scale 3.0, a 2 x 2 grid of 1024-pixel tiles.
SEAM_SCALE = 3000
TILE_PX = 1024


@pytest.fixture(autouse=True)
def _no_documents_left_open() -> Iterator[None]:
    yield
    REGISTRY.close_all()


def call(method: str, params: dict[str, Any], buffers: list[bytes] | None = None) -> Any:
    request = json.dumps({"v": 1, "id": 1, "method": method, "params": params})
    reply_json, out = dispatch(request, buffers or [])
    return json.loads(reply_json), out


def open_handle(path: Path) -> str:
    reply, _ = call(
        "session.open",
        {"name": "a.pdf", "data": {"$bin": 0}, "password": None},
        [path.read_bytes()],
    )
    assert reply["ok"] is True, reply
    return str(reply["result"]["handle"])


def render_params(handle: str, page: int, revision: int, **overrides: Any) -> dict[str, Any]:
    # annotations is on, as in the engine goldens (RenderRequest's default).
    params: dict[str, Any] = {
        "handle": handle,
        "page": page,
        "revision": revision,
        "scale_milli": 1000,
        "rotation": 0,
        "annotations": True,
    }
    params.update(overrides)
    return params


def current_revision(handle: str, page: int) -> int:
    # A revision that can't match: the reply has no pixels and names the current revision.
    reply, _ = call("render.page", render_params(handle, page, -1))
    assert reply["ok"] is True, reply
    return int(reply["result"]["revision"])


def render_rgb(path: Path, page: int, **overrides: Any) -> np.ndarray:
    """``render.page`` of one page of ``path``, as an RGB array over white."""
    handle = open_handle(path)
    try:
        params = render_params(handle, page, current_revision(handle, page), **overrides)
        reply, out = call("render.page", params)
        assert reply["ok"] is True, reply
        assert len(out) == 1
        width = int(reply["result"]["width"])
        height = int(reply["result"]["height"])
        rgba = np.frombuffer(out[0], dtype=np.uint8).reshape(height, width, 4)
        return rgba_to_rgb(rgba)
    finally:
        REGISTRY.close_all()


def _reference(name: str, page: int) -> Path:
    path = DATA / f"{name}-p{page}.png"
    if not path.exists():
        pytest.fail(f"missing reference {path.name}: generate it with `{UPDATE_HINT}`")
    return path


@pytest.mark.parametrize(("name", "page"), WEB_CASES, ids=[f"{n}-p{p}" for n, p in WEB_CASES])
def test_web_render_matches_golden(name: str, page: int, fixture_pdf) -> None:
    actual = render_rgb(fixture_pdf(name), page)
    problem = compare(actual, _reference(name, page), TOLERANCE, ACTUAL)
    if problem:
        pytest.fail(problem)


@pytest.mark.parametrize(
    ("name", "page"), ROTATED_CASES, ids=[f"{n}-p{p}-rot90" for n, p in ROTATED_CASES]
)
def test_web_quarter_turn_matches_rotated_golden(name: str, page: int, fixture_pdf) -> None:
    actual = render_rgb(fixture_pdf(name), page, rotation=90)
    # A quarter turn clockwise on screen: the reference turned by np.rot90 with k=-1.
    expected = np.rot90(load_rgb(_reference(name, page)), k=-1)
    problem = compare_arrays(actual, expected, TOLERANCE, ACTUAL, f"{name}-p{page}-rot90.png")
    if problem:
        pytest.fail(problem)


def test_tile_grid_matches_the_whole_page(fixture_pdf) -> None:
    """A 2 x 2 grid of render.tile replies, stitched, equals render.page at the same scale."""
    path = fixture_pdf("text_multipage")
    handle = open_handle(path)
    try:
        revision = current_revision(handle, 0)
        whole_reply, whole_out = call(
            "render.page", render_params(handle, 0, revision, scale_milli=SEAM_SCALE)
        )
        assert whole_reply["ok"] is True, whole_reply
        whole_w = int(whole_reply["result"]["width"])
        whole_h = int(whole_reply["result"]["height"])
        whole = rgba_to_rgb(np.frombuffer(whole_out[0], np.uint8).reshape(whole_h, whole_w, 4))

        tiles: dict[tuple[int, int], np.ndarray] = {}
        for ty in (0, 1):
            for tx in (0, 1):
                reply, out = call(
                    "render.tile",
                    {
                        "handle": handle,
                        "page": 0,
                        "revision": revision,
                        "scale_milli": SEAM_SCALE,
                        "rotation": 0,
                        "annotations": True,
                        "tile_x": tx,
                        "tile_y": ty,
                        "tile_px": TILE_PX,
                    },
                )
                assert reply["ok"] is True, reply
                width = int(reply["result"]["width"])
                height = int(reply["result"]["height"])
                rgba = np.frombuffer(out[0], np.uint8).reshape(height, width, 4)
                tiles[(ty, tx)] = rgba_to_rgb(rgba)
    finally:
        REGISTRY.close_all()

    # Each row of tiles is as tall as its first tile; the right column is clipped by the page.
    stitched = np.vstack([np.hstack([tiles[(ty, 0)], tiles[(ty, 1)]]) for ty in (0, 1)])
    # The grid covers the page's top-left 2048 x 2048 window (the page itself is clipped).
    window = whole[: stitched.shape[0], : stitched.shape[1]]
    problem = compare_arrays(stitched, window, TOLERANCE, ACTUAL, "text_multipage-p0-tile-seam.png")
    if problem:
        pytest.fail(problem)
