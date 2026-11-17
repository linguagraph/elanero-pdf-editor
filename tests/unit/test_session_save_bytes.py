"""DocumentSession.save_bytes: the bytes a web caller writes, and what it leaves untouched."""

from __future__ import annotations

import io
import re
import shutil
from collections.abc import Callable
from pathlib import Path

import pikepdf
import pypdfium2 as pdfium
import pytest

from pdfeditor.core.commands.document_cmds import SetMetadataCommand
from pdfeditor.core.session import DocumentSession, EventKind, SessionEvent
from pdfeditor.engine.base import SaveError
from pdfeditor.model.metadata import Metadata

SIGNED = Path(__file__).parent.parent / "fixtures" / "real" / "signed_selfsigned.pdf"
ONCE_MESSAGE = "can't be saved in place"


def _roundtrip(data: bytes, pages: int) -> None:
    """Saved bytes must open in pikepdf and render in pypdfium2 (AGENTS round trip)."""
    with pikepdf.open(io.BytesIO(data)) as pdf:
        assert len(pdf.pages) == pages
    doc = pdfium.PdfDocument(data)
    try:
        assert doc[0].render(scale=0.5).width > 0
    finally:
        doc.close()


def _byte_range(data: bytes) -> bytes:
    match = re.search(rb"/ByteRange\s*\[[^\]]*\]", data)
    assert match is not None
    return match.group(0)


def _signed_copy(tmp_path: Path) -> Path:
    """A throwaway copy of the signed sample: the sample itself is never saved over."""
    path = tmp_path / "signed.pdf"
    shutil.copyfile(SIGNED, path)
    return path


def _edit(session: DocumentSession, title: str) -> None:
    assert session.execute(SetMetadataCommand(Metadata(title=title)))


def test_copy_is_a_full_rewrite_of_an_unsigned_document(fixture_pdf: Callable[[str], Path]) -> None:
    session = DocumentSession.open(fixture_pdf("text_multipage"))
    pages = session.page_count
    result = session.save_bytes("copy")
    assert result.incremental is False
    _roundtrip(result.data, pages)


def test_in_place_on_unsigned_document_is_a_full_write(fixture_pdf: Callable[[str], Path]) -> None:
    session = DocumentSession.open(fixture_pdf("text_multipage"))
    result = session.save_bytes("in_place")
    assert result.incremental is False
    _roundtrip(result.data, session.page_count)


def test_in_place_on_signed_document_keeps_the_signature(tmp_path: Path) -> None:
    original = SIGNED.read_bytes()
    session = DocumentSession.open(_signed_copy(tmp_path))
    _edit(session, "changed")
    result = session.save_bytes("in_place")
    assert result.incremental is True
    assert result.data.startswith(original)
    assert _byte_range(result.data) == _byte_range(original)
    _roundtrip(result.data, 1)


def test_in_place_save_leaves_the_session_state_alone(tmp_path: Path) -> None:
    session = DocumentSession.open(_signed_copy(tmp_path))
    _edit(session, "changed")
    events: list[SessionEvent] = []
    session.subscribe(events.append)
    stamp = session._file_stamp
    dirty = session.is_dirty
    session.save_bytes("in_place")
    assert session.is_dirty == dirty
    assert session._file_stamp == stamp
    assert session.require_full_save is False
    assert all(event.kind is not EventKind.SAVED for event in events)


def test_full_save_required_forces_a_rewrite_of_a_signed_document(tmp_path: Path) -> None:
    session = DocumentSession.open(_signed_copy(tmp_path))
    session.require_full_save = True
    result = session.save_bytes("in_place")
    assert result.incremental is False
    _roundtrip(result.data, 1)


def test_copy_of_a_signed_document_is_a_full_rewrite(tmp_path: Path) -> None:
    session = DocumentSession.open(_signed_copy(tmp_path))
    result = session.save_bytes("copy")
    assert result.incremental is False


def test_second_in_place_save_after_an_edit_raises(tmp_path: Path) -> None:
    session = DocumentSession.open(_signed_copy(tmp_path))
    _edit(session, "one")
    session.save_bytes("in_place")
    _edit(session, "two")
    with pytest.raises(SaveError, match="once after it changes"):
        session.save_bytes("in_place")


def test_undo_after_an_in_place_save_refuses_another_in_place_save(tmp_path: Path) -> None:
    session = DocumentSession.open(_signed_copy(tmp_path))
    _edit(session, "edited")
    session.save_bytes("in_place")
    assert session.undo()
    with pytest.raises(SaveError, match="once after it changes"):
        session.save_bytes("in_place")


def test_in_place_save_refuses_a_file_changed_on_disk(tmp_path: Path) -> None:
    path = _signed_copy(tmp_path)
    session = DocumentSession.open(path)
    path.write_bytes(path.read_bytes() + b"\n")
    with pytest.raises(SaveError, match="changed on disk"):
        session.save_bytes("in_place")


def test_failed_verification_raises_and_changes_no_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    session = DocumentSession.open(_signed_copy(tmp_path))
    _edit(session, "changed")
    clean = session.undo_stack.is_clean
    stamp = session._file_stamp
    full = session.require_full_save

    def fail(*_args: object, **_kwargs: object) -> None:
        raise OSError("reopen failed")

    monkeypatch.setattr(session.engine, "open", fail)
    with pytest.raises(SaveError, match="cannot be reopened"):
        session.save_bytes("in_place")
    assert session.undo_stack.is_clean == clean
    assert session._file_stamp == stamp
    assert session.require_full_save == full


def test_busy_document_refuses_to_save_bytes(fixture_pdf: Callable[[str], Path]) -> None:
    session = DocumentSession.open(fixture_pdf("text_multipage"))
    session.begin_task("OCR")
    with pytest.raises(SaveError, match="OCR"):
        session.save_bytes("copy")


def test_unknown_mode_is_rejected(fixture_pdf: Callable[[str], Path]) -> None:
    session = DocumentSession.open(fixture_pdf("text_multipage"))
    with pytest.raises(ValueError, match="unknown save mode"):
        session.save_bytes("sideways")  # type: ignore[arg-type]


def test_save_to_file_still_sets_clean_and_emits_saved(tmp_path: Path) -> None:
    session = DocumentSession.open(_signed_copy(tmp_path))
    _edit(session, "to file")
    assert session.is_dirty
    events: list[SessionEvent] = []
    session.subscribe(events.append)
    target = tmp_path / "out.pdf"
    session.save(target)
    assert session.is_dirty is False
    assert any(event.kind is EventKind.SAVED for event in events)
    _roundtrip(target.read_bytes(), 1)
