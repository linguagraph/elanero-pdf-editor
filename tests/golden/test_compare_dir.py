"""The host compare of the browser renders (compare_dir.py) against tests/golden/data."""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

from tests.golden import compare_dir
from tests.golden.compare import load_rgb
from tests.golden.test_golden_render import TOLERANCE as ENGINE_TOLERANCE


def test_tolerance_is_the_engine_tolerance() -> None:
    # The browser renders are judged by the same numbers as the engine goldens (D4).
    assert compare_dir.TOLERANCE == ENGINE_TOLERANCE


def test_a_matching_render_passes(tmp_path: Path) -> None:
    reference = compare_dir.DATA / "images-p0.png"
    rgb = load_rgb(reference)
    rgba = np.dstack([rgb, np.full(rgb.shape[:2], 255, dtype=np.uint8)])
    rendered = tmp_path / "rendered"
    rendered.mkdir()
    Image.fromarray(rgba).save(rendered / "images-p0.png")
    # Only one render exists, so the other references are reported missing; check this one alone.
    problems = compare_dir.compare_folder(rendered, tmp_path / "diff")
    assert not any(p.startswith("images-p0.png") for p in problems)


def test_a_missing_render_is_a_problem(tmp_path: Path) -> None:
    problems = compare_dir.compare_folder(tmp_path, tmp_path / "diff")
    assert any("images-p0.png: no browser render" in p for p in problems)
    assert not any("sensitive-redacted" in p for p in problems)


def test_a_moved_render_fails_with_a_diff_image(tmp_path: Path) -> None:
    rgb = load_rgb(compare_dir.DATA / "images-p0.png")
    rgb[:] = 255  # a blank page where the images should be
    rgba = np.dstack([rgb, np.full(rgb.shape[:2], 255, dtype=np.uint8)])
    rendered = tmp_path / "rendered"
    rendered.mkdir()
    Image.fromarray(rgba).save(rendered / "images-p0.png")
    out = tmp_path / "diff"
    problems = compare_dir.compare_folder(rendered, out)
    assert any(p.startswith("images-p0.png differs") for p in problems)
    assert (out / "images-p0.png").exists()
    assert (out / "images-p0.diff.png").exists()
