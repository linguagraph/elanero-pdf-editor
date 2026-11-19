"""DocumentSession.save_bytes: the bytes a web caller writes, and what it leaves untouched."""

from __future__ import annotations

import re
import shutil
from collections.abc import Callable
from pathlib import Path

import pytest

from pdfeditor.core.commands import SetSecurityCommand
from pdfeditor.core.commands.document_cmds import SetMetadataCommand
from pdfeditor.core.session import DocumentSession, EventKind, SessionEvent
from pdfeditor.engine.base import PasswordRequired, SaveError
from pdfeditor.model.metadata import EncryptionMethod, Metadata, Permissions, SecuritySettings
from tests.hostcheck import record

SIGNED = Path(__file__).parent.parent / "fixtures" / "real" / "signed_selfsigned.pdf"
ONCE_MESSAGE = "can't be saved in place"


def _roundtrip(data: bytes, pages: int) -> None:
    """Saved bytes must open in pikepdf and render in pypdfium2 (AGENTS round trip)."""
    record("page_count_pikepdf", data, pages=pages)
    record("render_width_pdfium", data, scale=0.5)


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


def test_copy_names_unnamed_annotations_as_save_does(fixture_pdf: Callable[[str], Path]) -> None:
    session = DocumentSession.open(fixture_pdf("annotations_unnamed"))
    result = session.save_bytes("copy")
    # Links and popups are never named: the engine doesn't list them as annotations.
    record("annot_names_pikepdf", result.data, prefix="pdfeditor-")
    session.close()


def test_repaired_output_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    session = DocumentSession.open(_signed_copy(tmp_path))
    real_open = session.engine.open

    class Repaired:
        page_count = 1
        is_repaired = True

        def close(self) -> None:
            pass

    def open_repaired(source: object, password: object = None) -> object:
        real_open(source)  # the bytes are real; only the verdict is faked
        return Repaired()

    monkeypatch.setattr(session.engine, "open", open_repaired)
    with pytest.raises(SaveError, match="needed repair"):
        session.save_bytes("copy")
    session.close()


def test_same_state_repeated_in_place_save_returns_equal_bytes(tmp_path: Path) -> None:
    session = DocumentSession.open(_signed_copy(tmp_path))
    _edit(session, "repeat")
    first = session.save_bytes("in_place")
    second = session.save_bytes("in_place")
    assert first.incremental is True
    assert second.data == first.data
    session.close()


def test_copy_of_an_unchanged_signed_document_does_not_spend_the_in_place_save(
    tmp_path: Path,
) -> None:
    session = DocumentSession.open(_signed_copy(tmp_path))
    first = session.save_bytes("in_place")
    session.save_bytes("copy")
    assert session.save_bytes("in_place").data == first.data
    session.close()


def test_copy_after_a_real_edit_still_refuses_the_next_in_place_save(tmp_path: Path) -> None:
    session = DocumentSession.open(_signed_copy(tmp_path))
    _edit(session, "one")
    session.save_bytes("in_place")
    _edit(session, "two")
    session.save_bytes("copy")
    with pytest.raises(SaveError, match="once after it changes"):
        session.save_bytes("in_place")
    session.close()


# -- password protection (W7.5 S1) ---------------------------------------------------------


def _encrypt_settings() -> SecuritySettings:
    return SecuritySettings(EncryptionMethod.AES_256, "open me", "boss", Permissions(copy=False))


def test_save_bytes_after_security_set_verifies_with_the_new_password(
    fixture_pdf: Callable[[str], Path], tmp_path: Path
) -> None:
    """The web caller passes the open password it holds; the bytes open only with the new one,
    so the check must use the pending password, not the caller's (W7.5 section 2, item 2)."""
    session = DocumentSession.open(fixture_pdf("report"))
    pages = session.page_count
    assert session.execute(SetSecurityCommand(_encrypt_settings()))

    result = session.save_bytes("copy", password=None)
    out = tmp_path / "locked.pdf"
    out.write_bytes(result.data)
    with pytest.raises(PasswordRequired):
        DocumentSession.open(out)
    opened = DocumentSession.open(out, "open me")
    assert opened.page_count == pages
    opened.close()
    record("encrypted_pages_pikepdf", result.data, pages=pages, password="open me")
    record("page_count_pdfium", result.data, pages=pages, password="open me")
    session.close()


def test_save_bytes_after_security_remove_gives_bytes_that_open_without_a_password(
    fixture_pdf: Callable[[str], Path],
) -> None:
    session = DocumentSession.open(fixture_pdf("encrypted"), "user")
    pages = session.page_count
    assert session.execute(SetSecurityCommand(SecuritySettings(EncryptionMethod.NONE)))

    result = session.save_bytes("copy", password="user")
    record("page_count_pikepdf", result.data, pages=pages)
    record("page_count_pdfium", result.data, pages=pages)
    session.close()
