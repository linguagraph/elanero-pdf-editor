"""Shared fixtures for the action tests."""

from __future__ import annotations

import dataclasses
import shutil
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from pdfeditor.core.session import DocumentSession

Opener = Callable[[str], DocumentSession]


def pretend_signed(session: DocumentSession, monkeypatch: pytest.MonkeyPatch) -> None:
    """Make the open document look signed and incrementally savable, so an in-place save takes
    the incremental path unless the session forces a full rewrite. Everything else stays real."""
    doc = session.document
    real_info = doc.info
    monkeypatch.setattr(doc, "info", lambda: dataclasses.replace(real_info(), has_signatures=True))
    monkeypatch.setattr(doc, "can_save_incrementally", lambda: True)


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
