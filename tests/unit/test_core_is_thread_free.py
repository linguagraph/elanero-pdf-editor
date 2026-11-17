"""The job core must stay free of threads and Qt: the web runs it under Pyodide, which has none.

Checked statically, so a stray import fails here even on a machine that never runs the web build.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
CORE = ROOT / "src" / "pdfeditor" / "core"
THREAD_FREE = ["jobs.py", "inline_jobs.py", "render_cache.py"]
FORBIDDEN_NAMES = {
    "Thread",
    "Timer",
    "ThreadPoolExecutor",
    "ProcessPoolExecutor",
    "QThread",
    "QThreadPool",
    "start_new_thread",
}
FORBIDDEN_IMPORTS = {"concurrent", "multiprocessing", "PySide6", "shiboken6"}


def _tree(name: str) -> ast.Module:
    return ast.parse((CORE / name).read_text(encoding="utf-8"), filename=name)


def _imported_roots(tree: ast.Module) -> set[str]:
    roots: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            roots.add(node.module.split(".")[0])
    return roots


@pytest.mark.parametrize("name", THREAD_FREE)
def test_no_thread_or_executor_names(name: str) -> None:
    offending: list[str] = []
    for node in ast.walk(_tree(name)):
        if isinstance(node, ast.Name) and node.id in FORBIDDEN_NAMES:
            offending.append(f"{name}:{node.lineno} {node.id}")
        elif isinstance(node, ast.Attribute) and node.attr in FORBIDDEN_NAMES:
            offending.append(f"{name}:{node.lineno} .{node.attr}")
    assert offending == []


@pytest.mark.parametrize("name", THREAD_FREE)
def test_no_concurrency_or_qt_imports(name: str) -> None:
    assert _imported_roots(_tree(name)) & FORBIDDEN_IMPORTS == set()


def test_inline_jobs_imports_only_stdlib_and_core_or_model() -> None:
    offending: list[str] = []
    for node in ast.walk(_tree("inline_jobs.py")):
        if isinstance(node, ast.Import):
            modules = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            modules = [node.module]
        else:
            continue
        for module in modules:
            root = module.split(".")[0]
            if root == "pdfeditor":
                if not module.startswith(("pdfeditor.core", "pdfeditor.model")):
                    offending.append(module)
            elif root not in sys.stdlib_module_names:
                offending.append(module)
    assert offending == []
