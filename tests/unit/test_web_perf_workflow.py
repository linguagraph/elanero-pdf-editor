"""The web perf workflow (W8.3 S4b) and its release hook are wired as the design says.

These read the YAML, so they run on every PR without a browser. They check the shape of
``web-perf.yml`` and of the ``web-perf`` job in ``release.yml``, not the timings: the
workflow itself runs only on GitHub (docs/web/design/W8.3-performance.md, sections 2.2
and 2.3).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
WEB_PERF = ROOT / ".github" / "workflows" / "web-perf.yml"
RELEASE = ROOT / ".github" / "workflows" / "release.yml"


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


def _job(doc: dict[str, Any]) -> dict[str, Any]:
    jobs = doc["jobs"]
    assert len(jobs) == 1, "web-perf.yml runs one job"
    return next(iter(jobs.values()))


def _runs(job: dict[str, Any]) -> str:
    return "\n".join(str(step.get("run", "")) for step in _steps(job))


def test_web_perf_triggers_are_schedule_dispatch_and_call() -> None:
    triggers = _triggers(_load(WEB_PERF))
    assert triggers["schedule"] == [{"cron": "0 5 * * *"}]
    assert "workflow_dispatch" in triggers
    assert "baseline_ref" in triggers["workflow_dispatch"]["inputs"]
    call_inputs = triggers["workflow_call"]["inputs"]
    assert {"head_ref", "baseline_ref"} <= set(call_inputs)


def test_web_perf_has_no_pull_request_trigger() -> None:
    assert "pull_request" not in _triggers(_load(WEB_PERF))
    assert "pull_request_target" not in _triggers(_load(WEB_PERF))


def test_web_perf_permissions_are_read_only() -> None:
    assert _load(WEB_PERF)["permissions"] == {"contents": "read"}


def test_web_perf_runs_the_compare_with_a_retry() -> None:
    job = _job(_load(WEB_PERF))
    assert job["timeout-minutes"] >= 240
    runs = _runs(job)
    assert "perf-compare.ts" in runs
    assert "tests/perf/budgets.json" in runs
    assert "GITHUB_STEP_SUMMARY" in runs
    # The retry: a second round run and compare, only after the first compare failed.
    steps = _steps(job)
    retry = [
        s for s in steps if "failure" in str(s.get("if", "")) and "compare" in str(s.get("if", ""))
    ]
    assert retry, "no step runs only when the first compare failed (the retry)"
    assert any("perf-compare.ts" in str(s.get("run", "")) for s in retry)


def test_web_perf_fails_on_a_wheel_cache_miss() -> None:
    text = WEB_PERF.read_text(encoding="utf-8")
    assert "cache-hit != 'true'" in text
    assert "exit 1" in text


def test_web_perf_uploads_results_for_90_days() -> None:
    job = _job(_load(WEB_PERF))
    uploads = [
        s for s in _steps(job) if str(s.get("uses", "")).startswith("actions/upload-artifact")
    ]
    assert uploads, "no artifact upload"
    assert any(str(s["with"].get("retention-days")) == "90" for s in uploads)
    assert any("perf-results.json" in str(s["with"].get("path", "")) for s in uploads)


def test_web_perf_concurrency_group_is_not_the_release_group() -> None:
    # In a called workflow github.workflow is the caller's name, so the group must not use it.
    group = str(_load(WEB_PERF)["concurrency"]["group"])
    assert "github.workflow" not in group
    assert group.startswith("web-perf-")
    release_group = str(_load(RELEASE)["concurrency"]["group"])
    assert not release_group.lower().startswith(group.split("$")[0].lower())


def test_web_perf_artifact_names_include_run_attempt() -> None:
    job = _job(_load(WEB_PERF))
    uploads = [
        s for s in _steps(job) if str(s.get("uses", "")).startswith("actions/upload-artifact")
    ]
    assert len(uploads) == 2, "expected the results and the serve-logs uploads"
    for upload in uploads:
        name = str(upload["with"]["name"])
        assert "github.run_id" in name
        assert "github.run_attempt" in name


def test_web_perf_uploads_serve_logs_even_on_failure() -> None:
    job = _job(_load(WEB_PERF))
    logs = [s for s in _steps(job) if "serve-logs" in str(s.get("with", {}).get("name", ""))]
    assert len(logs) == 1
    assert str(logs[0].get("if")) == "${{ always() }}"
    assert "serve-*.log" in str(logs[0]["with"]["path"])


def test_web_perf_merge_steps_create_their_directory_first() -> None:
    # The merge writes perf-out/attempt-N/<side>/perf-results.json; that directory is not made by
    # the harness, so each merge step must mkdir it before node writes the file.
    steps = {str(s.get("id", s.get("name"))): s for s in _steps(_job(_load(WEB_PERF)))}
    for key in ("compare-1", "Compare the rounds (attempt 2, both attempts)"):
        run = str(steps[key]["run"])
        assert "mkdir -p" in run, key
        assert run.index("mkdir -p") < run.index("node -e"), key


def test_web_perf_second_compare_skips_a_failed_first_attempt() -> None:
    # Attempt 1's files may be partial or missing after a failed round; the merge must skip them.
    steps = _steps(_job(_load(WEB_PERF)))
    second = next(
        s for s in steps if s.get("name") == "Compare the rounds (attempt 2, both attempts)"
    )
    assert "steps.rounds-1.outcome" in str(second["env"]["ROUNDS1_OK"])
    assert 'if [ "$ok" != success ]' in str(second["run"])


def test_web_perf_npm_installs_ignore_scripts() -> None:
    runs = _runs(_job(_load(WEB_PERF)))
    for line in runs.splitlines():
        if " npm ci" in f" {line}" or " npm install" in f" {line}":
            assert "--ignore-scripts" in line, line


def test_release_calls_web_perf_and_github_release_waits_for_it() -> None:
    jobs = _load(RELEASE)["jobs"]
    assert jobs["web-perf"]["uses"] == "./.github/workflows/web-perf.yml"
    assert jobs["web-perf"]["with"]["head_ref"] == "${{ github.sha }}"
    assert set(jobs["github-release"]["needs"]) == {"ci", "web-perf"}
