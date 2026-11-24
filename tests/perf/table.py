"""Reads the shared performance budget table, ``tests/perf/budgets.json``.

Every budget test takes its limit from here, so the number lives in one reviewed file. The
web harness (W1 to W9) reads the same file by its relative path. The reader is stdlib only.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

TABLE_PATH = Path(__file__).resolve().parent / "budgets.json"

# The fields each kind must carry, checked by tests/unit/test_perf_budgets.py.
REQUIRED_FIELDS: dict[str, tuple[str, ...]] = {
    "absolute": ("limit_ms",),
    "paired": ("pct", "abs_ms"),
    "trend": (),
    "ceiling": ("factor",),
    "hard": ("limit",),
}


class BudgetTableError(ValueError):
    """The budget table is missing, unreadable, or lacks the row asked for."""


@dataclass(frozen=True)
class Metric:
    id: str
    kind: str
    raw: dict[str, Any]

    def __getitem__(self, key: str) -> Any:
        return self.raw[key]


def load(path: Path = TABLE_PATH) -> dict[str, Any]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise BudgetTableError(f"cannot read the budget table {path}: {exc}") from exc
    try:
        table = json.loads(text)
    except json.JSONDecodeError as exc:
        raise BudgetTableError(f"the budget table {path} is not valid JSON: {exc}") from exc
    if not isinstance(table, dict) or not isinstance(table.get("metrics"), list):
        raise BudgetTableError(f"the budget table {path} has no 'metrics' list")
    return table


def metrics(path: Path = TABLE_PATH) -> dict[str, Metric]:
    result: dict[str, Metric] = {}
    for index, row in enumerate(load(path)["metrics"]):
        if not isinstance(row, dict) or "id" not in row:
            raise BudgetTableError(f"row {index} of the budget table {path} has no id")
        result[row["id"]] = Metric(row["id"], row.get("kind", ""), row)
    return result


def metric(metric_id: str, path: Path = TABLE_PATH) -> Metric:
    """The row for ``metric_id``; an unknown id names the known ones."""
    table = metrics(path)
    if metric_id not in table:
        known = ", ".join(table)
        raise BudgetTableError(f"no metric {metric_id} in {path}; known: {known}")
    return table[metric_id]


def enforced(metric_id: str, path: Path = TABLE_PATH) -> bool:
    """Whether the budget test asserts against the limit (False = trend only, no gate)."""
    return bool(metric(metric_id, path)["enforce"])


def limit_ms(metric_id: str, path: Path = TABLE_PATH) -> float:
    """The absolute limit in ms, before the runner factor is applied."""
    row = metric(metric_id, path)
    assert row.kind == "absolute", f"{metric_id} is {row.kind}, not absolute"
    return float(row["limit_ms"])
