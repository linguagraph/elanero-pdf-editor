"""The web RPC and the shared actions import, and answer a call, with the desktop-only packages
blocked (the same guard as test_web_imports.py, which lists the blocked modules)."""

from __future__ import annotations

import sys

import pytest

from tests.unit.test_web_imports import _run


@pytest.mark.skipif(sys.platform == "emscripten", reason="no subprocesses in Pyodide")
def test_webapi_and_actions_import_without_qt_or_desktop_packages() -> None:
    result = _run(
        """
        import pdfeditor.webapi
        import pdfeditor.actions
        print("imported")
        """
    )
    assert result.returncode == 0, result.stderr
    assert "imported" in result.stdout


@pytest.mark.skipif(sys.platform == "emscripten", reason="no subprocesses in Pyodide")
def test_a_session_call_runs_without_qt_or_desktop_packages(fixture_pdf) -> None:
    result = _run(
        """
        import json
        from pathlib import Path

        from pdfeditor.webapi import dispatch
        from pdfeditor.webapi.platform import configure_web

        configure_web()
        data = Path(sys.argv[1]).read_bytes()
        request = json.dumps({
            "v": 1, "id": 1, "method": "session.open",
            "params": {"name": "a.pdf", "data": {"$bin": 0}, "password": None},
        })
        reply_json, _ = dispatch(request, [data])
        reply = json.loads(reply_json)
        print("ok" if reply["ok"] else reply["error"]["code"])
        """,
        str(fixture_pdf("text_multipage")),
    )
    assert result.returncode == 0, result.stderr
    assert "ok" in result.stdout.split()
