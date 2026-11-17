"""In-place incremental bytes for signed documents (``Document.incremental_bytes``).

The MuPDF writer used here is driven through pymupdf internals, so the version test below
pins the release it was checked against. The signed sample is read only, never saved or signed.
"""

from __future__ import annotations

import io
import re
from collections.abc import Callable
from pathlib import Path

import pikepdf
import pymupdf
import pypdfium2 as pdfium
import pytest

from pdfeditor.engine.base import Document, SaveError, SaveOptions
from pdfeditor.engine.registry import get_engine
from pdfeditor.model.metadata import Metadata

# The version in uv.lock. A pymupdf bump must re-check incremental_bytes (it calls
# pymupdf._as_pdf_document, JM_embedded_clean, JM_ensure_identity and mupdf.pdf_save_document)
# and then update this constant.
LOCKED_PYMUPDF_VERSION = "1.28.2"

SIGNED = Path(__file__).parent.parent / "fixtures" / "real" / "signed_selfsigned.pdf"
INCREMENTAL = SaveOptions(incremental=True)
ONCE_MESSAGE = "can only be saved in place once after it changes"


def _open_signed(source: Path | bytes) -> Document:
    return get_engine("mupdf").open(source)


def _roundtrip(data: bytes) -> None:
    """Every saved output must open in pikepdf and render in pypdfium2 (AGENTS round trip)."""
    with pikepdf.open(io.BytesIO(data)) as pdf:
        assert len(pdf.pages) == 1
    doc = pdfium.PdfDocument(data)
    try:
        assert doc[0].render(scale=0.5).width > 0
    finally:
        doc.close()


def _title(data: bytes) -> str:
    with pikepdf.open(io.BytesIO(data)) as pdf:
        return str(pdf.docinfo.get("/Title", ""))


def _byte_range(data: bytes) -> bytes:
    match = re.search(rb"/ByteRange\s*\[[^\]]*\]", data)
    assert match is not None
    return match.group(0)


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
    assert _title(data) == "changed"
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
    assert _title(data) == "from bytes"


def test_unsigned_document_has_no_in_place_bytes(fixture_pdf: Callable[[str], Path]) -> None:
    doc = _open_signed(fixture_pdf("text_multipage"))
    assert doc.incremental_bytes(INCREMENTAL) is None
