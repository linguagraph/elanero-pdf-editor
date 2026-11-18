"""Security actions and ``document.sanitize`` on real documents (no Qt).

Saved files must open in pikepdf and render in pypdfium2 (independent implementations), not only
in MuPDF.
"""

from __future__ import annotations

import shutil
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from pdfeditor.actions import run
from pdfeditor.actions.base import Busy, Refused
from pdfeditor.actions.security import RemoveSecurity, SanitizeDocument, SetSecurity
from pdfeditor.core.session import DocumentSession
from pdfeditor.engine.base import SaveError
from pdfeditor.model.metadata import EncryptionMethod, Permissions, SecuritySettings
from pdfeditor.model.redaction import SanitizeOptions
from tests.actions.conftest import Opener, pretend_signed
from tests.hostcheck import record

BUSY_CASES = {
    "security.set": SetSecurity(SecuritySettings()),
    "security.remove": RemoveSecurity(),
    "document.sanitize": SanitizeDocument(),
}

OWNER_MESSAGE = "The permissions password is needed"
RESTRICTED = Permissions(print=False, copy=False)


OpenEncrypted = Callable[[str], DocumentSession]


@pytest.fixture
def open_encrypted(fixture_pdf, tmp_path: Path) -> Iterator[OpenEncrypted]:
    """``open_encrypted("user")`` -> a session on a copy of the ``encrypted`` fixture (user
    password "user", owner password "owner"), closed after the test."""
    sessions: list[DocumentSession] = []

    def open_it(password: str) -> DocumentSession:
        path = tmp_path / f"encrypted-{len(sessions)}.pdf"
        shutil.copy2(fixture_pdf("encrypted"), path)
        session = DocumentSession.open(path, password)
        sessions.append(session)
        return session

    yield open_it
    for session in sessions:
        with session.lock:
            session.document.close()


def _pending(session: DocumentSession) -> SecuritySettings | None:
    with session.lock:
        return session.document.pending_security()


def _title(session: DocumentSession) -> str:
    with session.lock:
        return session.document.metadata().title


# -- document.sanitize ---------------------------------------------------------------------


def test_sanitize_reports_what_the_engine_removed(open_copy: Opener) -> None:
    s = open_copy("sensitive")
    direct = open_copy("sensitive")
    with direct.lock:
        expected = direct.document.sanitize(SanitizeOptions())

    result = run(s, "document.sanitize", SanitizeDocument())
    assert result.label == "Sanitize Document" and result.executed
    assert result.value == tuple(expected) and result.value
    assert s.require_full_save

    s.undo()
    assert _title(s) == "Confidential report"


def test_sanitized_file_is_clean_in_every_reader(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("sensitive")
    run(s, "document.sanitize", SanitizeDocument())
    with s.lock:
        assert not s.document.info().has_javascript
    out = s.save(tmp_path / "clean.pdf")

    record("docinfo_lacks_key_pikepdf", out, key="/Title")
    assert b"app.alert" not in out.read_bytes()
    record("render_size_pdfium", out, page=0, scale=1)


# -- security.set --------------------------------------------------------------------------


def test_set_security_queues_encryption_until_save(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("report")
    settings = SecuritySettings(EncryptionMethod.AES_256, "open me", "boss", RESTRICTED)
    result = run(s, "security.set", SetSecurity(settings))

    assert result.label == "Encrypt with Password" and result.value is None
    assert _pending(s) == settings
    s.undo()
    assert _pending(s) is None

    run(s, "security.set", SetSecurity(settings))
    out = s.save(tmp_path / "locked.pdf")
    assert _pending(s) is None
    record("encrypted_pages_pikepdf", out, pages=2, password="open me")
    record("page_count_pdfium", out, pages=2, password="open me")


def test_set_security_needs_the_owner_password(open_encrypted: OpenEncrypted) -> None:
    s = open_encrypted("user")
    settings = SecuritySettings(EncryptionMethod.AES_256, "", "", RESTRICTED)
    with pytest.raises(Refused, match=OWNER_MESSAGE):
        run(s, "security.set", SetSecurity(settings))
    assert _pending(s) is None and not s.undo_stack.can_undo


# -- security.remove -----------------------------------------------------------------------


def test_remove_security_needs_the_owner_password(
    open_encrypted: OpenEncrypted, tmp_path: Path
) -> None:
    s = open_encrypted("user")
    with pytest.raises(Refused, match=OWNER_MESSAGE):
        run(s, "security.remove", RemoveSecurity())

    with s.lock:
        assert s.document.unlock_owner("owner")
    result = run(s, "security.remove", RemoveSecurity())
    assert result.label == "Remove Security"

    out = s.save(tmp_path / "open.pdf")
    record("not_encrypted_pikepdf", out)  # opens without any password now
    record("text_contains_pdfium", out, page=0, text="Secret content")


def test_remove_security_on_a_plain_document_is_refused(open_copy: Opener) -> None:
    s = open_copy("report")
    with pytest.raises(Refused, match=r"This document has no security\."):
        run(s, "security.remove", RemoveSecurity())
    assert not s.undo_stack.can_undo


def test_remove_drops_a_pending_encryption_and_undo_brings_it_back(open_copy: Opener) -> None:
    s = open_copy("report")
    settings = SecuritySettings(EncryptionMethod.AES_256, "open me", "boss", RESTRICTED)
    run(s, "security.set", SetSecurity(settings))

    result = run(s, "security.remove", RemoveSecurity())
    assert result.label == "Remove Security"
    pending = _pending(s)
    assert pending is not None and pending.method is EncryptionMethod.NONE

    s.undo()
    assert _pending(s) == settings


def test_in_place_sanitize_then_save_drops_the_title_from_the_bytes(
    open_copy: Opener, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Same in-place setup as the redaction leak test, for sanitizing: the flag (set by sanitize)
    forces a full rewrite, and the saved file has one revision and no title in its bytes."""
    title = b"Confidential report"

    s = open_copy("sensitive")
    run(s, "document.sanitize", SanitizeDocument())
    pretend_signed(s, monkeypatch)
    s.save()
    data = s.path.read_bytes()
    assert data.count(b"%%EOF") == 1
    assert title not in data

    # Control: without the flag the engine refuses the incremental save after sanitizing, and the
    # file is left alone (see the redaction test for the same point).
    control = open_copy("sensitive")
    run(control, "document.sanitize", SanitizeDocument())
    pretend_signed(control, monkeypatch)
    before = control.path.read_bytes()
    control.require_full_save = False
    with pytest.raises(SaveError):
        control.save()
    assert control.path.read_bytes() == before


def test_security_set_that_loses_a_race_with_a_task_raises_busy(
    open_copy: Opener, monkeypatch: pytest.MonkeyPatch
) -> None:
    s = open_copy("report")
    real_execute = s.execute

    def task_starts_first(command) -> None:
        s.begin_task("OCR")
        real_execute(command)

    monkeypatch.setattr(s, "execute", task_starts_first)
    settings = SecuritySettings(EncryptionMethod.AES_256, "open me", "boss", RESTRICTED)
    with pytest.raises(Busy, match="OCR"):
        run(s, "security.set", SetSecurity(settings))
    s.end_task("OCR")
    assert _pending(s) is None and not s.undo_stack.can_undo


def test_security_remove_that_loses_a_race_with_a_task_raises_busy(
    open_copy: Opener, monkeypatch: pytest.MonkeyPatch
) -> None:
    s = open_copy("report")
    settings = SecuritySettings(EncryptionMethod.AES_256, "open me", "boss", RESTRICTED)
    run(s, "security.set", SetSecurity(settings))
    real_execute = s.execute

    def task_starts_first(command) -> None:
        s.begin_task("OCR")
        real_execute(command)

    monkeypatch.setattr(s, "execute", task_starts_first)
    with pytest.raises(Busy, match="OCR"):
        run(s, "security.remove", RemoveSecurity())
    s.end_task("OCR")
    assert _pending(s) == settings  # the pending encryption was not touched
