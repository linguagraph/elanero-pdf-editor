"""Benchmarks run serially: the wall-clock budgets need an idle machine.

Under ``pytest -n`` the other workers load the CPU, so the budget tests in ``test_ui_budgets``
would be flaky. They are skipped there and still run in the default serial run. The functional
benchmark smoke tests in ``test_benchmarks`` run either way (``--benchmark-disable``).

Each budget test records its samples through the ``perf`` fixture. At the end of the session
they are written to ``.perf/perf-results.json`` (or ``PDFEDITOR_PERF_RESULTS``), one record per
metric, so a nightly run can be compared with earlier ones
(docs/web/design/W8.3-performance.md, 2.5).
"""

from __future__ import annotations

import datetime as dt
import functools
import json
import os
import statistics
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
RESULTS_ENV = "PDFEDITOR_PERF_RESULTS"
# Git-ignored, so a local run never leaves a stray perf-results.json in the repo root.
RESULTS_DIR = ROOT / ".perf"

_RESULTS: list[dict[str, Any]] = []


@functools.cache
def _commit() -> str:
    # Computed once per session: every record() call would otherwise spawn git.
    if sha := os.environ.get("GITHUB_SHA"):
        return sha
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True
        )
    except (OSError, subprocess.CalledProcessError):
        return "unknown"
    return out.stdout.strip()


def _runner_image() -> str:
    # GitHub-hosted runners set ImageOS and ImageVersion; elsewhere, name the OS.
    image_os = os.environ.get("ImageOS")  # noqa: SIM112 - the exact name GitHub sets
    if image_os:
        version = os.environ.get("ImageVersion", "")  # noqa: SIM112
        return f"{image_os}-{version}".rstrip("-")
    return os.environ.get("RUNNER_OS", os.name) + "-local"


def _attempt() -> int:
    try:
        return int(os.environ.get("PERF_ATTEMPT", "1"))
    except ValueError:
        return 1


def record(metric_id: str, samples_s: list[float]) -> float:
    """Keep the samples of one metric (seconds) and return their median in ms."""
    samples_ms = [round(s * 1000, 3) for s in samples_s]
    median = round(statistics.median(samples_ms), 3)
    _RESULTS.append(
        {
            "id": metric_id,
            "samples": samples_ms,
            "median": median,
            "commit": _commit(),
            "runner_image": _runner_image(),
            "date": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
            "attempt": _attempt(),
        }
    )
    return median


@pytest.fixture
def perf() -> Callable[[str, list[float]], float]:
    return record


def pytest_sessionfinish(session: pytest.Session) -> None:
    if not _RESULTS or hasattr(session.config, "workerinput"):
        return
    target = Path(os.environ.get(RESULTS_ENV) or RESULTS_DIR / "perf-results.json")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(_RESULTS, indent=2) + "\n", encoding="utf-8")


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    # Workers (``workerinput``) run with the option cleared, so check both.
    under_xdist = hasattr(config, "workerinput") or config.getoption("numprocesses", None)
    if not under_xdist:
        return
    skip = pytest.mark.skip(reason="timing budgets need an idle machine: run serially")
    for item in items:
        if item.path.name == "test_ui_budgets.py":
            item.add_marker(skip)
