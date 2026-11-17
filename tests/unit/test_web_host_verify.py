"""scripts/web_host_verify.py: replays recorded host checks on host CPython (calls main)."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

import pytest

from tests import hostcheck

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def verifier() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "web_host_verify_under_test", ROOT / "scripts" / "web_host_verify.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclasses look the module up by name
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def pyodide(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(hostcheck, "in_pyodide", lambda: True)
    hostcheck.clear()
    yield
    hostcheck.clear()


def _manifest(tmp_path: Path, checks: list[dict[str, object]]) -> Path:
    path = tmp_path / "host-checks.json"
    path.write_text(json.dumps({"version": 1, "checks": checks}), encoding="utf-8")
    return path


def test_known_check_passes_on_a_good_pdf(verifier, fixture_pdf, pyodide, tmp_path, capsys):
    hostcheck.record("page_count_pdfium", fixture_pdf("text_multipage"), pages=5)
    manifest = _manifest(tmp_path, hostcheck.recorded())
    assert verifier.main([str(manifest)]) == 0
    out = capsys.readouterr().out
    assert "PASS page_count_pdfium" in out
    assert "host checks: 1 passed, 0 failed, 1 recorded" in out


def test_page_count_mismatch_fails(verifier, fixture_pdf, pyodide, tmp_path, capsys):
    hostcheck.record("page_count_pdfium", fixture_pdf("text_multipage"), pages=3)
    manifest = _manifest(tmp_path, hostcheck.recorded())
    assert verifier.main([str(manifest)]) == 1
    assert "FAIL page_count_pdfium" in capsys.readouterr().out


def test_unreadable_file_is_a_failure_not_a_crash(verifier, pyodide, tmp_path, capsys):
    hostcheck.record("page_count_pdfium", b"this is not a pdf", pages=1)
    manifest = _manifest(tmp_path, hostcheck.recorded())
    assert verifier.main([str(manifest)]) == 1
    assert "FAIL page_count_pdfium" in capsys.readouterr().out


def test_unknown_check_name_refuses_the_manifest(verifier, tmp_path, capsys):
    manifest = _manifest(
        tmp_path, [{"name": "no_such_check", "args": "{}", "data_b64": "", "test": ""}]
    )
    assert verifier.main([str(manifest)]) == 2
    assert "FAIL unknown host check no_such_check" in capsys.readouterr().out


def test_unknown_name_refuses_even_after_a_good_entry(
    verifier, fixture_pdf, pyodide, tmp_path, capsys
):
    """The whole manifest is validated first: a good entry before a bad name is not run either."""
    hostcheck.record("page_count_pdfium", fixture_pdf("text_multipage"), pages=5)
    checks = [*hostcheck.recorded(), {"name": "nope", "args": "{}", "data_b64": ""}]
    assert verifier.main([str(_manifest(tmp_path, checks))]) == 2
    assert "PASS" not in capsys.readouterr().out


@pytest.mark.parametrize(
    "content",
    ["not json", json.dumps({"version": 2, "checks": []}), json.dumps({"version": 1})],
    ids=["not-json", "wrong-version", "no-checks"],
)
def test_bad_manifest_exits_2(verifier, tmp_path, content, capsys):
    path = tmp_path / "bad.json"
    path.write_text(content, encoding="utf-8")
    assert verifier.main([str(path)]) == 2


def test_bad_arguments_exit_2(verifier, tmp_path, capsys):
    bad_args = [{"name": "page_count_pdfium", "args": "[1]", "data_b64": "", "test": ""}]
    assert verifier.main([str(_manifest(tmp_path, bad_args))]) == 2
    assert verifier.main([]) == 2  # no manifest given
    assert "usage:" in capsys.readouterr().err


def test_empty_manifest_passes(verifier, tmp_path, capsys):
    assert verifier.main([str(_manifest(tmp_path, []))]) == 0
    assert "host checks: 0 passed, 0 failed, 0 recorded" in capsys.readouterr().out
