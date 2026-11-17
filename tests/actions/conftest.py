"""Shared fixtures for the action tests."""

from __future__ import annotations

import shutil
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from pdfeditor.core.session import DocumentSession

Opener = Callable[[str], DocumentSession]


@pytest.fixture
def open_copy(fixture_pdf, tmp_path: Path) -> Iterator[Opener]:
    """``open_copy("name")`` -> a session on a copy of the fixture, closed after the test."""
    sessions: list[DocumentSession] = []

    def open_copy(name: str) -> DocumentSession:
        path = tmp_path / f"{name}-{len(sessions)}.pdf"
        shutil.copy2(fixture_pdf(name), path)
        session = DocumentSession.open(path)
        sessions.append(session)
        return session

    yield open_copy
    for session in sessions:
        with session.lock:
            session.document.close()
