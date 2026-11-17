"""Smoke test for the Pyodide run (web/test/pyodide/run_tests.mjs).

It has no desktop_only marker, so the web run collects it. It checks only that pytest runs in
Pyodide at all: if this module is missing or fails there, the runner itself is broken.
"""

from __future__ import annotations


def test_pyodide_run_collects_and_runs() -> None:
    assert 1 + 1 == 2
