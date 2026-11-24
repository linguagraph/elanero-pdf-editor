"""Tolerance-based image comparison shared by the rendering and UI golden tests."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

BAD_LEVEL = 64  # a pixel "differs" when one channel moves by more than this


@dataclass(frozen=True)
class Tolerance:
    """Mean absolute difference over all channels, and the share of clearly different pixels.

    Together they let anti-aliasing noise through (small, spread out) but catch a moved,
    missing or recolored element (large, concentrated)."""

    max_mean: float
    max_bad_fraction: float


def save_png(image: np.ndarray, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(image).save(path, optimize=True)


def load_rgb(path: Path) -> np.ndarray:
    with Image.open(path) as im:
        return np.asarray(im.convert("RGB")).copy()


def rgba_to_rgb(rgba: np.ndarray) -> np.ndarray:
    """An RGBA image composited over white, as RGB (what a white page shows under it)."""
    alpha = rgba[..., 3:4].astype(np.float32) / 255
    over_white = rgba[..., :3].astype(np.float32) * alpha + 255 * (1 - alpha)
    return np.rint(over_white).astype(np.uint8)


def compare(actual: np.ndarray, reference: Path, tolerance: Tolerance, out_dir: Path) -> str | None:
    """None if ``actual`` matches the golden ``reference``, else why not.

    On a mismatch the actual image and an amplified difference image are written to
    ``out_dir`` (named after the reference), and the message says where.
    """
    return compare_arrays(actual, load_rgb(reference), tolerance, out_dir, reference.name)


def compare_arrays(
    actual: np.ndarray, expected: np.ndarray, tolerance: Tolerance, out_dir: Path, name: str
) -> str | None:
    """``compare`` for an expected image already in memory (a rotated or stitched reference).

    ``name`` names the written files, as the reference's file name does for ``compare``.
    """
    if expected.shape != actual.shape:
        out = out_dir / name
        save_png(actual, out)
        return f"{name}: size changed {expected.shape} -> {actual.shape}; actual: {out}"
    diff = np.abs(expected.astype(np.int16) - actual.astype(np.int16))
    mean = float(diff.mean())
    bad = float((diff.max(axis=2) > BAD_LEVEL).mean())
    if mean <= tolerance.max_mean and bad <= tolerance.max_bad_fraction:
        return None
    out = out_dir / name
    save_png(actual, out)
    diff_path = out.with_name(f"{out.stem}.diff.png")
    save_png(np.clip(diff * 4, 0, 255).astype(np.uint8), diff_path)
    return (
        f"{name} differs: mean diff {mean:.2f} (max {tolerance.max_mean}), "
        f"bad pixels {bad:.3%} (max {tolerance.max_bad_fraction:.3%}); "
        f"actual: {out}, diff: {diff_path}"
    )
