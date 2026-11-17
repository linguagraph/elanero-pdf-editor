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
# The only names the core may take from threading: a Lock and an Event, never a thread.
ALLOWED_THREADING_NAMES = {"Event", "Lock"}


def _violations(source: str, name: str) -> list[str]:
    """Return every forbidden use in ``source``, checked on the AST so aliases can't hide it."""
    tree = ast.parse(source, filename=name)
    found: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id in FORBIDDEN_NAMES:
            found.append(f"{name}:{node.lineno} {node.id}")
        elif isinstance(node, ast.Attribute) and node.attr in FORBIDDEN_NAMES:
            found.append(f"{name}:{node.lineno} .{node.attr}")
        elif isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if root in FORBIDDEN_IMPORTS:
                    found.append(f"{name}:{node.lineno} import {alias.name}")
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            root = node.module.split(".")[0]
            if root in FORBIDDEN_IMPORTS:
                found.append(f"{name}:{node.lineno} from {node.module}")
            if node.module == "threading":
                for alias in node.names:
                    if alias.name not in ALLOWED_THREADING_NAMES or alias.asname is not None:
                        found.append(f"{name}:{node.lineno} from threading import {alias.name}")
    return found


@pytest.mark.parametrize("name", THREAD_FREE)
def test_core_job_files_are_thread_free(name: str) -> None:
    source = (CORE / name).read_text(encoding="utf-8")
    assert _violations(source, name) == []


@pytest.mark.parametrize(
    "extra",
    [
        "from threading import Thread as T\n",
        "from threading import Timer\n",
        "import threading as t\nx = t.Thread\n",
        "import concurrent.futures\n",
        "import multiprocessing\n",
        "from PySide6.QtCore import QThread\n",
        "from threading import Event, Lock, Thread\n",
        "x = threading.Thread()\n",
    ],
)
def test_checker_catches_injected_violations(extra: str) -> None:
    """Guards the guard: a copy of a real file with one forbidden line must fail."""
    source = (CORE / "jobs.py").read_text(encoding="utf-8") + "\n" + extra
    assert _violations(source, "jobs.py") != []


def test_inline_jobs_imports_only_stdlib_and_core_or_model() -> None:
    source = (CORE / "inline_jobs.py").read_text(encoding="utf-8")
    offending: list[str] = []
    for node in ast.walk(ast.parse(source)):
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
