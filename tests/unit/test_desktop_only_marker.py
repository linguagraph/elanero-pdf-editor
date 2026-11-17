"""Guard for the ``desktop_only`` marker: the Pyodide run must never collect a Qt or desktop test.

The web test run (``web/test/pyodide``) deselects ``desktop_only`` tests, because Qt and the
desktop packaging do not exist in Pyodide. This file checks the marking by reading the source with
``ast``, so it imports no test module (which would import Qt). It runs in both runs.
"""

from __future__ import annotations

import ast
import tomllib
from collections.abc import Mapping
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
MARKER = "desktop_only"
QT_TOP_LEVEL = {"PySide6", "pytestqt", "pytest_qt"}
QT_FIXTURES = {"qtbot", "qapp"}
# Directories whose test modules are desktop-only by location, whatever they import.
DESKTOP_DIRS = ("tests/ui", "tests/benchmarks")
# Modules exempt from the Qt rule (a module that imports Qt but may run without the marker).
# Empty by default: adding an entry needs a reason next to it.
ALLOW: dict[str, str] = {}


def has_marker(tree: ast.Module) -> bool:
    """True when a module-level ``pytestmark`` names the marker (alone or in a list)."""
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if not any(isinstance(t, ast.Name) and t.id == "pytestmark" for t in node.targets):
            continue
        if any(isinstance(n, ast.Attribute) and n.attr == MARKER for n in ast.walk(node.value)):
            return True
    return False


def needs_qt(tree: ast.Module) -> bool:
    """True when the module imports Qt (any alias) or takes the qtbot or qapp fixture."""
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            if any(alias.name.split(".")[0] in QT_TOP_LEVEL for alias in node.names):
                return True
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0 and node.module and node.module.split(".")[0] in QT_TOP_LEVEL:
                return True
        elif isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            args = [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]
            if any(arg.arg in QT_FIXTURES for arg in args):
                return True
    return False


def check_tree(root: Path, allow: Mapping[str, str] = ALLOW) -> list[str]:
    """Return one problem per test module under ``root/tests`` that is marked wrongly.

    Two rules: a module under a desktop directory must be marked, and a module that needs Qt must
    be marked unless it is in ``allow``. Paths are relative to ``root`` with forward slashes.
    """
    problems: list[str] = []
    for path in sorted((root / "tests").rglob("*.py")):
        if "fixtures" in path.parts or path.name in {"__init__.py", "conftest.py"}:
            continue
        rel = path.relative_to(root).as_posix()
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=rel)
        marked = has_marker(tree)
        if any(rel.startswith(d + "/") for d in DESKTOP_DIRS) and not marked:
            problems.append(f"{rel}: under a desktop directory but not marked {MARKER}")
        if needs_qt(tree) and not marked and rel not in allow:
            problems.append(f"{rel}: imports Qt or uses qtbot/qapp but is not marked {MARKER}")
    return problems


def test_repo_marking_is_complete() -> None:
    assert check_tree(ROOT) == []


def test_marker_is_registered_in_pyproject() -> None:
    with (ROOT / "pyproject.toml").open("rb") as handle:
        markers = tomllib.load(handle)["tool"]["pytest"]["ini_options"]["markers"]
    assert any(line.startswith(f"{MARKER}:") for line in markers)


def test_checker_reports_unmarked_qt_module(tmp_path: Path) -> None:
    """Negative control: the real checker must flag a Qt module that lacks the marker."""
    probe = tmp_path / "tests" / "unit" / "test_probe_qt.py"
    probe.parent.mkdir(parents=True)
    probe.write_text("import PySide6\n\ndef test_x() -> None:\n    pass\n", encoding="utf-8")
    problems = check_tree(tmp_path)
    assert problems == [
        "tests/unit/test_probe_qt.py: imports Qt or uses qtbot/qapp but is not marked desktop_only"
    ]


def test_checker_accepts_marked_qt_module_and_flags_fixture_use(tmp_path: Path) -> None:
    """Positive control: a marked module passes, and a qtbot signature alone counts as Qt."""
    marked = tmp_path / "tests" / "unit" / "test_probe_marked.py"
    marked.parent.mkdir(parents=True)
    marked.write_text(
        "import pytest\n"
        "pytestmark = [pytest.mark.gui, pytest.mark.desktop_only]\n"
        "from PySide6.QtCore import Qt\n",
        encoding="utf-8",
    )
    fixture_user = tmp_path / "tests" / "unit" / "test_probe_fixture.py"
    fixture_user.write_text("def test_y(qtbot) -> None:\n    pass\n", encoding="utf-8")
    assert check_tree(tmp_path) == [
        "tests/unit/test_probe_fixture.py: imports Qt or uses qtbot/qapp but is not marked "
        "desktop_only"
    ]


@pytest.mark.parametrize("directory", DESKTOP_DIRS)
def test_checker_flags_unmarked_desktop_directory(tmp_path: Path, directory: str) -> None:
    module = tmp_path / directory / "test_probe_plain.py"
    module.parent.mkdir(parents=True)
    module.write_text("def test_z() -> None:\n    pass\n", encoding="utf-8")
    assert check_tree(tmp_path) == [
        f"{directory}/test_probe_plain.py: under a desktop directory but not marked desktop_only"
    ]
