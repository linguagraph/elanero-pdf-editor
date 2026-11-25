"""The host compare of the browser renders (compare_dir.py) against tests/golden/data."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from tests.golden import compare_dir
from tests.golden.compare import load_rgb
from tests.golden.test_golden_render import TOLERANCE as ENGINE_TOLERANCE


def test_tolerance_is_the_engine_tolerance() -> None:
    # The browser renders are judged by the same numbers as the engine goldens (D4).
    assert compare_dir.TOLERANCE == ENGINE_TOLERANCE


def _write_render(rendered: Path, name: str, rgb: np.ndarray) -> None:
    rgba = np.dstack([rgb, np.full(rgb.shape[:2], 255, dtype=np.uint8)])
    Image.fromarray(rgba).save(rendered / name)


def _render_every_reference(rendered: Path) -> None:
    """Write each golden reference as an opaque render, the way a matching browser render looks."""
    rendered.mkdir(parents=True, exist_ok=True)
    for reference in compare_dir.DATA.glob("*.png"):
        if reference.name not in compare_dir.ENGINE_ONLY:
            _write_render(rendered, reference.name, load_rgb(reference))


def test_a_matching_render_passes(tmp_path: Path) -> None:
    rendered = tmp_path / "rendered"
    _render_every_reference(rendered)
    assert compare_dir.compare_folder(rendered, tmp_path / "diff") == []


def test_all_matching_renders_exit_zero(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    # The full run: main() reports the count after the comparison, which once crashed (len of a
    # generator) only when every render matched.
    rendered = tmp_path / "rendered"
    _render_every_reference(rendered)
    assert compare_dir.main([str(rendered), "--out", str(tmp_path / "diff")]) == 0
    assert "all browser renders match" in capsys.readouterr().out


def test_an_unexpected_render_fails(tmp_path: Path) -> None:
    rendered = tmp_path / "rendered"
    _render_every_reference(rendered)
    _write_render(rendered, "unexpected.png", load_rgb(compare_dir.DATA / "images-p0.png"))
    problems = compare_dir.compare_folder(rendered, tmp_path / "diff")
    assert any(p.startswith("unexpected.png: rendered but has no reference") for p in problems)
    assert len(problems) == 1


def test_a_render_of_the_wrong_size_fails(tmp_path: Path) -> None:
    rgb = load_rgb(compare_dir.DATA / "images-p0.png")
    rendered = tmp_path / "rendered"
    _render_every_reference(rendered)
    _write_render(rendered, "images-p0.png", rgb[:-1])  # one pixel row short
    out = tmp_path / "diff"
    problems = compare_dir.compare_folder(rendered, out)
    assert any(p.startswith("images-p0.png: size changed") for p in problems)
    assert (out / "images-p0.png").exists()


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
