"""scripts/merge_pyodide_shards.py: the merge of the Pyodide shards, its functions and main."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

import pytest


def _load() -> ModuleType:
    root = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location(
        "merge_pyodide_shards_under_test", root / "scripts" / "merge_pyodide_shards.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def merge() -> ModuleType:
    return _load()


def _summary(count: int, module: str) -> dict:
    return {
        "tests": {"passed": count, "failed": 0, "errored": 0, "skipped": 1},
        "ranEngineCode": {"passed": count},
        "criterion3": {"numerator": count, "passed": count, "failed": 0},
        "skipReasons": {"needs host-side verification: pikepdf": 1},
        "moduleSkips": [{"module": module, "reason": "x"}],
        "hostSkipsByModule": {module: 1},
        "failures": [{"nodeid": f"{module}::t", "when": "call"}],
    }


def test_counts_are_summed_and_lists_concatenated(merge):
    merged = merge.merge_summaries([_summary(2, "tests/a.py"), _summary(3, "tests/b.py")])
    assert merged["tests"] == {"passed": 5, "failed": 0, "errored": 0, "skipped": 2}
    assert merged["criterion3"] == {"numerator": 5, "passed": 5, "failed": 0}
    assert merged["ranEngineCode"] == {"passed": 5}
    assert merged["skipReasons"] == {"needs host-side verification: pikepdf": 2}
    assert merged["hostSkipsByModule"] == {"tests/a.py": 1, "tests/b.py": 1}
    assert [s["module"] for s in merged["moduleSkips"]] == ["tests/a.py", "tests/b.py"]
    assert [f["nodeid"] for f in merged["failures"]] == ["tests/a.py::t", "tests/b.py::t"]


def test_a_key_present_in_one_shard_only_is_kept(merge):
    merged = merge.merge_summaries([{"hostSkipsByModule": {"m.py": 2}}, {}])
    assert merged["hostSkipsByModule"] == {"m.py": 2}
    assert merged["tests"] == {}
    assert merged["failures"] == []


def test_a_non_integer_count_is_refused(merge):
    with pytest.raises(ValueError):
        merge.merge_summaries([{"tests": {"passed": "2"}}])


def test_host_checks_keep_shard_order(merge):
    first = {"version": 1, "checks": [{"id": "a"}, {"id": "b"}]}
    second = {"version": 1, "checks": [{"id": "c"}]}
    assert merge.merge_host_checks([first, second]) == {
        "version": 1,
        "checks": [{"id": "a"}, {"id": "b"}, {"id": "c"}],
    }


def test_host_checks_of_another_version_are_refused(merge):
    with pytest.raises(ValueError):
        merge.merge_host_checks([{"version": 2, "checks": []}])


def test_run_records_take_the_slowest_test_phase(merge):
    records = [{"testMs": 900, "loadMs": 4000}, {"testMs": 1200, "loadMs": 3000}]
    merged = merge.merge_runs(records)
    assert merged["testMs"] == 1200
    assert merged["loadMs"] == 4000
    assert merged["shards"] == records


def _write_shard(base: Path, k: int, *, summary: bool = True, run: bool = True) -> None:
    shard = base / f"out-{k}"
    shard.mkdir(parents=True, exist_ok=True)
    (shard / "pytest.xml").write_text("<testsuites/>", encoding="utf-8")
    if run:
        record = {"shard": k, "loadMs": 100 + k, "testMs": 200 + k, "exitCode": 0}
        (shard / "run.json").write_text(json.dumps(record), encoding="utf-8")
    if summary:
        doc = _summary(1, f"tests/m{k}.py")
        (shard / "pytest-summary.json").write_text(json.dumps(doc), encoding="utf-8")
        manifest = {"version": 1, "checks": [{"id": k}]}
        (shard / "host-checks.json").write_text(json.dumps(manifest), encoding="utf-8")


def test_main_merges_every_shard_into_out(merge, tmp_path, capsys):
    for k in range(2):
        _write_shard(tmp_path, k)
    assert merge.main(["--shards", "2", "--dir", str(tmp_path)]) == 0
    out = tmp_path / "out"
    summary = json.loads((out / "pytest-summary.json").read_text(encoding="utf-8"))
    assert summary["tests"]["passed"] == 2
    checks = json.loads((out / "host-checks.json").read_text(encoding="utf-8"))
    assert checks == {"version": 1, "checks": [{"id": 0}, {"id": 1}]}
    run = json.loads((out / "run.json").read_text(encoding="utf-8"))
    assert run["testMs"] == 201
    assert "shard 0: loadMs 100 testMs 200" in capsys.readouterr().out
    assert (tmp_path / "out-0" / "pytest.xml").is_file()


def test_missing_summary_writes_no_summary_and_exits_2(merge, tmp_path):
    _write_shard(tmp_path, 0)
    _write_shard(tmp_path, 1, summary=False)
    stale = tmp_path / "out" / "pytest-summary.json"
    stale.parent.mkdir(parents=True)
    stale.write_text("{}", encoding="utf-8")
    assert merge.main(["--shards", "2", "--dir", str(tmp_path)]) == 2
    assert not stale.exists()
    assert (tmp_path / "out" / "host-checks.json").is_file()


def test_missing_run_record_exits_2(merge, tmp_path):
    _write_shard(tmp_path, 0, run=False)
    assert merge.main(["--shards", "1", "--dir", str(tmp_path)]) == 2


@pytest.mark.parametrize("manifest_text", [None, "{not json"], ids=["missing", "unreadable"])
def test_summary_without_host_checks_exits_2_and_writes_no_summary(
    merge, tmp_path, capsys, manifest_text
):
    _write_shard(tmp_path, 0)
    _write_shard(tmp_path, 1)
    manifest = tmp_path / "out-1" / "host-checks.json"
    if manifest_text is None:
        manifest.unlink()
    else:
        manifest.write_text(manifest_text, encoding="utf-8")
    assert merge.main(["--shards", "2", "--dir", str(tmp_path)]) == 2
    assert "out-1/host-checks.json" in capsys.readouterr().out
    out = tmp_path / "out"
    assert not (out / "pytest-summary.json").exists()
    assert not (out / "host-checks.json").exists()


def test_unknown_summary_key_is_refused_not_dropped(merge):
    with pytest.raises(ValueError, match="newField"):
        merge.merge_summaries([_summary(1, "tests/a.py") | {"newField": {"passed": 1}}])


def test_more_than_four_shards_is_refused(merge, tmp_path):
    assert merge.main(["--shards", "5", "--dir", str(tmp_path)]) == 2
