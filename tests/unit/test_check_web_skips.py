"""scripts/check_web_skips.py: the host-only skip budget of the Pyodide run (calls main)."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

import pytest

ROOT = Path(__file__).resolve().parents[2]
BUDGET = ROOT / "web" / "test" / "pyodide" / "host-skip-budget.json"


def _load(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclasses and pickling look modules up by name
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def skips() -> ModuleType:
    return _load("check_web_skips_under_test", ROOT / "scripts" / "check_web_skips.py")


def _write(path: Path, doc: object) -> Path:
    path.write_text(json.dumps(doc), encoding="utf-8")
    return path


def _run(skips: ModuleType, tmp_path: Path, counts: dict, budget: object) -> int:
    summary = _write(tmp_path / "pytest-summary.json", {"hostSkipsByModule": counts})
    budget_path = _write(tmp_path / "budget.json", budget)
    return skips.main(["--summary", str(summary), "--budget", str(budget_path)])


MODULE = "tests/engine/test_page_ops.py"


def test_over_budget_fails(skips, tmp_path, capsys):
    budget = {"max_total": 5, "modules": {MODULE: 2}}
    assert _run(skips, tmp_path, {MODULE: 3}, budget) == 1
    assert f"FAIL {MODULE}: 3 host-only skips, budget 2" in capsys.readouterr().out


def test_at_budget_passes(skips, tmp_path, capsys):
    budget = {"max_total": 5, "modules": {MODULE: 3}}
    assert _run(skips, tmp_path, {MODULE: 3}, budget) == 0
    assert f"ok   {MODULE}: 3 host-only skips, budget 3" in capsys.readouterr().out


def test_under_budget_passes(skips, tmp_path):
    budget = {"max_total": 5, "modules": {MODULE: 3}}
    assert _run(skips, tmp_path, {MODULE: 1}, budget) == 0


def test_module_without_budget_entry_fails(skips, tmp_path, capsys):
    budget = {"max_total": 5, "modules": {}}
    assert _run(skips, tmp_path, {MODULE: 1}, budget) == 1
    assert "no budget entry" in capsys.readouterr().out


def test_module_with_no_host_skips_needs_no_entry(skips, tmp_path):
    budget = {"max_total": 0, "modules": {}}
    assert _run(skips, tmp_path, {MODULE: 0}, budget) == 0


def test_budget_total_above_max_total_is_refused(skips, tmp_path, capsys):
    budget = {"max_total": 4, "modules": {MODULE: 3, "tests/engine/test_contract.py": 2}}
    assert _run(skips, tmp_path, {}, budget) == 2
    assert "above max_total 4" in capsys.readouterr().out


@pytest.mark.parametrize(
    "budget",
    [
        {"modules": {}},  # no max_total
        {"max_total": 1, "modules": {MODULE: -1}},  # negative budget
        {"max_total": 1, "modules": {MODULE: "2"}},  # not an integer
        {"max_total": True, "modules": {}},  # a bool is not a count
        [],  # not an object
    ],
    ids=["no-max", "negative", "string", "bool", "list"],
)
def test_malformed_budget_is_refused(skips, tmp_path, budget):
    assert _run(skips, tmp_path, {}, budget) == 2


def test_missing_summary_exits_2(skips, tmp_path, capsys):
    budget = _write(tmp_path / "budget.json", {"max_total": 0, "modules": {}})
    missing = tmp_path / "nope" / "pytest-summary.json"
    assert skips.main(["--summary", str(missing), "--budget", str(budget)]) == 2
    assert "summary not found" in capsys.readouterr().out


def test_summary_without_host_counts_exits_2(skips, tmp_path):
    summary = _write(tmp_path / "pytest-summary.json", {"tests": {}})
    budget = _write(tmp_path / "budget.json", {"max_total": 0, "modules": {}})
    assert skips.main(["--summary", str(summary), "--budget", str(budget)]) == 2


def test_committed_budget_loads_and_is_within_its_max(skips):
    budgets = skips.load_budget(BUDGET)
    doc = json.loads(BUDGET.read_text(encoding="utf-8"))
    assert sum(budgets.values()) <= doc["max_total"]
    assert set(budgets) >= {
        "tests/engine/test_contract.py",
        "tests/engine/test_content_edit.py",
        "tests/engine/test_text_edit_forms.py",
        "tests/engine/test_page_ops.py",
        "tests/engine/test_mupdf_pagecopy.py",
    }


def test_host_only_reason_is_the_plugin_reason(skips):
    stubs = _load(
        "pyodide_host_stubs_for_skips", ROOT / "web" / "test" / "pyodide" / "host_stubs.py"
    )
    assert skips.HOST_ONLY_REASON_PREFIX == stubs.HOST_PREFIX
