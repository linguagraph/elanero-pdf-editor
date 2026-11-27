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


def test_perf_trend_triggers_on_a_nightly_schedule_and_manual_dispatch() -> None:
    triggers = _triggers(_load(PERF_TREND))
    # 07:00 UTC, after CI (03:00) and Web perf (05:00).
    assert triggers["schedule"] == [{"cron": "0 7 * * *"}]
    dispatch = triggers["workflow_dispatch"]["inputs"]["run_id"]
    assert dispatch["required"] is True
    assert set(triggers) == {"schedule", "workflow_dispatch"}


def test_perf_trend_has_no_workflow_run_trigger() -> None:
    # workflow_run fired after every completed CI or Web perf run on main, so every push started it.
    triggers = _triggers(_load(PERF_TREND))
    assert "workflow_run" not in triggers
    assert "pull_request" not in triggers
    assert "pull_request_target" not in triggers


def test_perf_trend_permissions_are_the_two_read_scopes() -> None:
    assert _load(PERF_TREND)["permissions"] == {"contents": "read", "actions": "read"}


def test_perf_trend_checkout_keeps_credentials_off_and_pins_no_ref() -> None:
    checkouts = [
        s
        for s in _steps(_perf_trend_job())
        if str(s.get("uses", "")).startswith("actions/checkout@")
    ]
    assert len(checkouts) == 1
    assert checkouts[0]["with"] == {"persist-credentials": False}


def test_perf_trend_finds_the_latest_scheduled_run_of_each_workflow_on_main() -> None:
    step = _step(_perf_trend_job(), "Find the latest scheduled runs")
    assert step["if"] == "github.event_name == 'schedule'"
    assert step["env"]["GH_TOKEN"] == "${{ github.token }}"
    run = step["run"]
    assert 'gh run list --workflow "$workflow" --branch main --event schedule --limit 1' in run
    assert "--json databaseId --jq '.[0].databaseId'" in run
    assert '"CI_RUN_ID ci.yml" "WEB_RUN_ID web-perf.yml"' in run
    assert '>> "$GITHUB_ENV"' in run


def test_perf_trend_writes_the_script_output_for_each_scheduled_run() -> None:
    job = _perf_trend_job()
    for name, var in (
        ("Write the CI trend to the job summary", "CI_RUN_ID"),
        ("Write the Web perf trend to the job summary", "WEB_RUN_ID"),
    ):
        step = _step(job, name)
        assert step["if"] == "github.event_name == 'schedule'"
        assert step["env"]["RUN_ID"] == f"${{{{ env.{var} }}}}"
        assert step["env"]["GH_TOKEN"] == "${{ github.token }}"
        assert (
            step["run"]
            == 'python scripts/perf_trend.py --run-id "$RUN_ID" >> "$GITHUB_STEP_SUMMARY"'
        )


def test_perf_trend_writes_the_script_output_to_the_summary_with_gh_token() -> None:
    step = _step(_perf_trend_job(), "Write the trend to the job summary")
    assert step["if"] == "github.event_name == 'workflow_dispatch'"
    assert step["env"]["RUN_ID"] == "${{ inputs.run_id }}"
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
