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
4. Writes a summary JSON to the path in ``SPIKE_ENGINE_SUMMARY``. The JUnit XML is pytest's own.
"""

from __future__ import annotations

import importlib.abc
import importlib.machinery
import json
import os
import sys
import types
from collections import Counter
from pathlib import Path
from typing import Any

import pytest

HOST_ONLY_TOP_LEVEL = ("pikepdf", "pypdfium2")
HOST_PREFIX = "needs host-side verification"
# web/spike/pyodide_conftest.py -> repo root is two levels up.
ENGINE_DIR = str(Path(__file__).resolve().parents[2] / "src" / "pdfeditor" / "engine") + os.sep


def _host_skip(name: str) -> None:
    # allow_module_level: a host call made while a test module is imported skips the module.
    pytest.skip(f"{HOST_PREFIX}: {name}", allow_module_level=True)


class _HostMeta(type):
    """Metaclass of a stand-in class. Attribute access gives another stand-in (lazy); any use
    other than a plain attribute read or an identity check raises the host skip."""

    def __getattr__(cls, attr: str) -> Any:
        # Private names (``_pytestfixturefunction``, ``__wrapped__``) are probed by pytest and
        # tooling on every module attribute; a stand-in must not look like a fixture or a test.
        if attr.startswith("_"):
            raise AttributeError(attr)
        return _host_class(f"{cls._host_name}.{attr}")

    def __call__(cls, *args: object, **kwargs: object) -> Any:
        _host_skip(cls._host_name)

    def __getitem__(cls, key: object) -> Any:
        _host_skip(cls._host_name)

    def __iter__(cls) -> Any:
        _host_skip(cls._host_name)

    def __len__(cls) -> int:
        _host_skip(cls._host_name)
        return 0

    def __bool__(cls) -> bool:
        _host_skip(cls._host_name)
        return True

    def __eq__(cls, other: object) -> bool:
        _host_skip(cls._host_name)
        return False

    __hash__ = type.__hash__


_CLASSES: dict[str, type] = {}


def _host_class(name: str) -> type:
    cls = _CLASSES.get(name)
    if cls is None:
        module, _, short = name.rpartition(".")
        cls = _HostMeta(short, (), {"_host_name": name, "__module__": module or name})
        _CLASSES[name] = cls
    return cls


class _HostModule(types.ModuleType):
    def __getattr__(self, attr: str) -> Any:
        if attr.startswith("_"):
            raise AttributeError(attr)
        return _host_class(f"{self.__name__}.{attr}")


def _make_host_module(name: str) -> _HostModule:
    module = _HostModule(name)
    module.__path__ = []  # type: ignore[attr-defined]  # so submodule imports reach the finder
    return module


class _HostFinder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    """Stub submodules (``import pikepdf.foo``) the same way as the top-level modules."""

    def find_spec(
        self,
        fullname: str,
        path: Any,
        target: types.ModuleType | None = None,
    ) -> importlib.machinery.ModuleSpec | None:
        if fullname.partition(".")[0] in HOST_ONLY_TOP_LEVEL:
            return importlib.machinery.ModuleSpec(fullname, self, is_package=True)
        return None

    def create_module(self, spec: importlib.machinery.ModuleSpec) -> _HostModule:
        return _make_host_module(spec.name)

    def exec_module(self, module: types.ModuleType) -> None:
        return None


def _install_host_stubs() -> None:
    for name in HOST_ONLY_TOP_LEVEL:
        sys.modules.setdefault(name, _make_host_module(name))
    sys.meta_path.insert(0, _HostFinder())


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


_install_host_stubs()
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
    path = os.environ.get("SPIKE_ENGINE_SUMMARY")
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
        "failures": failures,
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2)
