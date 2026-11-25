"""Merge the shards of the Pyodide run (web/test/pyodide/run_tests.mjs --shard k/N) into out/.

    python scripts/merge_pyodide_shards.py --shards N [--dir web/test/pyodide]

Reads <dir>/out-0 .. out-(N-1) and writes <dir>/out/:

- host-checks.json: {"version": 1, "checks": [...]}, the shards' manifests concatenated in shard
  order, from whichever shards wrote one.
- pytest-summary.json: the integer counts summed and the lists concatenated. Written only when all
  N shard summaries exist. Otherwise nothing is written (and a stale one is removed), so the skip
  check fails with "summary not found".
- run.json: {"shards": [the per-shard run records], "testMs": the slowest shard, "loadMs": the
  slowest load}.

The shards' pytest.xml files stay in out-k/. Each shard's loadMs and testMs are printed.

Exit status: 0 when every shard wrote run.json, pytest-summary.json and pytest.xml; 2 when any of
those is missing or unreadable, or when N is not in 1..4. host-checks.json is optional only for a
shard with no summary; a shard with a summary and no readable host-checks.json is an error, and
then no merged summary or host-checks file is written, so nothing reads as complete.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DIR = ROOT / "web" / "test" / "pyodide"
MAX_SHARDS = 4

# Keys of the summary that hold counts (nested dicts of ints) and keys that hold lists.
SUMMED_KEYS = ("tests", "ranEngineCode", "criterion3", "skipReasons", "hostSkipsByModule")
CONCATENATED_KEYS = ("moduleSkips", "failures")
EXIT_OK, EXIT_MISSING = 0, 2


def _add_counts(total: dict[str, Any], part: dict[str, Any]) -> dict[str, Any]:
    """Sum two nested dicts whose leaves are ints. A missing key counts as zero."""
    out = dict(total)
    for key, value in part.items():
        if isinstance(value, dict):
            out[key] = _add_counts(out.get(key, {}), value)
        elif isinstance(value, int) and not isinstance(value, bool):
            current = out.get(key, 0)
            if not isinstance(current, int):
                raise ValueError(f"count {key!r} is {current!r} in one shard, not a number")
            out[key] = current + value
        else:
            raise ValueError(f"count {key!r} is not an integer: {value!r}")
    return out


def merge_summaries(summaries: list[dict[str, Any]]) -> dict[str, Any]:
    """One summary from the shards': counts summed, lists concatenated in shard order."""
    known = set(SUMMED_KEYS) | set(CONCATENATED_KEYS)
    for summary in summaries:
        unknown = sorted(set(summary) - known)
        if unknown:
            # Refuse rather than drop: a new field must be added to a key list on purpose.
            raise ValueError(f"summary key(s) {unknown} are not merged; add them to a key list")
    merged: dict[str, Any] = {}
    for key in SUMMED_KEYS:
        total: dict[str, Any] = {}
        for summary in summaries:
            total = _add_counts(total, summary.get(key, {}))
        merged[key] = total
    for key in CONCATENATED_KEYS:
        merged[key] = [item for summary in summaries for item in summary.get(key, [])]
    return merged


def merge_host_checks(manifests: list[dict[str, Any]]) -> dict[str, Any]:
    """The shards' host-check manifests, one list in shard order."""
    checks: list[Any] = []
    for manifest in manifests:
        if manifest.get("version") != 1:
            raise ValueError(f"host-checks manifest version {manifest.get('version')!r}, want 1")
        checks.extend(manifest.get("checks", []))
    return {"version": 1, "checks": checks}


def merge_runs(records: list[dict[str, Any]]) -> dict[str, Any]:
    """The per-shard run records, with the slowest load and test phase (shards run in parallel)."""
    return {
        "shards": records,
        "testMs": max((r["testMs"] for r in records), default=0),
        "loadMs": max((r["loadMs"] for r in records), default=0),
    }


def _read_json(path: Path) -> dict[str, Any] | None:
    """The file as a JSON object, or None when it is missing or unreadable."""
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) else None


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--shards", type=int, required=True)
    parser.add_argument("--dir", type=Path, default=DEFAULT_DIR)
    args = parser.parse_args(argv)
    n = args.shards
    if not 1 <= n <= MAX_SHARDS:
        print(f"::error::--shards {n}: need 1 to {MAX_SHARDS}")
        return EXIT_MISSING

    base: Path = args.dir
    out = base / "out"
    missing: list[str] = []
    runs: list[dict[str, Any]] = []
    summaries: list[dict[str, Any]] = []
    manifests: list[dict[str, Any]] = []
    incomplete = False
    for k in range(n):
        shard_dir = base / f"out-{k}"
        run = _read_json(shard_dir / "run.json")
        summary = _read_json(shard_dir / "pytest-summary.json")
        if not (shard_dir / "pytest.xml").is_file():
            missing.append(f"out-{k}/pytest.xml")
        if run is None:
            missing.append(f"out-{k}/run.json")
        else:
            runs.append(run)
            print(
                f"shard {k}: loadMs {run.get('loadMs')} testMs {run.get('testMs')} "
                f"pytest exit {run.get('exitCode')}"
            )
        if summary is None:
            missing.append(f"out-{k}/pytest-summary.json")
        else:
            summaries.append(summary)
        manifest = _read_json(shard_dir / "host-checks.json")
        if manifest is not None:
            manifests.append(manifest)
        elif summary is not None:
            # The runner writes a manifest next to every summary, even an empty one, so a
            # summary without a readable manifest lost its host checks: report it, write nothing.
            missing.append(f"out-{k}/host-checks.json (shard {k} has a summary)")
            incomplete = True

    out.mkdir(parents=True, exist_ok=True)
    # Merged files from an earlier run must not pass for this one.
    for name in ("pytest-summary.json", "host-checks.json", "run.json"):
        (out / name).unlink(missing_ok=True)
    if manifests and not incomplete:
        merged = merge_host_checks(manifests)
        (out / "host-checks.json").write_text(json.dumps(merged), encoding="utf-8")
    if len(summaries) == n and not incomplete:
        merged_summary = merge_summaries(summaries)
        text = json.dumps(merged_summary, indent=2)
        (out / "pytest-summary.json").write_text(text, encoding="utf-8")
    if runs:
        (out / "run.json").write_text(json.dumps(merge_runs(runs), indent=2), encoding="utf-8")

    if missing:
        print("::error::shard files missing: " + ", ".join(missing))
        return EXIT_MISSING
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
