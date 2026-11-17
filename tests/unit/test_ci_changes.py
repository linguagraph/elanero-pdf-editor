"""What CI runs for a pull request: skipping is safe only for what can't affect the app."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "scripts"))
import ci_changes


@pytest.mark.parametrize(
    "paths",
    [
        ["PLAN.md"],
        ["README.md", "docs/microsoft-store-submission.md"],
        ["LICENSE"],
        [".github/CODEOWNERS"],
        ["mkdocs.yml"],
        ["docs/guide/signing.md", "docs/guide/images/elanero-02-organize.png"],
        ["docs/landing/index.html", "docs/landing/landing.css"],
    ],
)
def test_docs_alone_skip_everything(paths: list[str]) -> None:
    assert ci_changes.classify(paths) == {"app": False, "packaging": False}


@pytest.mark.parametrize(
    "paths",
    [
        ["src/pdfeditor/ui/main_window.py"],
        ["tests/unit/test_msix.py"],
        ["scripts/make_fixtures.py"],
        ["PLAN.md", "src/pdfeditor/app.py"],
        ["something/new.txt"],
        ["scripts/build_site.py"],
    ],
)
def test_code_runs_the_tests_but_not_the_install_tests(paths: list[str]) -> None:
    assert ci_changes.classify(paths) == {"app": True, "packaging": False}


@pytest.mark.parametrize(
    "path",
    [
        "packaging/pdfeditor.spec",
        "packaging/installer.iss",
        "pyproject.toml",
        ".github/workflows/ci.yml",
        "scripts/build_exe.py",
        "scripts/msix_package.py",
        "src/pdfeditor/selftest.py",
    ],
)
def test_packaging_changes_run_the_install_tests(path: str) -> None:
    assert ci_changes.classify([path]) == {"app": True, "packaging": True}


@pytest.mark.parametrize(
    "paths",
    [
        ["web/spike/README.md"],
        ["web/spike/smoke/worker.js"],
        ["web/spike/pyodide_conftest.py"],
        ["web\\spike\\smoke\\worker.js"],
        [".github/workflows/web-spike.yml"],
        ["docs/web/plan.md", "web/spike/x.mjs"],
    ],
)
def test_web_alone_skips_the_desktop_ci(paths: list[str]) -> None:
    assert ci_changes.classify(paths) == {"app": False, "packaging": False}


@pytest.mark.parametrize(
    "paths", [["web/src/generated/shortcuts.json"], ["web\\src\\generated\\shortcuts.json"]]
)
def test_a_generated_web_file_runs_the_desktop_ci(paths: list[str]) -> None:
    """The desktop generates these and tests them, so a hand edit must not skip the checks."""
    assert ci_changes.classify(paths) == {"app": True, "packaging": False}


def test_web_with_app_code_runs_the_desktop_ci() -> None:
    assert ci_changes.classify(["web/spike/README.md", "src/pdfeditor/app.py"]) == {
        "app": True,
        "packaging": False,
    }


@pytest.mark.parametrize(
    "path", ["webapp/x.py", "web-foo/x", "src/pdfeditor/web/x.py", "src/pdfeditor/webapi/x.py"]
)
def test_only_the_top_level_web_folder_is_web(path: str) -> None:
    assert ci_changes.classify([path]) == {"app": True, "packaging": False}


def test_other_workflows_still_count_as_packaging() -> None:
    assert ci_changes.classify([".github/workflows/ci.yml"]) == {"app": True, "packaging": True}


def test_no_changes_found_runs_everything() -> None:
    """If the diff came back empty, something's wrong: never take that as nothing to test."""
    assert ci_changes.classify([]) == {"app": True, "packaging": True}
    assert ci_changes.classify(["", "  "]) == {"app": True, "packaging": True}


def test_a_nightly_or_release_run_tests_everything(monkeypatch, tmp_path: Path) -> None:
    output = tmp_path / "output"
    monkeypatch.setenv("GITHUB_EVENT_NAME", "workflow_call")
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.setattr(ci_changes, "changed_paths", lambda: ["PLAN.md"])
    assert ci_changes.main() == 0
    assert output.read_text("utf-8").split() == ["app=true", "packaging=true"]
