"""docs/guide/keyboard-shortcuts.md is generated from the main window's commands: it must be
regenerated (scripts/make_shortcut_docs.py) whenever a command or its shortcut changes."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# The page lists the platform's own standard shortcuts (Redo, Save As, ...), which differ per
# OS. It is generated and checked on Windows, the platform the app ships for.
pytestmark = [
    pytest.mark.gui,
    pytest.mark.skipif(sys.platform != "win32", reason="the committed page is the Windows one"),
]

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import make_shortcut_docs  # noqa: E402


def test_the_keyboard_shortcut_page_is_up_to_date() -> None:
    committed = make_shortcut_docs.OUTPUT.read_text(encoding="utf-8")
    page, _ = make_shortcut_docs.render_outputs()
    assert page == committed, (
        "docs/guide/keyboard-shortcuts.md is out of date: run "
        "`uv run python scripts/make_shortcut_docs.py`"
    )


def test_the_web_shortcut_table_is_up_to_date() -> None:
    """The web front end reads web/src/generated/shortcuts.json; it must match the desktop."""
    committed = make_shortcut_docs.WEB_OUTPUT.read_text(encoding="utf-8")
    _, table = make_shortcut_docs.render_outputs()
    assert table == committed, (
        "web/src/generated/shortcuts.json is out of date: run "
        "`uv run python scripts/make_shortcut_docs.py`"
    )


def test_the_shortcut_page_lists_the_help_command_on_f1() -> None:
    page = make_shortcut_docs.OUTPUT.read_text(encoding="utf-8")
    assert "| Elanero Help | F1 |" in page
