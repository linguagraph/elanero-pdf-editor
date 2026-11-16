"""Spike-only pytest plugin for the Pyodide run of tests/engine (W0.1). Never imported by the app.

Loaded with ``-p pyodide_conftest``, so it runs before the repo's conftest files. It does three
things and nothing else:

1. Modules that import ``pikepdf`` or ``pypdfium2`` (C extensions with no Pyodide build) are
   skipped at import time, with the reason "host-verified". They are verified on the host, not
   failures, and the summary counts them apart from real skips.
2. ``tests/conftest.py`` imports ``pdfeditor.ui.settings`` (PySide6) in an autouse fixture. Qt
   does not exist in Pyodide, so a stub provides the one name it reads (``_SESSION_KEYS``).
3. Writes a summary JSON (counts by outcome, skip reasons, failure list) to the path in
   ``SPIKE_ENGINE_SUMMARY``. The JUnit XML is written by pytest itself.
"""

from __future__ import annotations

import importlib.abc
import importlib.machinery
import json
import os
import sys
import types
from collections import Counter
from typing import Any

import pytest

HOST_ONLY_TOP_LEVEL = ("pikepdf", "pypdfium2")
HOST_REASON = "needs host-side verification (pikepdf/pypdfium2 have no Pyodide build)"


class _HostOnlyLoader(importlib.abc.Loader):
    def create_module(self, spec: importlib.machinery.ModuleSpec) -> None:
        return None

    def exec_module(self, module: types.ModuleType) -> None:
        # allow_module_level: the whole test module is reported as one skip.
        pytest.skip(HOST_REASON, allow_module_level=True)


class _HostOnlyFinder(importlib.abc.MetaPathFinder):
    def find_spec(
        self,
        fullname: str,
        path: Any,
        target: types.ModuleType | None = None,
    ) -> importlib.machinery.ModuleSpec | None:
        if fullname.partition(".")[0] in HOST_ONLY_TOP_LEVEL:
            return importlib.machinery.ModuleSpec(fullname, _HostOnlyLoader())
        return None


def _install_ui_stub() -> None:
    """Stub just enough of pdfeditor.ui for tests/conftest.py's autouse fixture."""
    if "pdfeditor.ui.settings" in sys.modules:
        return
    ui = types.ModuleType("pdfeditor.ui")
    ui.__path__ = []  # type: ignore[attr-defined]
    settings = types.ModuleType("pdfeditor.ui.settings")
    settings._SESSION_KEYS = {}  # type: ignore[attr-defined]
    ui.settings = settings  # type: ignore[attr-defined]
    sys.modules["pdfeditor.ui"] = ui
    sys.modules["pdfeditor.ui.settings"] = settings


sys.meta_path.insert(0, _HostOnlyFinder())
_install_ui_stub()

_outcomes: Counter[str] = Counter()
_skip_reasons: Counter[str] = Counter()
_skipped_modules: list[dict[str, str]] = []
_failures: list[dict[str, str]] = []


def _skip_reason(report: Any) -> str:
    longrepr = report.longrepr
    text = str(longrepr[2]) if isinstance(longrepr, tuple) and len(longrepr) == 3 else str(longrepr)
    return text.removeprefix("Skipped: ").strip()


def _first_line(report: Any) -> str:
    """The exception message: pytest's ``E`` line when there is one, else the last line."""
    lines = [line for line in str(report.longrepr or "").splitlines() if line.strip()]
    errors = [line.removeprefix("E").strip() for line in lines if line.startswith("E ")]
    chosen = errors[0] if errors else (lines[-1] if lines else "")
    return chosen[:300]


def pytest_collectreport(report: Any) -> None:
    if report.outcome == "skipped":
        reason = _skip_reason(report)
        _skipped_modules.append({"module": report.nodeid, "reason": reason})
        _skip_reasons[reason] += 1
    elif report.outcome == "failed":
        _outcomes["collect_error"] += 1
        _failures.append(
            {"nodeid": report.nodeid, "when": "collect", "message": _first_line(report)}
        )


def pytest_runtest_logreport(report: Any) -> None:
    if report.when == "call" and report.passed:
        _outcomes["passed"] += 1
    elif report.skipped:
        reason = _skip_reason(report)
        _outcomes["skipped"] += 1
        _skip_reasons[reason] += 1
    elif report.failed:
        # A failure in setup or teardown is an error, as pytest reports it.
        outcome = "failed" if report.when == "call" else "errored"
        _outcomes[outcome] += 1
        _failures.append(
            {"nodeid": report.nodeid, "when": report.when, "message": _first_line(report)}
        )


def pytest_sessionfinish(session: pytest.Session) -> None:
    path = os.environ.get("SPIKE_ENGINE_SUMMARY")
    if not path:
        return
    summary = {
        "passed": _outcomes["passed"],
        "failed": _outcomes["failed"],
        "errored": _outcomes["errored"] + _outcomes["collect_error"],
        "skipped": _outcomes["skipped"],
        "hostVerifiedModules": len(_skipped_modules),
        "skipReasons": dict(_skip_reasons),
        "skippedModules": _skipped_modules,
        "failures": _failures,
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2)
