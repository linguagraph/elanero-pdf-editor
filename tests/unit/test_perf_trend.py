"""The performance trend script (W8.3 S5) reads the nightly artifacts and reports drift.

Nothing here touches the network: ``fetch`` takes an injected ``gh`` runner, and the rest works on
files written into ``tmp_path`` in the two formats the harnesses write (docs/web/design/
W8.3-s5-trend-log.md, sections 2.1 to 2.3 and 4).
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

pytestmark = pytest.mark.desktop_only

ROOT = Path(__file__).resolve().parents[2]
BUDGETS = ROOT / "tests" / "perf" / "budgets.json"


def _load_script() -> ModuleType:
    path = ROOT / "scripts" / "perf_trend.py"
    spec = importlib.util.spec_from_file_location("perf_trend", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["perf_trend"] = module  # dataclasses look the module up by name
    spec.loader.exec_module(module)
    return module


pt = _load_script()
KNOWN: tuple[str, ...] = pt.TREND_METRICS


def _run(run_id: int, created: str = "2026-11-27T03:00:00Z", conclusion: str = "success") -> Any:
    return pt.Run(run_id, created, conclusion, "CI")


def _desktop_night(
    root: Path,
    medians: dict[str, float],
    runner: str = "win25-20260101.1",
    date: str = "2026-11-27T03:00:00+00:00",
) -> Path:
    """A downloaded ``perf-desktop-windows-*`` folder: the desktop writer's list format."""
    art = root / "perf-desktop-windows-1-1"
    art.mkdir(parents=True)
    records = [
        {
            "id": mid,
            "samples": [median, median],
            "median": median,
            "commit": "abcdef1",
            "runner_image": runner,
            "date": date,
            "attempt": 1,
        }
        for mid, median in medians.items()
    ]
    (art / "perf-results.json").write_text(json.dumps(records), encoding="utf-8")
    return root


def _web_round(
    art: Path,
    attempt: int,
    rnd: int,
    side: str,
    samples: dict[str, list[float]],
    runner: str = "ubuntu24-20260101.1",
) -> None:
    folder = art / f"attempt-{attempt}" / f"round-{rnd}" / side
    folder.mkdir(parents=True, exist_ok=True)
    body = {
        "schema": 1,
        "commit": "abcdef1",
        "runner": runner,
        "date": "2026-11-26",
        "attempt": 1,
        "records": [
            {"id": mid, "unit": "ms", "fixture": None, "samples": s, "median": s[0]}
            for mid, s in samples.items()
        ],
    }
    (folder / "perf-results.json").write_text(json.dumps(body), encoding="utf-8")


def _load(run: Any, root: Path) -> tuple[dict[str, dict[str, Any]], list[str]]:
    problems: list[str] = []
    return pt.load_run_dir(run, root, KNOWN, problems), problems


def test_desktop_list_format_loads_one_point_per_metric(tmp_path: Path) -> None:
    root = _desktop_night(tmp_path, {"D1": 100.0, "D3": 5.0})
    found, problems = _load(_run(7), root)
    assert problems == []
    point = found["desktop-windows"]["D1"]
    assert (point.value, point.samples, point.date, point.os, point.image) == (
        100.0,
        2,
        "2026-11-27",
        "win25",
        "20260101.1",
    )
    assert point.commit == "abcdef1"


def test_web_pools_the_head_rounds_of_attempt_one(tmp_path: Path) -> None:
    art = tmp_path / "web-perf-results-7-1"
    for rnd in range(1, 6):
        _web_round(art, 1, rnd, "head", {"W2": [float(3000 + rnd)], "W7": [0.0]})
        _web_round(art, 1, rnd, "baseline", {"W2": [9999.0]})  # ignored: the trend is HEAD
    found, _ = _load(_run(7), tmp_path)
    w2 = found["web-chromium"]["W2"]
    assert (w2.value, w2.samples, w2.os) == (3003.0, 5, "ubuntu24")
    assert found["web-chromium"]["W7"].value == 0.0  # a zero median is a valid point


def test_web_uses_attempt_two_only_when_attempt_one_is_incomplete(tmp_path: Path) -> None:
    art = tmp_path / "web-perf-results-7-1"
    for rnd in (1, 2):
        _web_round(art, 1, rnd, "head", {"W3": [1.0]})
    for rnd in range(1, 6):
        _web_round(art, 2, rnd, "head", {"W3": [50.0]})
    found, _ = _load(_run(7), tmp_path)
    assert found["web-chromium"]["W3"].value == 50.0


def test_bad_records_are_skipped_or_shown_as_question_marks(tmp_path: Path) -> None:
    root = tmp_path / "run"
    art = root / "perf-desktop-linux-1-1"
    art.mkdir(parents=True)
    records = [
        {"id": "D9", "samples": [1.0], "median": 1.0, "runner_image": "ubuntu24-1"},  # unknown id
        {"id": "D1", "samples": [1.0], "median": float("nan")},  # not finite
        {
            "id": "D2",
            "samples": [1.0],
            "median": 2.0,
            "commit": "x<script>",
            "runner_image": "bad runner!",
            "date": "2026-11-27",
        },
    ]
    (art / "perf-results.json").write_text(json.dumps(records), encoding="utf-8")
    problems: list[str] = []
    found = pt.load_run_dir(_run(7), root, KNOWN, problems)["desktop-linux"]
    assert set(found) == {"D2"}
    assert (found["D2"].commit, found["D2"].runner) == ("?", "?")
    assert len(problems) == 2


def _drift_history(root: Path, values: list[float]) -> tuple[Any, Path, list[tuple[Any, Path]]]:
    """Ten or more nights, oldest first in ``values``; tonight is the last one."""
    dirs = []
    for index, value in enumerate(values):
        night = root / f"night-{index}"
        _desktop_night(night, {"D1": value}, date=f"2026-11-{index + 1:02d}T03:00:00+00:00")
        dirs.append((_run(1000 + index, f"2026-11-{index + 1:02d}T03:00:00Z"), night))
    tonight_run, tonight_dir = dirs[-1]
    history = list(reversed(dirs[:-1]))
    return tonight_run, tonight_dir, history


def _report(values: list[float], tmp_path: Path) -> Any:
    tonight, tonight_dir, history = _drift_history(tmp_path, values)
    return pt.build(tonight, tonight_dir, history, KNOWN)


def test_drift_fires_at_ten_percent_and_one_ms_and_not_below(tmp_path: Path) -> None:
    base = [100.0] * 3 + [100.0] * 4
    drifted = [100.0] * 3 + [111.0] * 7  # +11% and 11 ms
    assert "drift" in _report(base[:3] + [111.0] * 7, tmp_path / "a").markdown
    assert "drift" not in _report([100.0] * 3 + [109.0] * 7, tmp_path / "b").markdown  # +9%
    assert "drift" not in _report([5.0] * 3 + [5.5] * 7, tmp_path / "c").markdown  # +10%, 0.5 ms
    report = _report(drifted, tmp_path / "d")
    assert len(report.warnings) == 1 and "D1" in report.warnings[0]


def test_drift_at_exactly_ten_percent_is_not_drift(tmp_path: Path) -> None:
    assert "drift" not in _report([100.0] * 3 + [110.0] * 7, tmp_path / "ten").markdown


def test_one_ms_edge_is_not_drift_but_just_over_is(tmp_path: Path) -> None:
    assert "drift" not in _report([5.0] * 3 + [6.0] * 7, tmp_path / "edge").markdown  # 1.0 ms
    assert "drift" in _report([5.0] * 3 + [6.01] * 7, tmp_path / "over").markdown  # 1.01 ms


def test_drift_with_a_zero_median_uses_only_the_one_ms_rule(tmp_path: Path) -> None:
    report = _report([0.0] * 3 + [2.0] * 7, tmp_path)
    assert any("+2.0 ms" in w for w in report.warnings)
    assert "drift" not in _report([0.0] * 3 + [0.5] * 7, tmp_path / "small").markdown


def test_huge_integer_value_is_skipped_not_a_crash(tmp_path: Path) -> None:
    root = tmp_path / "run"
    art = root / "perf-desktop-linux-1-1"
    art.mkdir(parents=True)
    records = [{"id": "D1", "samples": [1], "median": 10**400, "runner_image": "ubuntu24-1"}]
    (art / "perf-results.json").write_text(json.dumps(records), encoding="utf-8")
    problems: list[str] = []
    found = pt.load_run_dir(_run(7), root, KNOWN, problems)
    assert found["desktop-linux"] == {}  # the sample is skipped like a NaN
    assert len(problems) == 1 and "D1" in problems[0]


def test_two_files_sharing_an_attempt_and_round_warn_and_still_trend(tmp_path: Path) -> None:
    art = tmp_path / "web-perf-results-7-1"  # two copies of attempt 1, round 1 in one artifact
    for copy in ("a", "b"):
        _web_round(art / copy, 1, 1, "head", {"W2": [3000.0]})
    report = pt.build(_run(7), tmp_path, [], KNOWN)  # no TypeError from the sort
    assert "| W2 | 3000.0 ms |" in report.markdown
    assert any("web-chromium run 7" in w and "repeats a round" in w for w in report.warnings)


def test_fewer_than_ten_points_is_collecting_and_never_warns(tmp_path: Path) -> None:
    report = _report([100.0] * 3 + [500.0] * 6, tmp_path)  # nine points
    assert "collecting (9/10)" in report.markdown
    assert report.warnings == []


def test_runner_os_change_resets_the_window_and_image_change_is_only_marked(tmp_path: Path) -> None:
    tonight_dir = _desktop_night(tmp_path / "t", {"D1": 100.0}, runner="win25-2")
    older_same_os = _desktop_night(
        tmp_path / "o", {"D1": 100.0}, runner="win25-1", date="2026-11-26T03:00:00+00:00"
    )
    other_os = _desktop_night(tmp_path / "x", {"D1": 50.0}, runner="win22-9")
    history = [
        (_run(2, "2026-11-26T03:00:00Z"), older_same_os),
        (_run(1, "2026-11-25T03:00:00Z"), other_os),
    ]
    report = pt.build(_run(3), tonight_dir, history, KNOWN)
    assert (
        "| D1 | 100.0 ms | 100.0 ms | +0.0% | +0.0 |" in report.markdown
    )  # the 50 ms night is out
    assert "image updated 2026-11-27" in report.markdown


def test_missing_runs_are_listed_as_no_data(tmp_path: Path) -> None:
    tonight_dir = _desktop_night(tmp_path / "t", {"D1": 100.0})
    history = [(_run(2, "2026-11-26T03:00:00Z"), None)]
    report = pt.build(_run(3), tonight_dir, history, KNOWN)
    assert "No data for runs 2 (expired or missing)." in report.markdown


def _fake_gh(files: dict[str, Path | None]) -> tuple[Any, list[list[str]]]:
    calls: list[list[str]] = []

    def gh(args: list[str]) -> subprocess.CompletedProcess[str]:
        calls.append(args)
        if args[:2] == ["run", "view"]:
            body = {
                "databaseId": 9,
                "workflowName": "CI",
                "conclusion": "success",
                "createdAt": "2026-11-27T03:00:00Z",
            }
            return subprocess.CompletedProcess(args, 0, json.dumps(body), "")
        if args[:2] == ["run", "list"]:
            body = [
                {"databaseId": 9, "createdAt": "2026-11-27T03:00:00Z", "conclusion": "success"},
                {"databaseId": 8, "createdAt": "2026-11-26T03:00:00Z", "conclusion": "failure"},
                {"databaseId": 10, "createdAt": "2026-11-28T03:00:00Z", "conclusion": "success"},
            ]
            return subprocess.CompletedProcess(args, 0, json.dumps(body), "")
        run_id = args[2]
        if files.get(run_id) is None:
            return subprocess.CompletedProcess(args, 1, "", "no valid artifacts found to download")
        target = Path(args[args.index("--dir") + 1])
        target.mkdir(parents=True)
        return subprocess.CompletedProcess(args, 0, "", "")

    return gh, calls


def test_fetch_builds_the_gh_calls_and_skips_later_and_expired_runs(tmp_path: Path) -> None:
    gh, calls = _fake_gh({"9": tmp_path, "8": None})
    tonight, tonight_dir, history = pt.fetch(9, tmp_path / "dl", gh)
    assert tonight.id == 9 and tonight.workflow == "CI"
    assert tonight_dir is not None
    assert [(run.id, found) for run, found in history] == [(8, None)]  # run 10 is later
    downloads = [c for c in calls if c[:2] == ["run", "download"]]
    assert all("perf-desktop-*" in c for c in downloads)
    listing = next(c for c in calls if c[:2] == ["run", "list"])
    assert listing[listing.index("--workflow") + 1] == "CI"
    assert "--event" in listing and listing[listing.index("--event") + 1] == "schedule"


def test_fetch_fails_on_an_unknown_workflow_or_a_gh_error(tmp_path: Path) -> None:
    def failing(args: list[str]) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(args, 1, "", "HTTP 401")

    with pytest.raises(pt.TrendError, match="HTTP 401"):
        pt.fetch(9, tmp_path, failing)
    gh, _ = _fake_gh({})

    def other(args: list[str]) -> subprocess.CompletedProcess[str]:
        if args[:2] == ["run", "view"]:
            body = {
                "databaseId": 9,
                "workflowName": "Release",
                "conclusion": "success",
                "createdAt": "2026-11-27T03:00:00Z",
            }
            return subprocess.CompletedProcess(args, 0, json.dumps(body), "")
        return gh(args)

    with pytest.raises(pt.TrendError, match="Release"):
        pt.fetch(9, tmp_path, other)


def test_main_exits_zero_on_drift_and_one_with_no_input(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    tonight, tonight_dir, history = _drift_history(tmp_path, [100.0] * 3 + [130.0] * 7)
    monkeypatch.setattr(pt, "fetch", lambda *_: (tonight, tonight_dir, history))
    assert pt.main(["--run-id", "9"]) == 0
    captured = capsys.readouterr()
    assert "## Performance trend (W8.3)" in captured.out
    assert "::warning title=perf-trend::desktop-windows D1 drift" in captured.err

    monkeypatch.setattr(pt, "fetch", lambda *_: (tonight, None, []))
    assert pt.main(["--run-id", "9"]) == 1


def test_every_metric_the_trend_reads_is_a_budget_row() -> None:
    ids = {row["id"] for row in json.loads(BUDGETS.read_text("utf-8"))["metrics"]}
    assert set(pt.TREND_METRICS) <= ids
    assert {"D1", "D2", "D3", "D4", "D5", "W2", "W3", "W7", "W8"} <= set(pt.TREND_METRICS)
