"""The engine and the optimizer import with the web build's excluded modules missing (W0.4
must-fix 1 and 2). Each check runs in a subprocess whose import hook refuses those modules, so
a stray module-level import shows up as a failure here, not in the browser."""

from __future__ import annotations

import subprocess
import sys
import textwrap

import pytest

GUARD = """
import sys

BLOCKED = ({blocked})


class _Block:
    def find_spec(self, name, path=None, target=None):
        if any(name == b or name.startswith(b + ".") for b in BLOCKED):
            raise ImportError("blocked for the web build: " + name)
        return None


sys.meta_path.insert(0, _Block())
"""

BLOCKED = (
    "pdfeditor.engine.mupdf.ocr_worker",
    "pdfeditor.services.ocr",
    "pdfeditor.services.pdfa",
    "pikepdf",
    "PySide6",
    "shiboken6",
    "pyhanko",
    "pkcs11",
    "numpy",
)


def _run(body: str, *args: str) -> subprocess.CompletedProcess[str]:
    code = GUARD.format(blocked=", ".join(repr(b) for b in BLOCKED)) + textwrap.dedent(body)
    return subprocess.run(
        [sys.executable, "-c", code, *args],
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
    )


@pytest.mark.skipif(sys.platform == "emscripten", reason="no subprocesses in Pyodide")
def test_engine_imports_without_ocr_helper_or_pikepdf() -> None:
    result = _run(
        """
        import pdfeditor.engine.mupdf
        import pdfeditor.engine.mupdf.page
        print("imported")
        """
    )
    assert result.returncode == 0, result.stderr
    assert "imported" in result.stdout


@pytest.mark.skipif(sys.platform == "emscripten", reason="no subprocesses in Pyodide")
def test_ocr_fails_loudly_when_helper_is_missing(fixture_pdf) -> None:
    result = _run(
        """
        from pathlib import Path
        from pdfeditor.engine.registry import get_engine

        doc = get_engine().open(Path(sys.argv[1]))
        try:
            doc.page(0).ocr_text_layer("eng", 72, Path("missing"))
        except ImportError as exc:
            print("ImportError:", exc)
        else:
            print("no error")
        """,
        str(fixture_pdf("text_multipage")),
    )
    assert result.returncode == 0, result.stderr
    assert "ImportError" in result.stdout and "ocr_worker" in result.stdout


@pytest.mark.skipif(sys.platform == "emscripten", reason="no subprocesses in Pyodide")
def test_optimize_runs_without_pikepdf(fixture_pdf) -> None:
    result = _run(
        """
        from dataclasses import replace
        from pathlib import Path

        from pdfeditor.engine.registry import get_engine
        from pdfeditor.model.platform import configure, current
        from pdfeditor.services import optimize

        configure(replace(current(), linearize=False))
        doc = get_engine().open(Path(sys.argv[1]))
        result = optimize.reduce_size(doc, optimize.ReduceOptions(linearize=True))
        print("valid" if result.data.startswith(b"%PDF") else "invalid")
        print("notes:", " | ".join(result.notes))
        try:
            optimize.linearize(result.data)
        except ImportError:
            print("linearize blocked")
        """,
        str(fixture_pdf("text_multipage")),
    )
    assert result.returncode == 0, result.stderr
    assert "valid" in result.stdout
    assert "isn't available on this platform" in result.stdout
    assert "linearize blocked" in result.stdout
