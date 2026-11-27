"""The manual ``web-e2e`` run can pick one browser (W8.5 slice 1, #420); the nightly stays Chromium.

These read the YAML, so they run on every PR without a browser
(docs/web/design/W8.5-webkit-csp.md, section 2.2).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
WEB_E2E = ROOT / ".github" / "workflows" / "web-e2e.yml"


def _doc() -> dict[str, Any]:
    doc = yaml.safe_load(WEB_E2E.read_text(encoding="utf-8"))
    assert isinstance(doc, dict)
    return doc


def test_browsers_input_offers_each_browser_and_all() -> None:
    # `on` is read as True by YAML 1.1 loaders, so look it up under both keys.
    triggers = _doc().get("on", _doc().get(True))
    options = triggers["workflow_dispatch"]["inputs"]["browsers"]["options"]
    assert options == ["chromium", "webkit", "firefox", "all"]


def test_matrix_expression_maps_the_choices_and_keeps_the_nightly_on_chromium() -> None:
    matrix = _doc()["jobs"]["web-e2e"]["strategy"]["matrix"]["browser"]
    # The schedule has no inputs, so it must be checked first; then `all`; then one browser by name.
    assert "github.event_name == 'schedule'" in matrix
    assert '["chromium"]' in matrix
    assert '["chromium","firefox","webkit"]' in matrix
    assert "format('[\"{0}\"]', inputs.browsers)" in matrix
