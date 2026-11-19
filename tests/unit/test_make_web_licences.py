"""The generator of the web build's third-party licence notice (W9.5b).

The committed web/app/public/THIRD_PARTY_LICENSES.txt matches a fresh build, and the build fails
loudly on each kind of input drift: a runtime package without a licence or copyright line, a stale
copyright entry, a Pyodide or PyMuPDF version that the TOML does not repeat. The tests use small
lock and TOML fixtures written into tmp_path, so they run without node_modules or the desktop
dependencies (stdlib only, so the Pyodide web-pytest run includes them).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import make_web_licences  # noqa: E402
from make_web_licences import NoticeError  # noqa: E402


def _lock(packages: dict[str, dict[str, Any]]) -> dict[str, Any]:
    return {"name": "web", "lockfileVersion": 3, "packages": {"": {"name": "web"}, **packages}}


_RUNTIME_LOCK: dict[str, dict[str, Any]] = {
    "node_modules/react": {"version": "19.0.0", "license": "MIT"},
    "node_modules/@scope/pkg": {"version": "1.2.3", "license": "Apache-2.0"},
    "node_modules/vitest": {"version": "3.0.0", "license": "MIT", "dev": True},
}

_TOML = """\
pyodide = "314.0.8"
pymupdf = "1.28.2"

[[component]]
name = "Pyodide"
version = "314.0.8"
license = "MPL-2.0"
copyright = ["Copyright (c) Pyodide contributors"]

[npm."react"]
copyright = "Copyright (c) Meta Platforms, Inc. and affiliates."

[npm."@scope/pkg"]
copyright = "Copyright (c) Scope Authors."
"""

_VERSIONS = {"pyodide": "314.0.8", "pymupdf": "1.28.2"}


class Inputs:
    """A complete set of fixture inputs in tmp_path, with each piece replaceable by a test."""

    def __init__(self, tmp_path: Path) -> None:
        self.dir = tmp_path
        self.texts = tmp_path / "licence_texts"
        self.texts.mkdir()
        for licence in ("MIT", "Apache-2.0", "MPL-2.0"):
            (self.texts / f"{licence}.txt").write_text(f"{licence} text\n", encoding="utf-8")
        self.agpl = tmp_path / "LICENSE"
        self.agpl.write_text("AGPL text\n", encoding="utf-8")
        self.set_lock(_RUNTIME_LOCK)
        self.set_toml(_TOML)
        self.set_versions(_VERSIONS)

    def set_lock(self, packages: dict[str, dict[str, Any]]) -> None:
        self.lock = self.dir / "package-lock.json"
        self.lock.write_text(json.dumps(_lock(packages)), encoding="utf-8")

    def set_toml(self, text: str) -> None:
        self.inputs = self.dir / "web_licences.toml"
        self.inputs.write_text(text, encoding="utf-8")

    def set_versions(self, pins: dict[str, str]) -> None:
        self.versions = self.dir / "versions.json"
        self.versions.write_text(json.dumps(pins), encoding="utf-8")

    def make(self) -> str:
        return make_web_licences.make(
            lock=self.lock,
            versions=self.versions,
            inputs=self.inputs,
            texts=self.texts,
            agpl=self.agpl,
        )


def test_a_clean_fixture_builds(tmp_path: Path) -> None:
    text = Inputs(tmp_path).make()
    assert "react" in text
    assert "Copyright (c) Meta Platforms, Inc. and affiliates." in text
    assert "Pyodide contributors" in text


def test_dev_packages_are_excluded(tmp_path: Path) -> None:
    text = Inputs(tmp_path).make()
    assert "vitest" not in text


def test_a_scoped_package_name_comes_from_the_lock_key(tmp_path: Path) -> None:
    text = Inputs(tmp_path).make()
    assert "@scope/pkg\n  Version: 1.2.3" in text


def test_a_missing_licence_fails_and_names_the_package(tmp_path: Path) -> None:
    inputs = Inputs(tmp_path)
    inputs.set_lock({"node_modules/react": {"version": "19.0.0"}})
    with pytest.raises(NoticeError) as raised:
        inputs.make()
    assert any("'react'" in p and "no licence" in p for p in raised.value.problems)


def test_a_licence_without_a_standard_text_fails(tmp_path: Path) -> None:
    inputs = Inputs(tmp_path)
    inputs.set_lock({"node_modules/react": {"version": "19.0.0", "license": "ISC"}})
    with pytest.raises(NoticeError) as raised:
        inputs.make()
    assert any("'ISC'" in problem for problem in raised.value.problems)


def test_a_missing_copyright_entry_fails(tmp_path: Path) -> None:
    inputs = Inputs(tmp_path)
    react_entry = (
        '[npm."react"]\ncopyright = "Copyright (c) Meta Platforms, Inc. and affiliates."\n'
    )
    inputs.set_toml(_TOML.replace(react_entry, ""))
    with pytest.raises(NoticeError) as raised:
        inputs.make()
    assert any('[npm."react"]' in problem for problem in raised.value.problems)


def test_a_stale_copyright_entry_fails(tmp_path: Path) -> None:
    inputs = Inputs(tmp_path)
    inputs.set_toml(_TOML + '\n[npm."long-gone"]\ncopyright = "Copyright (c) Nobody."\n')
    with pytest.raises(NoticeError) as raised:
        inputs.make()
    assert any(
        '"long-gone"' in problem and "does not ship" in problem for problem in raised.value.problems
    )


@pytest.mark.parametrize(
    ("pin", "label"),
    [("pyodide", "Pyodide"), ("pymupdf", "PyMuPDF")],
)
def test_a_version_bump_without_a_toml_review_fails(tmp_path: Path, pin: str, label: str) -> None:
    inputs = Inputs(tmp_path)
    inputs.set_versions({**_VERSIONS, pin: "9.9.9"})
    with pytest.raises(NoticeError) as raised:
        inputs.make()
    assert any(f"review the {label} components" in problem for problem in raised.value.problems)


def test_all_problems_are_reported_in_one_run(tmp_path: Path) -> None:
    inputs = Inputs(tmp_path)
    inputs.set_lock({"node_modules/react": {"version": "19.0.0"}})
    inputs.set_versions({**_VERSIONS, "pyodide": "9.9.9"})
    with pytest.raises(NoticeError) as raised:
        inputs.make()
    problems = raised.value.problems
    assert len(problems) >= 3
    assert problems == sorted(problems)


def test_the_output_is_deterministic(tmp_path: Path) -> None:
    inputs = Inputs(tmp_path)
    first = inputs.make()
    assert inputs.make() == first
    # The order of the lock's packages does not change the notice.
    inputs.set_lock(dict(reversed(list(_RUNTIME_LOCK.items()))))
    assert inputs.make() == first


def test_the_committed_copy_is_current() -> None:
    assert make_web_licences.check() == 0, "run: uv run python scripts/make_web_licences.py"


def test_check_fails_on_a_stale_or_missing_copy(tmp_path: Path) -> None:
    fresh = make_web_licences.make()
    copy = tmp_path / "THIRD_PARTY_LICENSES.txt"
    assert make_web_licences.check(copy) == 1  # missing
    copy.write_bytes(fresh.replace("Elanero", "Elanero!", 1).encode("utf-8"))
    assert make_web_licences.check(copy) == 1  # out of date
    copy.write_bytes(fresh.encode("utf-8"))
    assert make_web_licences.check(copy) == 0
