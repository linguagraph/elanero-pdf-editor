"""The ``web-browser`` job in ``ci.yml`` (W9.1) runs the PR-level browser specs, as the design says.

These read the YAML, so they run on every PR without a browser. They check the shape of the job,
not the Playwright results: the job runs only on GitHub (docs/web/design/W9.1, section 2).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import yaml

pytestmark = pytest.mark.desktop_only

ROOT = Path(__file__).resolve().parents[2]
CI = ROOT / ".github" / "workflows" / "ci.yml"
WEB_PYTEST = ROOT / ".github" / "workflows" / "web-pytest.yml"
E2E = ROOT / "web" / "app" / "e2e"
JOB = "web-browser"

# The specs that run on every pull request (the eleven root-level app specs with no long document,
# visual golden or key probe). A new spec in e2e/ must be listed here or excluded below.
PR_SPECS = (
    "app-start",
    "engine-load",
    "file-launch",
    "forced-colours",
    "layout",
    "open-during-load",
    "open-recent",
    "pwa",
    "recent-previews",
    "ribbon",
    "split-job",
)
EXCLUDED_PREFIXES = ("long-document", "visual", "keys")

# The check names that branch protection requires (AGENTS.md, Git workflow). The job must
# not use one.
REQUIRED_CHECKS = {
    "changes",
    "checks",
    "test-windows",
    "build",
    "web",
    "web-tests / web-pytest",
    "test-linux",
}


def _load(path: Path) -> dict[str, Any]:
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert isinstance(doc, dict), f"{path.name} is not a mapping"
    return doc


def _job(doc: dict[str, Any]) -> dict[str, Any]:
    jobs = doc["jobs"]
    assert JOB in jobs, f"ci.yml has no {JOB!r} job"
    job = jobs[JOB]
    assert isinstance(job, dict)
    return job


def _steps(job: dict[str, Any]) -> list[dict[str, Any]]:
    steps = job.get("steps")
    assert isinstance(steps, list), "the job has no steps"
    return steps


def _cache_step(steps: list[dict[str, Any]]) -> dict[str, Any]:
    for step in steps:
        if str(step.get("uses", "")).startswith("actions/cache@"):
            return step
    raise AssertionError("no actions/cache step")


def _run_with(steps: list[dict[str, Any]], needle: str) -> str:
    for step in steps:
        run = str(step.get("run", ""))
        if needle in run:
            return run
    raise AssertionError(f"no step runs {needle!r}")


def test_web_browser_job_exists_and_is_not_a_required_check() -> None:
    job = _job(_load(CI))
    name = job.get("name", JOB)
    assert name not in REQUIRED_CHECKS
    assert JOB not in REQUIRED_CHECKS


def test_web_browser_needs_web_tests() -> None:
    # After web-tests: it reuses the wheel cache that job fills, so it runs once that job is done.
    needs = _job(_load(CI))["needs"]
    assert "web-tests" in needs
    assert "changes" in needs


def test_web_browser_cache_key_matches_web_pytest() -> None:
    # The same key as web-pytest.yml, so a cache written there is restored here.
    ci_cache = _cache_step(_steps(_job(_load(CI))))
    wp_cache = next(
        step
        for step in _steps(_load(WEB_PYTEST)["jobs"]["web-pytest"])
        if step.get("id") == "wheel-cache"
    )
    assert ci_cache["with"]["key"] == wp_cache["with"]["key"]
    assert ci_cache["with"]["path"] == wp_cache["with"]["path"]


def test_web_browser_stages_engine_and_runs_chromium_specs() -> None:
    steps = _steps(_job(_load(CI)))
    assert "stage_engine_assets.mjs" in _run_with(steps, "stage_engine_assets.mjs")
    playwright = _run_with(steps, "npx playwright test")
    assert "--project=chromium" in playwright


@pytest.mark.parametrize("spec", PR_SPECS)
def test_web_browser_runs_each_pr_spec(spec: str) -> None:
    steps = _steps(_job(_load(CI)))
    playwright = _run_with(steps, "npx playwright test")
    assert f"{spec}.spec.ts" in playwright


def test_pr_specs_are_all_root_specs_except_the_excluded_ones() -> None:
    # A new spec under e2e/ is caught here until it is listed in PR_SPECS or excluded on purpose.
    found = {
        path.name[: -len(".spec.ts")]
        for path in E2E.glob("*.spec.ts")
        if not path.name.startswith(EXCLUDED_PREFIXES)
    }
    assert found == set(PR_SPECS), (
        f"specs not in the PR list: {sorted(found - set(PR_SPECS))}; "
        f"listed but missing: {sorted(set(PR_SPECS) - found)}"
    )
