"""The perf-trend workflow and the desktop perf uploads (W8.3 S5b) are wired as the design says.

These read the YAML, so they run on every PR without GitHub or the gh CLI. They check the shape of
``perf-trend.yml``, the two upload steps in ``ci.yml`` and the attempt wiring in ``web-perf.yml``
(docs/web/design/W8.3-s5-trend-log.md, sections 2.1 to 2.3).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import yaml

pytestmark = pytest.mark.desktop_only

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"
PERF_TREND = WORKFLOWS / "perf-trend.yml"
CI = WORKFLOWS / "ci.yml"
WEB_PERF = WORKFLOWS / "web-perf.yml"


def _load(path: Path) -> dict[str, Any]:
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert isinstance(doc, dict), f"{path.name} is not a mapping"
    return doc


def _triggers(doc: dict[str, Any]) -> dict[str, Any]:
    # YAML 1.1 reads the bare key ``on`` as the boolean True; accept either spelling.
    triggers = doc.get("on", doc.get(True))
    assert isinstance(triggers, dict), "the workflow has no triggers"
    return triggers


def _steps(job: dict[str, Any]) -> list[dict[str, Any]]:
    steps = job.get("steps")
    assert isinstance(steps, list), "the job has no steps"
    return steps


def _step(job: dict[str, Any], name: str) -> dict[str, Any]:
    matches = [s for s in _steps(job) if s.get("name") == name]
    assert len(matches) == 1, f"expected one step named {name!r}, found {len(matches)}"
    return matches[0]


def _perf_trend_job() -> dict[str, Any]:
    jobs = _load(PERF_TREND)["jobs"]
    assert set(jobs) == {"perf-trend"}
    return jobs["perf-trend"]


def test_perf_trend_triggers_on_the_two_scheduled_workflows() -> None:
    triggers = _triggers(_load(PERF_TREND))
    run = triggers["workflow_run"]
    assert run["workflows"] == ["CI", "Web perf (W8.3)"]
    assert run["types"] == ["completed"]
    dispatch = triggers["workflow_dispatch"]["inputs"]["run_id"]
    assert dispatch["required"] is True
    assert "pull_request" not in triggers
    assert "pull_request_target" not in triggers


def test_perf_trend_permissions_are_the_two_read_scopes() -> None:
    assert _load(PERF_TREND)["permissions"] == {"contents": "read", "actions": "read"}


def test_perf_trend_runs_only_for_scheduled_runs_of_main_in_this_repository() -> None:
    condition = _perf_trend_job()["if"]
    assert "workflow_dispatch" in condition
    assert "github.event.workflow_run.event == 'schedule'" in condition
    assert "github.event.workflow_run.head_branch == 'main'" in condition
    assert "github.event.workflow_run.head_repository.full_name == github.repository" in condition


def test_perf_trend_never_checks_out_the_triggering_runs_code() -> None:
    for step in _steps(_perf_trend_job()):
        ref = str((step.get("with") or {}).get("ref", ""))
        assert "workflow_run" not in ref
        assert "head_sha" not in ref
        assert "head_branch" not in ref


def test_perf_trend_writes_the_script_output_to_the_summary_with_gh_token() -> None:
    step = _step(_perf_trend_job(), "Write the trend to the job summary")
    assert "scripts/perf_trend.py --run-id" in step["run"]
    assert step["run"].rstrip().endswith('>> "$GITHUB_STEP_SUMMARY"')
    assert step["env"]["GH_TOKEN"] == "${{ github.token }}"


def _desktop_upload(job: dict[str, Any], name_prefix: str) -> dict[str, Any]:
    uploads = [
        s
        for s in _steps(job)
        if str(s.get("uses", "")).startswith("actions/upload-artifact@")
        and str(s["with"]["name"]).startswith(name_prefix)
    ]
    assert len(uploads) == 1, f"expected one {name_prefix} upload, found {len(uploads)}"
    return uploads[0]


@pytest.mark.parametrize(
    ("job_name", "os_name"), [("test-windows", "windows"), ("test-linux", "linux")]
)
def test_ci_uploads_the_desktop_perf_results_off_pull_requests(job_name: str, os_name: str) -> None:
    job = _load(CI)["jobs"][job_name]
    upload = _desktop_upload(job, f"perf-desktop-{os_name}-")
    assert "always()" in upload["if"]
    assert "github.event_name != 'pull_request'" in upload["if"]
    assert upload["with"]["path"] == ".perf/perf-results.json"
    assert upload["with"]["retention-days"] == 90
    assert upload["with"]["if-no-files-found"] == "warn"


def test_ci_and_web_perf_keep_contents_read_and_gain_no_actions_scope() -> None:
    assert _load(CI)["permissions"] == {"contents": "read"}
    assert _load(WEB_PERF)["permissions"] == {"contents": "read"}


def test_web_perf_sets_perf_attempt_per_attempt() -> None:
    jobs = _load(WEB_PERF)["jobs"]["web-perf"]
    assert _step(jobs, "Run the interleaved rounds (attempt 1)")["env"]["PERF_ATTEMPT"] == "1"
    assert (
        _step(jobs, "Run the rounds again (attempt 2, after a failed compare)")["env"][
            "PERF_ATTEMPT"
        ]
        == "2"
    )
