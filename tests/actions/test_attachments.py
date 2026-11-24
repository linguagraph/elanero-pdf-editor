"""Attachment actions (``attachments.add`` and ``attachments.remove``) on real documents (no Qt).

Saved files must open in pikepdf and render in pypdfium2 (independent implementations), not only
in MuPDF, through ``tests.hostcheck.record``. The leak test checks decoded streams, because an
embedded file is compressed and its raw bytes never show the marker.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from pdfeditor.actions import run
from pdfeditor.actions.attachments import AddAttachment, RemoveAttachment, clean_filename, free_name
from pdfeditor.actions.base import Busy, Refused, StaleObject
from pdfeditor.core.session import DocumentSession
from pdfeditor.model import platform
from tests.actions.conftest import Opener, pretend_signed
from tests.hostcheck import record

MARKER = "W79A1-LEAK-MARKER-7f3a"
# The busy check in tests/actions/test_registry.py calls each action with a task running.
BUSY_CASES = {
    "attachments.add": AddAttachment(b"x", "x.txt"),
    "attachments.remove": RemoveAttachment("notes"),
}
OpenSaved = Callable[[bytes], DocumentSession]
SetCap = Callable[[int | None], None]


@pytest.fixture
def saved_session(tmp_path: Path) -> Iterator[OpenSaved]:
    """``saved_session(data)`` -> a session on a file written from ``data``, closed afterwards."""
    sessions: list[DocumentSession] = []

    def open_it(data: bytes) -> DocumentSession:
        path = tmp_path / f"saved-{len(sessions)}.pdf"
        path.write_bytes(data)
        session = DocumentSession.open(path)
        sessions.append(session)
        return session

    yield open_it
    for session in sessions:
        with session.lock:
            session.document.close()


@pytest.fixture
def capped() -> Iterator[SetCap]:
    """Set the platform's attachment size cap for one test; the previous flags come back."""
    previous = platform.current()

    def set_cap(limit: int | None) -> None:
        platform.configure(dataclasses.replace(previous, max_attachment_bytes=limit))

    yield set_cap
    platform.configure(previous)


def _files(session: DocumentSession) -> list[tuple[str, str, int, str]]:
    with session.lock:
        return [
            (f.name, f.filename, f.size, f.description) for f in session.document.embedded_files()
        ]


def _bytes_of(session: DocumentSession, name: str) -> bytes:
    with session.lock:
        return session.document.extract_embedded_file(name)


def _saved(session: DocumentSession) -> bytes:
    return session.save_bytes("copy").data


# -- helpers: names ------------------------------------------------------------------------


def test_clean_filename_keeps_only_the_last_path_part_without_control_characters() -> None:
    assert clean_filename("C:\\Users\\me\\brief\x07.pdf") == "brief.pdf"
    assert clean_filename("/home/me/notes.txt") == "notes.txt"
    assert clean_filename("  spaced.txt  ") == "spaced.txt"
    assert clean_filename("..") == ""
    assert clean_filename("dir/") == ""
    assert clean_filename("\x00\x1f") == ""


def test_free_name_adds_a_counter_before_the_extension() -> None:
    assert free_name("notes.txt", set()) == "notes.txt"
    assert free_name("notes.txt", {"notes.txt"}) == "notes (2).txt"
    assert free_name("notes.txt", {"notes.txt", "notes (2).txt"}) == "notes (3).txt"
    assert free_name("README", {"README"}) == "README (2)"
    assert free_name(".profile", {".profile"}) == ".profile (2)"


# -- attachments.add -----------------------------------------------------------------------


def test_add_is_listed_and_saved_with_its_bytes(
    open_copy: Opener, saved_session: OpenSaved
) -> None:
    s = open_copy("attachments")
    payload = b"hello from the browser\n"
    result = run(s, "attachments.add", AddAttachment(payload, "hello.txt", "Greeting"))
    assert result.label == "Add Attachment" and result.executed
    assert result.value == "hello.txt"
    assert ("hello.txt", "hello.txt", len(payload), "Greeting") in _files(s)
    assert _bytes_of(s, "hello.txt") == payload

    saved = _saved(s)
    assert _bytes_of(saved_session(saved), "hello.txt") == payload
    record("embedded_bytes_pikepdf", saved, marker="hello from the browser", present=True)
    record("opens_pdfium", saved)
    record("render_first_page_pdfium", saved)


def test_add_takes_a_free_name_when_the_name_is_used(open_copy: Opener) -> None:
    s = open_copy("images")  # embeds "notes" (notes.txt)
    first = run(s, "attachments.add", AddAttachment(b"a", "notes.txt"))
    second = run(s, "attachments.add", AddAttachment(b"b", "notes.txt"))
    assert first.value == "notes (2).txt"
    assert second.value == "notes (3).txt"
    names = [entry[1] for entry in _files(s)]
    assert sorted(names) == ["notes (2).txt", "notes (3).txt", "notes.txt"]


def test_undo_and_redo_of_an_add(open_copy: Opener) -> None:
    s = open_copy("attachments")
    before = _files(s)
    run(s, "attachments.add", AddAttachment(b"again", "again.txt"))
    assert any(entry[0] == "again.txt" for entry in _files(s))
    assert s.undo() and _files(s) == before
    assert s.redo() and _bytes_of(s, "again.txt") == b"again"


def test_add_refusals_carry_stable_reasons(open_copy: Opener, capped: SetCap) -> None:
    s = open_copy("attachments")
    with pytest.raises(Refused) as empty:
        run(s, "attachments.add", AddAttachment(b"", "empty.txt"))
    assert empty.value.reason == "attachment_empty"

    with pytest.raises(Refused) as unnamed:
        run(s, "attachments.add", AddAttachment(b"x", "\\"))
    assert unnamed.value.reason == "attachment_name"

    capped(10)
    with pytest.raises(Refused) as big:
        run(s, "attachments.add", AddAttachment(b"x" * 11, "big.bin"))
    assert big.value.reason == "attachment_too_large"
    capped(None)

    assert [entry[0] for entry in _files(s)] == ["notes", "brief"]  # nothing was added


def test_add_on_a_signed_document_is_refused(
    open_copy: Opener, monkeypatch: pytest.MonkeyPatch
) -> None:
    s = open_copy("attachments")
    pretend_signed(s, monkeypatch)
    with pytest.raises(Refused) as refused:
        run(s, "attachments.add", AddAttachment(b"x", "x.txt"))
    assert refused.value.reason == "signed_document"
    assert not s.undo_stack.can_undo


def test_add_while_a_task_runs_is_busy(open_copy: Opener) -> None:
    s = open_copy("attachments")
    s.begin_task("OCR")
    with pytest.raises(Busy, match="OCR"):
        run(s, "attachments.add", AddAttachment(b"x", "x.txt"))
    s.end_task("OCR")
    assert not s.undo_stack.can_undo


# -- attachments.remove --------------------------------------------------------------------


def test_remove_then_undo_restores_the_same_file_specification(open_copy: Opener) -> None:
    s = open_copy("images")
    before = _files(s)
    payload = _bytes_of(s, "notes")

    result = run(s, "attachments.remove", RemoveAttachment("notes"))
    assert result.label == "Remove Attachment" and result.executed
    assert _files(s) == []

    assert s.undo()
    assert _files(s) == before  # name, file name, size and description
    assert _bytes_of(s, "notes") == payload

    assert s.redo() and _files(s) == []


def test_remove_of_a_missing_name_is_stale(open_copy: Opener) -> None:
    s = open_copy("images")
    with pytest.raises(StaleObject):
        run(s, "attachments.remove", RemoveAttachment("gone"))
    assert not s.undo_stack.can_undo


def test_remove_on_a_signed_document_is_refused(
    open_copy: Opener, monkeypatch: pytest.MonkeyPatch
) -> None:
    s = open_copy("images")
    pretend_signed(s, monkeypatch)
    with pytest.raises(Refused) as refused:
        run(s, "attachments.remove", RemoveAttachment("notes"))
    assert refused.value.reason == "signed_document"
    assert _files(s) != []


def test_removed_bytes_do_not_survive_a_full_save(
    open_copy: Opener, saved_session: OpenSaved
) -> None:
    """Leak test: a marker that was embedded, saved, removed and saved again is gone from the
    file. Its presence before the removal is the positive control, so the check can fail."""
    s = open_copy("attachments")
    run(s, "attachments.add", AddAttachment(MARKER.encode() * 40, "secret.txt"))
    with_file = _saved(s)
    record("embedded_bytes_pikepdf", with_file, marker=MARKER, present=True)

    run(s, "attachments.remove", RemoveAttachment("secret.txt"))
    without_file = _saved(s)
    record("embedded_bytes_pikepdf", without_file, marker=MARKER, present=False)
    record("opens_pdfium", without_file)
    assert all(name != "secret.txt" for name, *_ in _files(saved_session(without_file)))


def test_remove_of_a_later_attachment_keeps_the_first(
    open_copy: Opener, saved_session: OpenSaved
) -> None:
    """Index 1 of two: the pair removed must be "brief", never the first entry "notes"."""
    s = open_copy("attachments")
    notes = _bytes_of(s, "notes")
    run(s, "attachments.remove", RemoveAttachment("brief"))
    assert [entry[0] for entry in _files(s)] == ["notes"]
    saved = _saved(s)
    reopened = saved_session(saved)
    assert [entry[0] for entry in _files(reopened)] == ["notes"]
    assert _bytes_of(reopened, "notes") == notes


def test_remove_keeps_the_other_attachment_and_renders(open_copy: Opener) -> None:
    s = open_copy("attachments")
    run(s, "attachments.remove", RemoveAttachment("notes"))
    saved = _saved(s)
    record("embedded_file_name_pikepdf", saved, attachment="brief")
    record("opens_pdfium", saved)
    record("render_first_page_pdfium", saved)
