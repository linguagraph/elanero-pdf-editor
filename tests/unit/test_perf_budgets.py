"""Consistency of the shared performance budget table, tests/perf/budgets.json.

Deterministic and cheap, so it runs on every PR (desktop CI). It reads the test sources with
``ast`` rather than importing them, so PySide6 is not needed here. The checks:

- every metric in the table has an emitter (a budget test that records it),
- every emitter records a metric that is in the table,
- every row has the fields its ``kind`` needs.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

from tests.perf.table import (
    REQUIRED_FIELDS,
    TABLE_PATH,
    BudgetTableError,
    load,
    metric,
    metrics,
)

ROOT = Path(__file__).resolve().parents[2]
BENCH_DIR = ROOT / "tests" / "benchmarks"
ID_PATTERN = re.compile(r"^[DW]\d+$")
# Calls that record a metric: name -> index of the positional argument holding the id.
EMITTERS = {"_check": 1, "perf": 0}
COMMON_FIELDS = (
    "id",
    "unit",
    "kind",
    "note",
    "enforce",
    "baseline_ms",
    "baseline_date",
    "baseline_machine",
)


def _guarded_asserts(metric_id: str, tree: ast.AST) -> tuple[int, list[ast.Assert]]:
    """Count the asserts that compare against ``metric_id``'s limit, and those unguarded.

    An assert counts as guarded when an enclosing ``if`` tests ``enforced("<id>")``.
    """
    parents: dict[ast.AST, ast.AST] = {}
    for parent in ast.walk(tree):
        for child in ast.iter_child_nodes(parent):
            parents[child] = parent

    def mentions(node: ast.AST, call: str) -> bool:
        return any(
            isinstance(sub, ast.Call)
            and isinstance(sub.func, ast.Name)
            and sub.func.id == call
            and any(isinstance(a, ast.Constant) and a.value == metric_id for a in sub.args)
            for sub in ast.walk(node)
        )

    total = 0
    unguarded: list[ast.Assert] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assert):
            continue
        if not any(
            isinstance(sub, ast.Call)
            and isinstance(sub.func, ast.Name)
            and sub.func.id == "_budget_ms"
            and any(isinstance(a, ast.Constant) and a.value == metric_id for a in sub.args)
            for sub in ast.walk(node.test)
        ):
            continue
        total += 1
        current: ast.AST | None = node
        guarded = False
        while current is not None and not guarded:
            current = parents.get(current)
            if isinstance(current, ast.If) and mentions(current.test, "enforced"):
                guarded = True
        if not guarded:
            unguarded.append(node)
    return total, unguarded


def _emitted_ids() -> dict[str, list[str]]:
    """Metric id -> the test files that record it, found by scanning the benchmark sources."""
    found: dict[str, list[str]] = {}
    for path in sorted(BENCH_DIR.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
                continue
            index = EMITTERS.get(node.func.id)
            if index is None or len(node.args) <= index:
                continue
            arg = node.args[index]
            value = arg.value if isinstance(arg, ast.Constant) else None
            if isinstance(value, str) and ID_PATTERN.match(value):
                found.setdefault(value, []).append(path.name)
    return found


def test_every_row_has_an_emitter_and_every_emitter_has_a_row() -> None:
    rows = set(metrics())
    emitted = _emitted_ids()
    assert rows, "the budget table has no metrics"
    assert set(emitted) - rows == set(), "budget tests record ids missing from budgets.json"
    assert rows - set(emitted) == set(), "budgets.json rows have no budget test"


def test_each_metric_has_one_emitting_call_site() -> None:
    for metric_id, files in _emitted_ids().items():
        assert len(files) == 1, f"{metric_id} is recorded in {files}"


def test_table_header_and_ids() -> None:
    table = load()
    assert table["baseline_ref"].startswith("v"), "baseline_ref must be a release tag"
    assert table["runner_factors"]["env"] == "PDFEDITOR_PERF_FACTOR"
    ids = [row["id"] for row in table["metrics"]]
    assert len(ids) == len(set(ids)), "duplicate metric id"
    for metric_id in ids:
        assert ID_PATTERN.match(metric_id), metric_id


@pytest.mark.parametrize("row", load()["metrics"], ids=lambda r: r["id"])
def test_row_has_the_fields_its_kind_needs(row: dict) -> None:
    kind = row["kind"]
    assert kind in REQUIRED_FIELDS, f"{row['id']}: unknown kind {kind!r}"
    missing = [f for f in COMMON_FIELDS + REQUIRED_FIELDS[kind] if f not in row]
    assert not missing, f"{row['id']} ({kind}) lacks {missing}"
    for field in REQUIRED_FIELDS[kind]:
        assert isinstance(row[field], int | float), f"{row['id']}.{field} must be a number"
    assert row["note"].strip(), f"{row['id']} needs a note"


def test_baseline_is_recorded_or_marked_unmeasured() -> None:
    for row in load()["metrics"]:
        if row["baseline_ms"] is None:
            assert row["note"].startswith("PROVISIONAL"), f"{row['id']} has no baseline"
        else:
            assert isinstance(row["baseline_ms"], int | float), row["id"]


@pytest.mark.parametrize("row", load()["metrics"], ids=lambda r: r["id"])
def test_enforce_is_a_bool_and_needs_a_baseline(row: dict) -> None:
    assert isinstance(row["enforce"], bool), f"{row['id']}.enforce must be true or false"
    if row["baseline_ms"] is None:
        assert row["enforce"] is False, f"{row['id']} has no baseline, so it cannot be enforced"


@pytest.mark.parametrize(
    "row", [r for r in load()["metrics"] if not r["enforce"]], ids=lambda r: r["id"]
)
def test_unenforced_row_has_no_unguarded_assert(row: dict) -> None:
    # The emitter must not assert against the limit unless enforced("<id>") gates it.
    metric_id = row["id"]
    emitter = BENCH_DIR / _emitted_ids()[metric_id][0]
    tree = ast.parse(emitter.read_text(encoding="utf-8"), filename=str(emitter))
    total, unguarded = _guarded_asserts(metric_id, tree)
    where = f" (line {unguarded[0].lineno})" if unguarded else ""
    assert not unguarded, f"{metric_id} is trend only but asserts unguarded{where}"
    assert total <= 1, f"{metric_id}: the guard is expected in one assert, found {total}"


def test_unknown_metric_id_names_the_path_and_known_ids() -> None:
    with pytest.raises(BudgetTableError, match=r"no metric D9 in .*budgets\.json; known: D1, D2"):
        metric("D9")


def test_table_is_codeowned() -> None:
    owners = (ROOT / ".github" / "CODEOWNERS").read_text(encoding="utf-8")
    assert "tests/perf/budgets.json" in owners
    assert TABLE_PATH.relative_to(ROOT).as_posix() == "tests/perf/budgets.json"
