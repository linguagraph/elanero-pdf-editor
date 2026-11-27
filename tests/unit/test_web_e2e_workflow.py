"""The manual ``web-e2e`` run can pick one browser (W8.5 slice 1, #420); the nightly stays Chromium.

These read the YAML, so they run on every PR without a browser
(docs/web/design/W8.5-webkit-csp.md, section 2.2).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import yaml

pytestmark = pytest.mark.desktop_only

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


def _expanded_jobs() -> list[dict[str, str]]:
    # GitHub runs the cross product of the matrix keys, minus each `exclude` entry it matches.
    # The browser list is an expression, so the jobs are built here for each browser it can pick.
    matrix = _doc()["jobs"]["web-e2e"]["strategy"]["matrix"]
    jobs = []
    for browser in ("chromium", "firefox", "webkit"):
        for shard in matrix["shard"]:
            job = {"browser": browser, "shard": shard}
            if not any(all(job.get(k) == v for k, v in ex.items()) for ex in matrix["exclude"]):
                jobs.append(job)
    return jobs


def test_shard_matrix_gives_one_chromium_job_and_three_shards_for_webkit_and_firefox() -> None:
    jobs = _expanded_jobs()
    shards = {
        browser: sorted(j["shard"] for j in jobs if j["browser"] == browser)
        for browser in ("chromium", "firefox", "webkit")
    }
    assert shards == {
        "chromium": ["1/1"],
        "firefox": ["1/3", "2/3", "3/3"],
        "webkit": ["1/3", "2/3", "3/3"],
    }


def test_feature_step_runs_its_shard_and_artifacts_carry_the_shard() -> None:
    steps = _doc()["jobs"]["web-e2e"]["steps"]
    feature = next(s for s in steps if s.get("id") == "features")
    assert "--shard=${{ matrix.shard }}" in feature["run"]
    assert "--reporter=list,html" in feature["run"]
    upload = next(
        s
        for s in steps
        if str(s.get("uses", "")).startswith("actions/upload-artifact")
        and "web-e2e-" in str(s["with"]["name"])
    )
    assert "matrix.shard" in upload["with"]["name"]
