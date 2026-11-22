"""The translation hosts agree in both halves of the web app: the Python transport's origins and the
engine worker's gate (W6.6 section 3). The Vitest side checks the gate's list against the CSP.

This reads the TypeScript source, so it runs only on the desktop.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from pdfeditor.services.translation.web_http import WEB_ENDPOINT_ORIGINS

pytestmark = pytest.mark.desktop_only

ROOT = Path(__file__).resolve().parents[2]


def test_the_engine_gate_lists_the_same_origins_as_the_python_transport() -> None:
    source = (ROOT / "web" / "app" / "src" / "engine" / "translationNet.ts").read_text(
        encoding="utf-8"
    )
    block = re.search(r"TRANSLATION_ORIGINS[^=]*=\s*\[(.*?)\];", source, re.S)
    assert block is not None, "TRANSLATION_ORIGINS not found in translationNet.ts"
    origins = set(re.findall(r"'(https://[^']+)'", block.group(1)))
    assert origins == set(WEB_ENDPOINT_ORIGINS)
