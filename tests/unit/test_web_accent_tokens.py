"""The web's accent presets match the desktop's build_colors (W4.5 S4, drift check).

The web generates its accent blocks from web/app/src/theme/tokens.ts into tokens.css; the desktop
derives the same accent shades in pdfeditor.ui.style.tokens.build_colors. This test reads the
committed stylesheet and checks each non-Blue preset against build_colors, so the two cannot
drift apart silently. Blue is the web's own dark blue (W4.5 D1) and has no block, so it is
checked only for its swatch.

It reads the web tree, so it is desktop_only (the Pyodide run does not have web/app).
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from pdfeditor.ui.style.tokens import ACCENT_PRESETS, DEFAULT_ACCENT, build_colors

pytestmark = pytest.mark.desktop_only

ROOT = Path(__file__).resolve().parents[2]
TOKENS_CSS = ROOT / "web" / "app" / "src" / "theme" / "tokens.css"

# The web's preset ids in the desktop's order (tokens.ts ACCENT_PRESETS).
WEB_ORDER = ["blue", "teal", "green", "purple", "pink", "red", "orange", "graphite"]


def _block(css: str, selector: str) -> dict[str, str]:
    """The custom properties of the first block whose selector line is ``selector``."""
    start = css.index(selector + " {")
    end = css.index("}", start)
    body = css[start:end]
    return {name: value for name, value in re.findall(r"(--[\w-]+): ([^;]+);", body)}


def _css() -> str:
    return TOKENS_CSS.read_text(encoding="utf-8")


def test_presets_are_the_desktop_order() -> None:
    assert [label.lower() for label, _ in ACCENT_PRESETS] == WEB_ORDER


@pytest.mark.parametrize(
    ("label", "hex_colour"),
    [(label, hex_colour) for label, hex_colour in ACCENT_PRESETS if label != "Blue"],
)
def test_accent_blocks_match_build_colors(label: str, hex_colour: str) -> None:
    css = _css()
    preset = label.lower()
    light = build_colors("light", hex_colour)
    dark = build_colors("dark", hex_colour)

    base = _block(css, f":root[data-accent='{preset}']")
    assert base["--color-accent"] == light.accent
    assert base["--color-on-accent"] == light.on_accent
    assert base["--color-accent-text"] == light.accent_text
    assert base["--color-focus-ring"] == light.accent_text

    system_dark = _block(css, f":root:not([data-theme='light'])[data-accent='{preset}']")
    forced_dark = _block(css, f":root[data-theme='dark'][data-accent='{preset}']")
    for dark_block in (system_dark, forced_dark):
        assert dark_block["--color-accent"] == dark.accent
        assert dark_block["--color-on-accent"] == dark.on_accent
        assert dark_block["--color-accent-text"] == dark.accent_text
        assert dark_block["--color-focus-ring"] == dark.accent_text


def test_blue_swatch_is_the_default_accent() -> None:
    css = _css()
    assert f"--accent-swatch-blue: {DEFAULT_ACCENT};" in css


@pytest.mark.parametrize(("label", "hex_colour"), ACCENT_PRESETS)
def test_swatch_is_the_light_fill(label: str, hex_colour: str) -> None:
    css = _css()
    expected = build_colors("light", hex_colour).accent
    assert f"--accent-swatch-{label.lower()}: {expected};" in css
