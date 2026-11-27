"""Performance trend tables from the nightly artifacts (W8.3 S5 (W8.3-s5-trend-log)).

One scheduled run's results and the scheduled runs before it become a Markdown table per series.
A drift is a warning, never a failure. Stdlib only; ``gh`` fetches the artifacts, so no token here.
"""

from __future__ import annotations

import argparse
import itertools
import json
import math
import re
import statistics
import subprocess
import sys
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

TREND_METRICS = ("D1", "D2", "D3", "D4", "D5", "W1", "W2", "W3", "W7", "W8")  # budget ids read
WINDOW = 14  # earlier scheduled runs beside tonight's
MIN_POINTS = 10  # fewer points: "collecting", no drift check
DRIFT_NIGHTS, DRIFT_PCT, DRIFT_MS = 7, 10.0, 1.0  # 1 ms: the web's whole-ms rounding
ROUNDS = 5  # HEAD round files that make a web attempt complete
SPARK = "▁▂▃▄▅▆▇█"
WORKFLOWS = {"CI": "perf-desktop-", "Web perf (W8.3)": "web-perf-results-"}
COMMIT_RE = re.compile(r"[0-9a-f]{7,40}")
RUNNER_RE = re.compile(r"[A-Za-z0-9._-]{1,40}")
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
DESKTOP_RE = re.compile(r"perf-desktop-(windows|linux)-")
ROUND_RE = re.compile(r"attempt-(\d+)/round-(\d+)/(head|baseline)/perf-results\.json$")


class TrendError(RuntimeError):
    """The trend cannot be built: gh failed, or the run is not one it reads."""


@dataclass(frozen=True)
class Run:
    id: int
    created: str  # ISO time, so string order is time order
    conclusion: str
    workflow: str


@dataclass(frozen=True)
class Point:
    """One metric of one run (design section 2.1)."""

    series: str
    metric: str
    value: float
    samples: int
    date: str
    runner: str  # ImageOS-ImageVersion, or ImageOS alone in older web artifacts
    commit: str
    run: int

    @property
    def os(self) -> str:
        return self.runner.partition("-")[0]

    @property
    def image(self) -> str:
        return self.runner.partition("-")[2]


@dataclass(frozen=True)
class Report:
    markdown: str
    warnings: list[str]
    points: int


def _clean(value: Any, pattern: re.Pattern[str]) -> str:
    """Artifact strings reach the Markdown, so only text of the expected shape passes."""
    return value if isinstance(value, str) and pattern.fullmatch(value) else "?"


def _point(
    series: str,
    run: Run,
    metric: Any,
    value: Any,
    samples: int,
    meta: dict[str, Any],
    known: tuple[str, ...],
    problems: list[str],
) -> Point | None:
    number = value if isinstance(value, int | float) and not isinstance(value, bool) else None
    try:
        finite = number is not None and math.isfinite(number)
    except OverflowError:  # an int too large for a float
        finite = False
    if metric not in known or number is None or not finite:
        problems.append(
            f"{series} run {run.id}: record {metric!r} skipped (unknown id or no number)"
        )
        return None
    return Point(
        series,
        metric,
        float(number),
        samples,
        _clean(str(meta.get("date", ""))[:10], DATE_RE),
        _clean(meta.get("runner"), RUNNER_RE),
        _clean(meta.get("commit"), COMMIT_RE),
        run.id,
    )


def desktop_points(
    data: Any, series: str, run: Run, known: tuple[str, ...], problems: list[str]
) -> dict[str, Point]:
    """The desktop writer's list format: one record per metric, with its own runner and date."""
    if not isinstance(data, list):
        problems.append(f"{series} run {run.id}: the results are not a list")
        return {}
    result: dict[str, Point] = {}
    for rec in (r for r in data if isinstance(r, dict)):
        samples = rec.get("samples")
        meta = {
            "date": rec.get("date"),
            "runner": rec.get("runner_image"),
            "commit": rec.get("commit"),
        }
        count = len(samples) if isinstance(samples, list) else 0
        point = _point(series, run, rec.get("id"), rec.get("median"), count, meta, known, problems)
        if point is not None:
            result[point.metric] = point
    return result


def web_points(
    files: list[tuple[int, int, str, Any]], run: Run, known: tuple[str, ...], problems: list[str]
) -> dict[str, Point]:
    """HEAD samples of one attempt, pooled over its rounds (design 2.1).

    Attempt 1 is used; attempt 2 only when attempt 1 has no complete set of rounds. Baseline
    files are ignored: the trend is HEAD over time.
    """
    heads = [(attempt, rnd, data) for attempt, rnd, side, data in files if side == "head"]
    if not heads:
        return {}
    attempts = sorted({attempt for attempt, _, _ in heads})
    complete = [a for a in attempts if sum(x == a for x, _, _ in heads) >= ROUNDS]
    chosen_attempt = (complete or attempts)[0]
    chosen = sorted(
        ((rnd, data) for attempt, rnd, data in heads if attempt == chosen_attempt),
        key=lambda item: item[0],  # two files of one round: the data dicts do not compare
    )
    rounds = [rnd for rnd, _ in chosen]
    if len(rounds) != len(set(rounds)):
        problems.append(f"web-chromium run {run.id}: attempt {chosen_attempt} repeats a round")
    first = chosen[0][1] if isinstance(chosen[0][1], dict) else {}
    meta = {"date": first.get("date"), "runner": first.get("runner"), "commit": first.get("commit")}
    pooled: dict[str, list[float]] = {}
    for _, data in chosen:
        records = data.get("records") if isinstance(data, dict) else None
        for rec in records if isinstance(records, list) else []:
            if isinstance(rec, dict) and isinstance(rec.get("samples"), list):
                numbers = [
                    x
                    for x in rec["samples"]
                    if isinstance(x, int | float) and not isinstance(x, bool)
                ]
                pooled.setdefault(str(rec.get("id")), []).extend(numbers)
    result: dict[str, Point] = {}
    for metric, values in pooled.items():
        if not values:
            continue
        point = _point(
            "web-chromium",
            run,
            metric,
            statistics.median(values),
            len(values),
            meta,
            known,
            problems,
        )
        if point is not None:
            result[metric] = point
    return result


def load_run_dir(
    run: Run, root: Path, known: tuple[str, ...], problems: list[str]
) -> dict[str, dict[str, Point]]:
    """The points of one run by series then metric, from its downloaded artifact folders."""
    out: dict[str, dict[str, Point]] = {}
    for art in sorted(p for p in root.iterdir() if p.is_dir()):
        desktop = DESKTOP_RE.match(art.name)
        if desktop:
            series, path = f"desktop-{desktop.group(1)}", art / "perf-results.json"
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                problems.append(f"cannot read {path.name} ({exc.__class__.__name__})")
                continue
            out.setdefault(series, {}).update(desktop_points(data, series, run, known, problems))
        elif art.name.startswith("web-perf-results-"):
            files: list[tuple[int, int, str, Any]] = []
            for path in sorted(art.rglob("perf-results.json")):
                match = ROUND_RE.search(path.as_posix())
                if match:
                    try:
                        data = json.loads(path.read_text(encoding="utf-8"))
                    except (OSError, ValueError) as exc:
                        problems.append(f"cannot read {path.name} ({exc.__class__.__name__})")
                        continue
                    files.append((int(match[1]), int(match[2]), match[3], data))
            found = web_points(files, run, known, problems)
            if found:
                out.setdefault("web-chromium", {}).update(found)
    return out


def _run_gh(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["gh", *args], capture_output=True, text=True, check=False)


def fetch(
    run_id: int, dest: Path, gh: Callable[[list[str]], subprocess.CompletedProcess[str]] = _run_gh
) -> tuple[Run, Path | None, list[tuple[Run, Path | None]]]:
    """Downloads tonight's artifacts and the earlier scheduled runs' (None: no artifacts)."""

    def call(args: list[str]) -> str:
        result = gh(args)
        if result.returncode != 0:
            raise TrendError(f"gh {args[0]} {args[1]} failed: {result.stderr.strip()}")
        return result.stdout

    info = json.loads(
        call(["run", "view", str(run_id), "--json", "databaseId,workflowName,conclusion,createdAt"])
    )
    workflow = info["workflowName"]
    if workflow not in WORKFLOWS:
        raise TrendError(f"run {run_id} is {workflow!r}; the trend reads only {sorted(WORKFLOWS)}")
    tonight = Run(int(info["databaseId"]), info["createdAt"], info["conclusion"], workflow)
    listing = json.loads(
        call(
            [
                "run",
                "list",
                "--workflow",
                workflow,
                "--branch",
                "main",
                "--event",
                "schedule",
                "--status",
                "completed",
                "--limit",
                "15",
                "--json",
                "databaseId,createdAt,conclusion",
            ]
        )
    )
    earlier = [
        Run(int(r["databaseId"]), r["createdAt"], r["conclusion"], workflow)
        for r in listing
        if int(r["databaseId"]) != tonight.id and r["createdAt"] < tonight.created
    ][:WINDOW]

    def download(run: Run) -> Path | None:
        target = dest / str(run.id)
        pattern = WORKFLOWS[workflow] + "*"
        result = gh(["run", "download", str(run.id), "--pattern", pattern, "--dir", str(target)])
        if result.returncode == 0:
            return target
        if run is tonight and "no valid artifacts" not in result.stderr.lower():
            raise TrendError(f"gh run download {run.id} failed: {result.stderr.strip()}")
        return None  # expired or missing: shown as "no data", not an error

    return tonight, download(tonight), [(run, download(run)) for run in earlier]


def _judge(values: list[float]) -> tuple[str, str | None]:
    """Status, and a warning when the last 7 nights' median is over the 7 before them.

    ``values`` is oldest first. Both rules must hold: more than 1 ms, and more than 10% when the
    earlier median is above zero (W7 is 0 in every sample today).
    """
    if len(values) < MIN_POINTS:
        return f"collecting ({len(values)}/{MIN_POINTS})", None
    recent = statistics.median(values[-DRIFT_NIGHTS:])
    before = statistics.median(values[-2 * DRIFT_NIGHTS : -DRIFT_NIGHTS])
    delta = recent - before
    if delta <= DRIFT_MS or (before > 0 and delta / before * 100 <= DRIFT_PCT):
        return "ok", None
    change = f"+{delta / before * 100:.0f}%" if before > 0 else f"+{delta:.1f} ms"
    return "drift", f"{change} ({recent:.1f} vs {before:.1f} ms over {DRIFT_NIGHTS} nights)"


def _row(metric: str, win: list[Point]) -> tuple[str, str | None]:
    """A Markdown row, and a warning text when the metric drifts. ``win`` is newest first."""
    tonight = win[0].value
    past = [p.value for p in win[1:]]
    status, warning = _judge([p.value for p in win][::-1])
    for newer, older in itertools.pairwise(win):
        if newer.image != older.image:  # the most recent image update in the window
            status += f" · image updated {newer.date}"
            break
    median = statistics.median(past) if past else None
    if median is None:
        base, pct, delta = "-", "-", "-"
    else:
        base = f"{median:.1f} ms"
        pct = f"{(tonight - median) / median * 100:+.1f}%" if median > 0 else "-"
        delta = f"{tonight - median:+.1f}"
    spark_values = [p.value for p in win][:15][::-1]
    low, high = min(spark_values), max(spark_values)
    spark = "".join(
        SPARK[round((v - low) / (high - low) * 7)] if high > low else SPARK[3] for v in spark_values
    )
    return (
        f"| {metric} | {tonight:.1f} ms | {base} | {pct} | {delta} | `{spark}` | {status} |",
        warning,
    )


def build(
    tonight: Run,
    tonight_dir: Path | None,
    history: list[tuple[Run, Path | None]],
    known: tuple[str, ...],
) -> Report:
    """The Markdown report and its warnings, pure over the downloaded folders."""
    problems: list[str] = []
    now = load_run_dir(tonight, tonight_dir, known, problems) if tonight_dir else {}
    past = [(run, load_run_dir(run, d, known, problems) if d else {}) for run, d in history]
    lines = ["## Performance trend (W8.3)", ""]
    warnings = list(problems)
    points = 0
    for series in sorted(now):
        tonight_map = now[series]
        points += len(tonight_map)
        first = next(iter(tonight_map.values()))
        no_data = [run.id for run, found in past if series not in found]
        lines += [
            f"### {series}",
            f"Run {tonight.id} ({tonight.conclusion}), runner `{first.runner}`, "
            f"commit `{first.commit}`.",
            "",
            "| Metric | Tonight | 14-night median | Change | Change (ms) | Trend | Status |",
            "|---|---|---|---|---|---|---|",
        ]
        for metric in known:
            if metric not in tonight_map:
                continue
            win = [tonight_map[metric]]
            for _, found in past:
                point = found.get(series, {}).get(metric)
                if point is None:
                    continue
                if point.os != win[0].os:  # the runner OS changed: the window starts again
                    break
                win.append(point)
            row, warning = _row(metric, win)
            lines.append(row)
            if warning:
                warnings.append(f"{series} {metric} drift: {warning}")
        if no_data:
            lines += ["", f"No data for runs {', '.join(map(str, no_data))} (expired or missing)."]
        lines.append("")
    if not now:
        lines.append("No performance results in this run.")
    return Report("\n".join(lines) + "\n", warnings, points)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Performance trend for one scheduled run (W8.3 S5)."
    )
    parser.add_argument("--run-id", type=int, required=True, help="the scheduled run to report")
    args = parser.parse_args(argv)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            tonight, tonight_dir, history = fetch(args.run_id, Path(tmp))
            report = build(tonight, tonight_dir, history, TREND_METRICS)
    except TrendError as exc:
        print(f"::error title=perf-trend::{exc}", file=sys.stderr)
        return 1
    print(report.markdown, end="")
    for warning in report.warnings:
        print(f"::warning title=perf-trend::{warning}", file=sys.stderr)
    if report.points == 0:
        print("::error title=perf-trend::no performance results to trend", file=sys.stderr)
        return 1
    return 0  # drift is a warning, never a failure


if __name__ == "__main__":
    raise SystemExit(main())
