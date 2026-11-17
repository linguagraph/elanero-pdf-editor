"""Spike-only pytest plugin for the Pyodide run of tests/engine (W0.1). Never imported by the app.

Loaded with ``-p pyodide_conftest``, so it runs before the repo's conftest files. It does four
things:

1. ``pikepdf`` and ``pypdfium2`` (C/C++ extensions with no Pyodide build) are replaced by lazy
   stub modules, registered in ``sys.modules`` before collection. Importing them, ``from x import
   Y`` and using their names in annotations all work. Calling a stub, indexing it, iterating it,
   comparing it or testing it for truth raises ``pytest.skip`` with the reason
   "needs host-side verification: <name>". So a test skips at the first host-only operation, and
   the engine calls before it still run.
2. Counts, per test, how many engine functions returned during the call phase (a profile hook on
   ``src/pdfeditor/engine``). A host skip after engine work is "engine passed, host check pending";
   a host skip before any engine work is "host check not reached". Other skips are "skipped".
3. ``tests/conftest.py`` imports ``pdfeditor.ui.settings`` (PySide6) in an autouse fixture. Qt
   does not exist in Pyodide, so a stub provides the one name it reads (``_SESSION_KEYS``).
4. Writes a summary JSON to the path in ``PYODIDE_SUMMARY``. The JUnit XML is pytest's own.
5. Writes ``host-checks.json`` next to the summary: the host checks that tests recorded (see
   ``tests/hostcheck.py``). ``scripts/web_host_verify.py`` replays it on host CPython.

The stub modules themselves live in ``host_stubs.py`` (importable on CPython, for the unit tests).
"""

from __future__ import annotations

import ast
import json
import os
import sys
import types
from collections import Counter
from pathlib import Path
from typing import Any

import pytest
from host_stubs import HOST_PREFIX, install_host_stubs

# web/test/pyodide/pyodide_conftest.py -> repo root is three levels up. The web run loads the
# engine from the unpacked web wheel instead, so PYODIDE_ENGINE_DIR names that folder.
ENGINE_DIR = (
    os.environ.get("PYODIDE_ENGINE_DIR")
    or str(Path(__file__).resolve().parents[3] / "src" / "pdfeditor" / "engine") + os.sep
)


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


install_host_stubs()
_install_ui_stub()

# nodeid -> engine functions that returned during the test's call phase
_engine_returns: dict[str, int] = {}
_current_engine = 0
# nodeid -> final record (the call phase wins; a setup or teardown error or skip overrides)
_records: dict[str, dict[str, Any]] = {}
_collect_skips: list[dict[str, str]] = []
_collect_errors: list[dict[str, str]] = []


# Engine returns are counted with sys.monitoring's PY_RETURN event. That event fires only when a
# frame returns normally: a frame unwinding with an exception fires PY_UNWIND instead, and it is
# not counted. (A sys.setprofile "return" event can't tell the two apart: its arg is None for an
# exception and for a legitimate None return.) PY_RETURN is off except during a test's call phase.
_MON = sys.monitoring
_MON_TOOL = _MON.PROFILER_ID
_MON.use_tool_id(_MON_TOOL, "pdfeditor-spike-engine")


def _on_py_return(code: types.CodeType, offset: int, retval: object) -> object:
    global _current_engine
    if code.co_filename.startswith(ENGINE_DIR):
        _current_engine += 1
        return None
    # Not engine code: switch this code object off for good. DISABLE is kept until
    # restart_events(), which is fine: test and stdlib code never becomes engine code.
    return _MON.DISABLE


_MON.register_callback(_MON_TOOL, _MON.events.PY_RETURN, _on_py_return)


@pytest.hookimpl(wrapper=True)
def pytest_runtest_call(item: pytest.Item) -> Any:
    global _current_engine
    _current_engine = 0
    _MON.set_events(_MON_TOOL, _MON.events.PY_RETURN)
    try:
        return (yield)
    finally:
        _MON.set_events(_MON_TOOL, 0)
        _engine_returns[item.nodeid] = _current_engine


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


def _set(nodeid: str, when: str, category: str, reason: str = "", message: str = "") -> None:
    # Only failing or skipping phases get here (a passing setup or teardown is not recorded), so
    # the last one logged is the one that decides the outcome.
    _records[nodeid] = {
        "when": when,
        "category": category,
        "reason": reason,
        "message": message,
    }


# Desktop-only tests must not be imported at all. A ``-m`` deselection runs after collection, and
# collecting a module imports it, so a Qt module would fail the whole run here. This hook skips
# them before import: the two desktop directories, and any module whose module-level pytestmark
# names desktop_only (the same rule tests/unit/test_desktop_only_marker.py checks).
REPO_ROOT = Path(__file__).resolve().parents[3]
DESKTOP_DIRS = (REPO_ROOT / "tests" / "ui", REPO_ROOT / "tests" / "benchmarks")


def _names_desktop_only(path: Path) -> bool:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in tree.body:
        if (
            isinstance(node, ast.Assign)
            and any(isinstance(t, ast.Name) and t.id == "pytestmark" for t in node.targets)
            and any(
                isinstance(n, ast.Attribute) and n.attr == "desktop_only"
                for n in ast.walk(node.value)
            )
        ):
            return True
    return False


def pytest_ignore_collect(collection_path: Path, config: pytest.Config) -> bool | None:
    path = Path(collection_path).resolve()
    if any(path == d or d in path.parents for d in DESKTOP_DIRS):
        return True
    if path.suffix == ".py" and path.name.startswith("test_") and _names_desktop_only(path):
        return True
    return None


def pytest_collectreport(report: Any) -> None:
    if report.outcome == "skipped":
        _collect_skips.append({"module": report.nodeid, "reason": _skip_reason(report)})
    elif report.outcome == "failed":
        _collect_errors.append({"module": report.nodeid, "message": _first_line(report)})


def pytest_runtest_logreport(report: Any) -> None:
    if report.passed and report.when == "call":
        _set(report.nodeid, "call", "passed")
    elif report.skipped:
        reason = _skip_reason(report)
        if reason.startswith(HOST_PREFIX):
            engine_done = report.when == "call" and _engine_returns.get(report.nodeid, 0) > 0
            category = "host_pending_engine_passed" if engine_done else "host_not_reached"
        else:
            category = "skipped"
        _set(report.nodeid, report.when, category, reason=reason)
    elif report.failed:
        # A failure in setup or teardown is an error, as pytest reports it.
        category = "failed" if report.when == "call" else "errored"
        _set(report.nodeid, report.when, category, message=_first_line(report))


def pytest_sessionfinish(session: pytest.Session) -> None:
    path = os.environ.get("PYODIDE_SUMMARY")
    if not path:
        return
    _MON.register_callback(_MON_TOOL, _MON.events.PY_RETURN, None)
    _MON.free_tool_id(_MON_TOOL)
    categories: Counter[str] = Counter()
    engine_ran: Counter[str] = Counter()
    reasons: Counter[str] = Counter()
    failures: list[dict[str, Any]] = []
    for nodeid, rec in _records.items():
        category = rec["category"]
        categories[category] += 1
        engine = _engine_returns.get(nodeid, 0)
        if engine > 0:
            engine_ran[category] += 1
        if rec["reason"]:
            reasons[rec["reason"]] += 1
        if category in ("failed", "errored"):
            failures.append(
                {
                    "nodeid": nodeid,
                    "when": rec["when"],
                    "engineReturns": engine,
                    "message": rec["message"],
                }
            )
    for item in _collect_errors:
        failures.append({"nodeid": item["module"], "when": "collect", "message": item["message"]})
    # Per module, the host-only skips (one per test that stopped at a host call, plus a module
    # skipped at import). scripts/check_web_skips.py compares these with the budget file.
    host_skips: Counter[str] = Counter()
    for nodeid, rec in _records.items():
        if rec["reason"].startswith(HOST_PREFIX):
            host_skips[nodeid.split("::", 1)[0]] += 1
    for item in _collect_skips:
        if item["reason"].startswith(HOST_PREFIX):
            host_skips[item["module"]] += 1
    criterion3 = {
        "numerator": engine_ran["passed"]
        + engine_ran["failed"]
        + engine_ran["errored"]
        + engine_ran["host_pending_engine_passed"],
        "passed": engine_ran["passed"],
        "failed": engine_ran["failed"],
        "errored": engine_ran["errored"],
        "enginePassedHostPending": engine_ran["host_pending_engine_passed"],
    }
    summary = {
        "tests": {
            "passed": categories["passed"],
            "failed": categories["failed"],
            "errored": categories["errored"] + len(_collect_errors),
            "skipped": categories["skipped"],
            "enginePassedHostPending": categories["host_pending_engine_passed"],
            "hostNotReached": categories["host_not_reached"],
        },
        "ranEngineCode": dict(engine_ran),
        "criterion3": criterion3,
        "skipReasons": dict(reasons),
        "moduleSkips": _collect_skips,
        "hostSkipsByModule": dict(host_skips),
        "failures": failures,
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2)
    # The host-check recorder (tests/hostcheck.py) lives in the test package, so read it from
    # sys.modules: when no test imported it, nothing was recorded. Written even when tests failed.
    hostcheck = sys.modules.get("tests.hostcheck")
    checks = hostcheck.recorded() if hostcheck is not None else []
    manifest = Path(path).with_name("host-checks.json")
    with open(manifest, "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "checks": checks}, fh)
