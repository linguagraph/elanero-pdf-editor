"""In-place incremental bytes for signed documents (``Document.incremental_bytes``).

The MuPDF writer used here is driven through pymupdf internals, so the version test below
pins the release it was checked against. The signed sample is read only, never saved or signed.
"""

from __future__ import annotations

import io
import re
import shutil
from collections.abc import Callable
from pathlib import Path

import pymupdf
import pytest

from pdfeditor.engine.base import Document, SaveError, SaveOptions
from pdfeditor.engine.registry import get_engine
from pdfeditor.model.metadata import Metadata
from tests.hostcheck import record

# The PyMuPDF version the test environment is pinned to (the pymupdf constraint in
# pyproject.toml). A pymupdf bump must re-check incremental_bytes (it calls
# pymupdf._as_pdf_document, JM_embedded_clean, JM_ensure_identity and mupdf.pdf_save_document)
# and then update this constant.
LOCKED_PYMUPDF_VERSION = "2.1"

SIGNED = Path(__file__).parent.parent / "fixtures" / "real" / "signed_selfsigned.pdf"
INCREMENTAL = SaveOptions(incremental=True)
ONCE_MESSAGE = "can only be saved in place once after it changes"


def _open_signed(source: Path | bytes) -> Document:
    return get_engine("mupdf").open(source)


def _roundtrip(data: bytes) -> None:
    """Every saved output must open in pikepdf and render in pypdfium2 (AGENTS round trip)."""
    record("page_count_pikepdf", data, pages=1)
    record("render_width_pdfium", data, scale=0.5)


def _byte_range(data: bytes) -> bytes:
    match = re.search(rb"/ByteRange\s*\[[^\]]*\]", data)
    assert match is not None
    return match.group(0)


# The web build runs PyMuPDF 1.28.2 under Pyodide, so this desktop pin check is not for it.
@pytest.mark.desktop_only
def test_version_is_the_locked_pymupdf() -> None:
    assert pymupdf.VersionBind == LOCKED_PYMUPDF_VERSION


def test_same_state_returns_the_same_bytes() -> None:
    doc = _open_signed(SIGNED)
    doc.set_metadata(Metadata(title="one"))
    first = doc.incremental_bytes(INCREMENTAL)
    second = doc.incremental_bytes(INCREMENTAL)
    assert first is not None
    assert second == first


def test_first_in_place_save_keeps_original_and_signature() -> None:
    original = SIGNED.read_bytes()
    doc = _open_signed(SIGNED)
    doc.set_metadata(Metadata(title="changed"))
    data = doc.incremental_bytes(INCREMENTAL)
    assert data is not None
    assert data.startswith(original)
    assert _byte_range(data) == _byte_range(original)
    record("docinfo_title_pikepdf", data, title="changed")
    _roundtrip(data)
    assert SIGNED.read_bytes() == original  # the sample file itself is untouched


def test_second_in_place_save_after_an_edit_raises() -> None:
    doc = _open_signed(SIGNED)
    doc.set_metadata(Metadata(title="one"))
    assert doc.incremental_bytes(INCREMENTAL) is not None
    doc.set_metadata(Metadata(title="two"))
    with pytest.raises(SaveError, match=ONCE_MESSAGE):
        doc.incremental_bytes(INCREMENTAL)


def test_undo_of_a_signed_document_refuses_in_place_bytes() -> None:
    doc = _open_signed(SIGNED)
    before = doc.to_bytes()
    doc.set_metadata(Metadata(title="edited"))
    doc.load_state(before)  # what undo does
    with pytest.raises(SaveError, match=ONCE_MESSAGE):
        doc.incremental_bytes(INCREMENTAL)


def test_fresh_documents_produce_identical_bytes() -> None:
    outputs = []
    for _ in range(2):
        doc = _open_signed(SIGNED)
        doc.set_metadata(Metadata(title="same"))
        data = doc.incremental_bytes(INCREMENTAL)
        assert data is not None
        outputs.append(data)
    assert outputs[0] == outputs[1]


def test_bytes_opened_signed_document_works_the_same() -> None:
    original = SIGNED.read_bytes()
    doc = _open_signed(original)
    doc.set_metadata(Metadata(title="from bytes"))
    data = doc.incremental_bytes(INCREMENTAL)
    assert data is not None
    assert data.startswith(original)
    record("docinfo_title_pikepdf", data, title="from bytes")


def test_unsigned_document_has_no_in_place_bytes(fixture_pdf: Callable[[str], Path]) -> None:
    doc = _open_signed(fixture_pdf("text_multipage"))
    assert doc.incremental_bytes(INCREMENTAL) is None


@pytest.mark.desktop_only  # pyhanko is excluded from the web package (signing is desktop-only)
def test_pyhanko_validates_the_first_signature_after_an_in_place_save() -> None:
    """Structure isn't enough: the signature itself must still verify, read by pyHanko's strict
    reader. The sample's own signer is the trust root (a throwaway test certificate); the
    fixture is only read, never signed or saved over."""
    from pyhanko.pdf_utils.reader import PdfFileReader
    from pyhanko.sign.validation import validate_pdf_signature
    from pyhanko_certvalidator import ValidationContext

    def first_signature(data: bytes) -> object:
        reader = PdfFileReader(io.BytesIO(data))  # strict by default
        sig = reader.embedded_signatures[0]
        status = validate_pdf_signature(sig, ValidationContext(trust_roots=[sig.signer_cert]))
        assert status.intact is True
        assert status.valid is True
        return sig

    original = SIGNED.read_bytes()
    first_signature(original)
    doc = _open_signed(SIGNED)
    doc.set_metadata(Metadata(title="pyhanko"))
    data = doc.incremental_bytes(INCREMENTAL)
    assert data is not None
    assert data.startswith(original)
    first_signature(data)


def test_signed_flag_document_with_empty_embedded_files_repeats_from_cache(
    tmp_path: Path, fixture_pdf: Callable[[str], Path]
) -> None:
    """Review repro: /SigFlags 3 and an empty /Names /EmbeddedFiles. The clean steps change
    objects before the write, so the second call must compare against the state after them."""
    path = tmp_path / "flagged.pdf"
    shutil.copy2(fixture_pdf("incremental_sigflags_empty_embedded"), path)
    doc = _open_signed(path)
    first = doc.incremental_bytes(INCREMENTAL)
    assert first is not None
    assert doc.incremental_bytes(INCREMENTAL) == first


def test_writer_failure_raises_with_the_cause_and_keeps_the_lineage_spent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """MuPDF's writer may advance its state before it fails, so the one update counts as used:
    a later call refuses rather than writing on a state it can't match."""
    doc = _open_signed(SIGNED)
    doc.set_metadata(Metadata(title="before failure"))

    def broken_writer(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("writer exploded")

    monkeypatch.setattr(pymupdf.mupdf, "pdf_save_document", broken_writer)
    with pytest.raises(SaveError, match="incremental save failed") as caught:
        doc.incremental_bytes(INCREMENTAL)
    assert isinstance(caught.value.__cause__, RuntimeError)
    monkeypatch.undo()
    with pytest.raises(SaveError, match=ONCE_MESSAGE):
        doc.incremental_bytes(INCREMENTAL)


def test_failure_before_the_writer_leaves_the_lineage_unspent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = SIGNED.read_bytes()
    doc = _open_signed(SIGNED)
    doc.set_metadata(Metadata(title="before failure"))

    def broken_clean(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("clean steps exploded")

    monkeypatch.setattr(pymupdf, "JM_embedded_clean", broken_clean)
    with pytest.raises(SaveError, match="incremental save failed") as caught:
        doc.incremental_bytes(INCREMENTAL)
    assert isinstance(caught.value.__cause__, RuntimeError)
    monkeypatch.undo()

    data = doc.incremental_bytes(INCREMENTAL)  # the writer never ran, so the update is still due
    assert data is not None
    assert data.startswith(original)
    record("docinfo_title_pikepdf", data, title="before failure")
