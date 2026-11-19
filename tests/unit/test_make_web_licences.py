"""The generator of the web build's third-party licence notice (W9.5b).

The committed web/app/public/THIRD_PARTY_LICENSES.txt matches a fresh build, and the build fails
loudly on each kind of input drift: a runtime package without a licence or copyright line, a stale
copyright entry, a Pyodide or PyMuPDF version that the TOML does not repeat, an npm version that
the lock has moved past, a lock-pinned component that disagrees with the lock, two runtime versions
of one package. ``--verify-installed`` checks the same inputs against an installed node_modules. The
tests use small lock, TOML and node_modules fixtures written into tmp_path, so they run without
the real node_modules or the desktop dependencies (stdlib only, so the Pyodide web-pytest run
includes them).
"""

from __future__ import annotations

import json
import shutil
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
version = "19.0.0"
copyright = "Copyright (c) Meta Platforms, Inc. and affiliates."

[npm."@scope/pkg"]
version = "1.2.3"
copyright = "Copyright (c) Scope Authors."
"""

_REACT_LINE = "Copyright (c) Meta Platforms, Inc. and affiliates."
_SCOPE_LINE = "Copyright (c) Scope Authors."

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
        self.node_modules = tmp_path / "node_modules"
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

    def install(self, name: str, version: str, licence_files: dict[str, bytes] | None) -> None:
        """Write an installed package: its package.json and whatever licence files it has."""
        package_dir = self.node_modules / name
        # Replace the package wholesale, so a licence file from an earlier call does not linger.
        shutil.rmtree(package_dir, ignore_errors=True)
        package_dir.mkdir(parents=True)
        (package_dir / "package.json").write_text(
            json.dumps({"name": name, "version": version}), encoding="utf-8"
        )
        for file_name, body in (licence_files or {}).items():
            (package_dir / file_name).write_bytes(body)

    def install_all(self) -> None:
        """Install the two runtime packages of the default fixture, each with its copyright."""
        self.install("react", "19.0.0", {"LICENSE": f"MIT\n{_REACT_LINE}\n".encode()})
        self.install("@scope/pkg", "1.2.3", {"LICENSE.md": f"{_SCOPE_LINE}\n".encode()})

    def make(self) -> str:
        return make_web_licences.make(
            lock=self.lock,
            versions=self.versions,
            inputs=self.inputs,
            texts=self.texts,
            agpl=self.agpl,
        )

    def verify(self) -> tuple[list[str], list[str], int]:
        return make_web_licences.verify_installed(
            lock=self.lock, inputs=self.inputs, node_modules=self.node_modules
        )


def test_a_clean_fixture_builds(tmp_path: Path) -> None:
    text = Inputs(tmp_path).make()
    assert "react" in text
    assert "Copyright (c) Meta Platforms, Inc. and affiliates." in text
    assert "Pyodide contributors" in text


def test_dev_packages_are_excluded(tmp_path: Path) -> None:
    text = Inputs(tmp_path).make()
    assert "vitest" not in text


def test_dev_optional_packages_are_excluded(tmp_path: Path) -> None:
    inputs = Inputs(tmp_path)
    inputs.set_lock(
        {
            **_RUNTIME_LOCK,
            "node_modules/optional-tool": {
                "version": "2.0.0",
                "license": "MIT",
                "devOptional": True,
            },
        }
    )
    assert "optional-tool" not in inputs.make()


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
        '[npm."react"]\nversion = "19.0.0"\n'
        'copyright = "Copyright (c) Meta Platforms, Inc. and affiliates."\n'
    )
    inputs.set_toml(_TOML.replace(react_entry, ""))
    with pytest.raises(NoticeError) as raised:
        inputs.make()
    assert any('[npm."react"]' in problem for problem in raised.value.problems)


def test_a_stale_copyright_entry_fails(tmp_path: Path) -> None:
    inputs = Inputs(tmp_path)
    inputs.set_toml(
        _TOML + '\n[npm."long-gone"]\nversion = "1.0.0"\ncopyright = "Copyright (c) Nobody."\n'
    )
    with pytest.raises(NoticeError) as raised:
        inputs.make()
    assert any(
        '"long-gone"' in problem and "does not ship" in problem for problem in raised.value.problems
    )


def test_a_lock_bump_without_a_version_update_fails_and_names_the_package(tmp_path: Path) -> None:
    inputs = Inputs(tmp_path)
    inputs.set_lock(
        {**_RUNTIME_LOCK, "node_modules/react": {"version": "19.0.1", "license": "MIT"}}
    )
    with pytest.raises(NoticeError) as raised:
        inputs.make()
    assert any(
        "'react' is 19.0.1 in the lock but 19.0.0 in web_licences.toml" in problem
        and "re-read its licence file" in problem
        for problem in raised.value.problems
    )


def test_a_runtime_npm_entry_without_a_version_fails(tmp_path: Path) -> None:
    inputs = Inputs(tmp_path)
    inputs.set_toml(_TOML.replace('version = "19.0.0"\n', ""))
    with pytest.raises(NoticeError) as raised:
        inputs.make()
    assert any(
        "'react' has no version" in problem and 'version = "19.0.0"' in problem
        for problem in raised.value.problems
    )


def test_an_npm_note_is_rendered_under_its_entry(tmp_path: Path) -> None:
    inputs = Inputs(tmp_path)
    inputs.set_toml(
        _TOML.replace(
            'copyright = "Copyright (c) Meta',
            'note = "No licence file in the package."\ncopyright = "Copyright (c) Meta',
        )
    )
    text = inputs.make()
    assert (
        "react\n  Version: 19.0.0\n  Licence: MIT\n"
        f"  Copyright: {_REACT_LINE}\n  Note: No licence file in the package.\n"
    ) in text


def test_a_lock_pinned_component_must_match_the_lock(tmp_path: Path) -> None:
    inputs = Inputs(tmp_path)
    component = (
        '[[component]]\nname = "React runtime"\nversion = "19.0.0"\nlock = "react"\n'
        'license = "MIT"\ncopyright = ["Copyright (c) Meta"]\n'
    )
    inputs.set_toml(_TOML + "\n" + component)
    assert "React runtime" in inputs.make()

    inputs.set_toml(_TOML + "\n" + component.replace('"19.0.0"', '"18.3.1"'))
    with pytest.raises(NoticeError) as raised:
        inputs.make()
    assert any(
        "'React runtime' is 18.3.1 in web_licences.toml but react is 19.0.0 in the lock" in problem
        for problem in raised.value.problems
    )


def test_a_lock_pinned_component_may_name_a_dev_package(tmp_path: Path) -> None:
    inputs = Inputs(tmp_path)
    component = (
        '[[component]]\nname = "Test runner"\nversion = "2.0.0"\nlock = "vitest"\n'
        'license = "MIT"\ncopyright = ["Copyright (c) Test"]\n'
    )
    inputs.set_toml(_TOML + "\n" + component)
    with pytest.raises(NoticeError) as raised:
        inputs.make()
    assert any(
        "'Test runner' is 2.0.0 in web_licences.toml but vitest is 3.0.0" in problem
        for problem in raised.value.problems
    )


def test_a_lock_pinned_component_naming_no_package_fails(tmp_path: Path) -> None:
    inputs = Inputs(tmp_path)
    component = (
        '[[component]]\nname = "Ghost"\nversion = "1.0.0"\nlock = "no-such-package"\n'
        'license = "MIT"\ncopyright = ["Copyright (c) Ghost"]\n'
    )
    inputs.set_toml(_TOML + "\n" + component)
    with pytest.raises(NoticeError) as raised:
        inputs.make()
    assert any(
        "'Ghost' names lock package 'no-such-package'" in problem
        for problem in raised.value.problems
    )


def test_a_runtime_package_at_two_versions_fails(tmp_path: Path) -> None:
    inputs = Inputs(tmp_path)
    inputs.set_lock(
        {
            **_RUNTIME_LOCK,
            "node_modules/a/node_modules/react": {"version": "18.0.0", "license": "MIT"},
        }
    )
    with pytest.raises(NoticeError) as raised:
        inputs.make()
    assert any(
        "'react' is at 19.0.0 and at 18.0.0 in the runtime lock" in problem
        for problem in raised.value.problems
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
    inputs.set_lock({"node_modules/react": {"version": "19.0.1"}})
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


def test_verify_installed_passes_when_the_copyright_lines_are_present(tmp_path: Path) -> None:
    inputs = Inputs(tmp_path)
    inputs.install_all()
    problems, unverified, count = inputs.verify()
    assert (problems, unverified, count) == ([], [], 2)


def test_verify_installed_accepts_crlf_and_any_licence_file_name(tmp_path: Path) -> None:
    inputs = Inputs(tmp_path)
    inputs.install("react", "19.0.0", {"license": f"MIT\r\n{_REACT_LINE}\r\n".encode()})
    inputs.install("@scope/pkg", "1.2.3", {"COPYING": f"{_SCOPE_LINE}\n".encode()})
    assert inputs.verify()[0] == []


def test_verify_installed_fails_when_a_copyright_line_is_absent(tmp_path: Path) -> None:
    inputs = Inputs(tmp_path)
    inputs.install_all()
    inputs.install("react", "19.0.0", {"LICENSE": b"MIT\nCopyright (c) Someone Else.\n"})
    problems, _, _ = inputs.verify()
    assert len(problems) == 1
    assert "'react'" in problems[0]
    assert "is not in its licence file (LICENSE)" in problems[0]


def test_verify_installed_fails_on_an_installed_version_mismatch(tmp_path: Path) -> None:
    inputs = Inputs(tmp_path)
    inputs.install_all()
    inputs.install("react", "18.3.1", {"LICENSE": f"{_REACT_LINE}\n".encode()})
    problems, _, _ = inputs.verify()
    assert problems == [
        "npm package 'react' is 18.3.1 installed but 19.0.0 in the lock: run npm ci in web/app"
    ]


def test_verify_installed_fails_on_a_package_with_no_licence_file_and_no_note(
    tmp_path: Path,
) -> None:
    inputs = Inputs(tmp_path)
    inputs.install_all()
    inputs.install("react", "19.0.0", {})  # the package ships no licence file
    problems, _, _ = inputs.verify()
    assert len(problems) == 1
    assert "'react' has no licence file" in problems[0]
    assert '[npm."react"]' in problems[0]


def test_verify_installed_accepts_a_package_with_no_licence_file_when_it_has_a_note(
    tmp_path: Path,
) -> None:
    inputs = Inputs(tmp_path)
    inputs.install_all()
    inputs.install("react", "19.0.0", {})
    inputs.set_toml(
        _TOML.replace(
            'copyright = "Copyright (c) Meta',
            'note = "The package ships no licence file."\ncopyright = "Copyright (c) Meta',
        )
    )
    assert inputs.verify()[0] == []


def test_verify_installed_lists_a_to_confirm_entry_without_failing(tmp_path: Path) -> None:
    inputs = Inputs(tmp_path)
    inputs.install_all()
    inputs.install("react", "19.0.0", {})  # no licence file, and the mark is "To confirm"
    inputs.set_toml(
        _TOML.replace(
            'copyright = "Copyright (c) Meta Platforms, Inc. and affiliates."',
            'copyright = "To confirm: the copyright line."',
        )
    )
    problems, unverified, count = inputs.verify()
    assert (problems, unverified, count) == ([], ["react"], 2)


def test_verify_installed_needs_node_modules(tmp_path: Path) -> None:
    problems, unverified, count = Inputs(tmp_path).verify()
    assert count == 0 and unverified == []
    assert len(problems) == 1 and "is missing: run npm ci in web/app" in problems[0]


def test_verify_installed_reports_a_package_that_is_not_installed(tmp_path: Path) -> None:
    inputs = Inputs(tmp_path)
    inputs.install("react", "19.0.0", {"LICENSE": f"{_REACT_LINE}\n".encode()})
    problems, _, _ = inputs.verify()
    assert problems == ["npm package '@scope/pkg' is not installed: run npm ci in web/app"]
