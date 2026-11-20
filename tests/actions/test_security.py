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


def test_sanitize_keeps_the_form_field_and_resets_its_value(
    open_copy: Opener, tmp_path: Path
) -> None:
    s = open_copy("annotations_form")
    run(s, "document.sanitize", SanitizeDocument())
    out = s.save(tmp_path / "form.pdf")

    record("form_fields_pikepdf", out, fields={"Name1": ""})
    record("render_size_pdfium", out, page=0, scale=1)


def test_sanitize_without_form_data_keeps_the_field_value(
    open_copy: Opener, tmp_path: Path
) -> None:
    s = open_copy("annotations_form")
    run(s, "document.sanitize", SanitizeDocument(SanitizeOptions(form_data=False)))
    out = s.save(tmp_path / "form.pdf")

    record("form_fields_pikepdf", out, fields={"Name1": "Ada"})


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


# -- W7.5 S1: signed documents, repr, snapshots --------------------------------------------

SIGNED_MESSAGE = (
    r"This document is signed\. Changing its security would invalidate the signatures\."
)
SANITIZE_MESSAGE = r"This document is signed\. Sanitizing it would invalidate the signatures\."


def test_set_security_on_a_signed_document_is_refused(
    open_copy: Opener, monkeypatch: pytest.MonkeyPatch
) -> None:
    s = open_copy("report")
    pretend_signed(s, monkeypatch)
    settings = SecuritySettings(EncryptionMethod.AES_256, "open me", "boss", RESTRICTED)
    with pytest.raises(Refused, match=SIGNED_MESSAGE):
        run(s, "security.set", SetSecurity(settings))
    assert _pending(s) is None


def test_remove_security_on_a_signed_document_is_refused(
    open_encrypted: OpenEncrypted, monkeypatch: pytest.MonkeyPatch
) -> None:
    s = open_encrypted("owner")
    pretend_signed(s, monkeypatch)
    with pytest.raises(Refused, match=SIGNED_MESSAGE):
        run(s, "security.remove", RemoveSecurity())
    assert _pending(s) is None


def test_sanitize_on_a_signed_document_is_refused_before_any_rewrite(
    open_copy: Opener, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A sanitize is a full rewrite, which would break the signatures: refused before the snapshot,
    # so no undo step is recorded and the full-save flag is not set.
    s = open_copy("report")
    pretend_signed(s, monkeypatch)
    with pytest.raises(Refused, match=SANITIZE_MESSAGE) as refused:
        run(s, "document.sanitize", SanitizeDocument())
    assert refused.value.reason == "signed_document"
    assert s.undo_stack.can_undo is False
    assert s.require_full_save is False


def test_security_settings_repr_hides_both_passwords() -> None:
    settings = SecuritySettings(EncryptionMethod.AES_256, "open-secret", "owner-secret")
    text = repr(settings)
    assert "open-secret" not in text
    assert "owner-secret" not in text


def test_pending_security_survives_a_snapshot_action_undo_and_redo(
    open_copy: Opener, tmp_path: Path
) -> None:
    """A snapshot action after security.set must not encrypt its undo bytes with the pending
    password: undo would then load bytes that the open document can't authenticate."""
    s = open_copy("sensitive")
    settings = SecuritySettings(EncryptionMethod.AES_256, "open me", "boss", RESTRICTED)
    run(s, "security.set", SetSecurity(settings))
    run(s, "document.sanitize", SanitizeDocument())

    s.undo()
    assert _title(s) == "Confidential report"
    assert _pending(s) == settings
    s.redo()
    assert _pending(s) == settings

    pages = s.page_count
    out = s.save(tmp_path / "locked.pdf")
    record("encrypted_pages_pikepdf", out, pages=pages, password="open me")
    record("page_count_pdfium", out, pages=pages, password="open me")


# -- W7.5 S2: refusal reasons and settings validation --------------------------------------


def test_refusals_carry_a_stable_reason_and_keep_their_english_message(
    open_encrypted: OpenEncrypted, open_copy: Opener, monkeypatch: pytest.MonkeyPatch
) -> None:
    owner = open_encrypted("user")
    with pytest.raises(Refused) as needed:
        run(owner, "security.set", SetSecurity(SecuritySettings(EncryptionMethod.AES_256, "", "")))
    assert needed.value.reason == "owner_password_needed"
    assert str(needed.value) == OWNER_MESSAGE + " to change this document's security."

    plain = open_copy("report")
    with pytest.raises(Refused, match=r"This document has no security\.") as none:
        run(plain, "security.remove", RemoveSecurity())
    assert none.value.reason == "no_security"

    pretend_signed(plain, monkeypatch)
    with pytest.raises(Refused, match=SIGNED_MESSAGE) as signed:
        run(plain, "security.remove", RemoveSecurity())
    assert signed.value.reason == "signed_document"


@pytest.mark.parametrize(
    ("method", "user", "owner", "message"),
    [
        (EncryptionMethod.RC4_128, "open", "boss", r"Only AES-256 and AES-128"),
        (EncryptionMethod.UNKNOWN, "open", "boss", r"Only AES-256 and AES-128"),
        (EncryptionMethod.AES_256, "", "", r"Enter a password to open"),
        (EncryptionMethod.AES_256, "same", "same", r"must differ from the open password"),
        (EncryptionMethod.AES_256, "ä" * 64, "boss", r"at most 127 bytes"),
        (EncryptionMethod.AES_256, "open", "ä" * 64, r"at most 127 bytes"),
        (EncryptionMethod.AES_128, "密码", "boss", r"ASCII letters only"),
        (EncryptionMethod.AES_128, "pässwörd", "boss", r"ASCII letters only"),
        (EncryptionMethod.AES_128, "a" * 33, "boss", r"at most 32 characters"),
    ],
)
def test_each_settings_rule_is_refused_with_invalid_settings(
    open_copy: Opener, method: EncryptionMethod, user: str, owner: str, message: str
) -> None:
    s = open_copy("report")
    settings = SecuritySettings(method, user, owner, RESTRICTED)
    with pytest.raises(Refused, match=message) as info:
        run(s, "security.set", SetSecurity(settings))
    assert info.value.reason == "invalid_settings"
    assert _pending(s) is None and not s.undo_stack.can_undo
    for secret in (user, owner):
        assert not secret or secret not in str(info.value)


def test_an_open_password_alone_may_repeat_as_the_owner_password(open_copy: Opener) -> None:
    s = open_copy("report")
    run(s, "security.set", SetSecurity(SecuritySettings(EncryptionMethod.AES_256, "same", "same")))
    assert _pending(s) is not None


@pytest.mark.parametrize(
    ("method", "user", "owner"),
    [
        (EncryptionMethod.AES_256, "ä" * 63 + "b", "boss"),  # 127 bytes: the limit
        (EncryptionMethod.AES_128, "a" * 32, "boss"),  # 32 characters: the limit
        (EncryptionMethod.AES_256, "open", ""),  # open password only, no owner
        (EncryptionMethod.NONE, "", ""),  # removal is always allowed
    ],
)
def test_settings_at_the_limits_and_removal_are_accepted(
    open_copy: Opener, method: EncryptionMethod, user: str, owner: str
) -> None:
    s = open_copy("report")
    run(s, "security.set", SetSecurity(SecuritySettings(method, user, owner, RESTRICTED)))
    assert _pending(s) is not None
