"""Ratchet on the host-only skips of the Pyodide run (design W1.7 section 3).

    python scripts/check_web_skips.py [--summary PATH] [--budget PATH]

Reads the summary the Pyodide runner writes (web/test/pyodide/out/pytest-summary.json) and the
budget file (web/test/pyodide/host-skip-budget.json). A host-only skip is a test that stopped at
its first pikepdf or pypdfium2 call under Pyodide. The plugin counts them per module in
``hostSkipsByModule``; this script compares each module with its budget.

The budget file is ``{"max_total": N, "modules": {"tests/...py": budget}}``. Its budgets may
only go down: a file whose budgets add up to more than ``max_total`` is refused.

Exit status: 0 when every module is within its budget, 1 when a module is over its budget or
has host-only skips and no budget entry, 2 when an input is missing or refused.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SUMMARY = ROOT / "web" / "test" / "pyodide" / "out" / "pytest-summary.json"
DEFAULT_BUDGET = ROOT / "web" / "test" / "pyodide" / "host-skip-budget.json"

# The reason the plugin gives a host-only skip (web/test/pyodide/host_stubs.py HOST_PREFIX).
# Any other skip is not host-only and is not counted here.
HOST_ONLY_REASON_PREFIX = "needs host-side verification"

EXIT_OK, EXIT_OVER, EXIT_BAD = 0, 1, 2


class Refused(Exception):
    """An input cannot be checked. The message is printed before exit 2."""


def load_summary(path: Path) -> dict[str, int]:
    """Host-only skips per module, from the runner's summary."""
    try:
        summary = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise Refused(f"summary not found: {path} (the Pyodide run did not write it)") from exc
    except ValueError as exc:
        raise Refused(f"summary is not JSON: {path}: {exc}") from exc
    counts = summary.get("hostSkipsByModule") if isinstance(summary, dict) else None
    if not isinstance(counts, dict) or not all(
        isinstance(k, str) and isinstance(v, int) and v >= 0 for k, v in counts.items()
    ):
        raise Refused(f"{path} has no valid hostSkipsByModule (regenerate it with the plugin)")
    return counts


def _budget_error(message: str) -> Refused:
    return Refused(f"budget file refused: {message}")


def load_budget(path: Path) -> dict[str, int]:
    """Per-module budgets. Refused when the shape is wrong or the total exceeds ``max_total``."""
    try:
        doc: Any = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise Refused(f"budget file not found: {path}") from exc
    except ValueError as exc:
        raise _budget_error(f"not JSON: {exc}") from exc
    if not isinstance(doc, dict):
        raise _budget_error("the top level must be an object")
    max_total = doc.get("max_total")
    modules = doc.get("modules")
    if not isinstance(max_total, int) or isinstance(max_total, bool) or max_total < 0:
        raise _budget_error("max_total must be a non-negative integer")
    if not isinstance(modules, dict):
        raise _budget_error("modules must be an object of module path to budget")
    for module, budget in modules.items():
        if not isinstance(budget, int) or isinstance(budget, bool) or budget < 0:
            raise _budget_error(f"budget for {module} must be a non-negative integer")
    total = sum(modules.values())
    if total > max_total:
        raise _budget_error(f"budgets total {total}, above max_total {max_total}")
    return modules


def check(counts: dict[str, int], budgets: dict[str, int]) -> list[str]:
    """One line per module with host-only skips; the caller counts the failures."""
    lines = []
    for module in sorted(counts):
        count = counts[module]
        if count == 0:
            continue
        if module not in budgets:
            lines.append(f"FAIL {module}: {count} host-only skips and no budget entry")
        elif count > budgets[module]:
            lines.append(f"FAIL {module}: {count} host-only skips, budget {budgets[module]}")
        else:
            lines.append(f"ok   {module}: {count} host-only skips, budget {budgets[module]}")
    return lines


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--summary", type=Path, default=DEFAULT_SUMMARY)
    parser.add_argument("--budget", type=Path, default=DEFAULT_BUDGET)
    args = parser.parse_args(argv)
    try:
        counts = load_summary(args.summary)
        budgets = load_budget(args.budget)
    except Refused as exc:
        print(f"FAIL {exc}")
        return EXIT_BAD
    lines = check(counts, budgets)
    for line in lines:
        print(line)
    failed = sum(1 for line in lines if line.startswith("FAIL"))
    total = sum(counts.values())
    print(
        f"host-only skips: {total} in {sum(1 for c in counts.values() if c)} modules, "
        f"{failed} module(s) over budget"
    )
    return EXIT_OVER if failed else EXIT_OK


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
