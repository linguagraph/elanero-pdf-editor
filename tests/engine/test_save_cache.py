"""The in-place save cache, one edit family at a time (W2.3).

Every family edits the signed sample through the document protocol, then checks the in-place
bytes: calling again with no change returns the same bytes; a further change refuses (the one
update is written); and a change made behind the API's back (a raw MuPDF write) is caught by
the state digest, so stale bytes are never returned. The unsigned document has no lineage, so
its in-place bytes are full writes and must differ after every change.
"""

from __future__ import annotations

import shutil
from collections.abc import Callable
from pathlib import Path

import pytest

from pdfeditor.core.session import DocumentSession
from pdfeditor.engine.base import Document, SaveError
from pdfeditor.model.annotations import AnnotationModel, AnnotationType
from pdfeditor.model.color import Color
from pdfeditor.model.geometry import Rect
from pdfeditor.model.metadata import Metadata
from pdfeditor.model.redaction import RedactOptions

SIGNED = Path(__file__).parent.parent / "fixtures" / "real" / "signed_selfsigned.pdf"
ONCE_MESSAGE = "can only be saved in place once after it changes"
BOX = Rect(72, 72, 200, 120)


def _annotation(doc: Document) -> None:
    doc.page(0).add_annotation(AnnotationModel(AnnotationType.SQUARE, 0, BOX, color=Color(1, 0, 0)))


def _page_insert(doc: Document) -> None:
    doc.insert_blank_page(0, 612, 792)


def _metadata(doc: Document) -> None:
    doc.set_metadata(Metadata(title="changed"))


def _redaction(doc: Document) -> None:
    doc.page(0).add_annotation(AnnotationModel(AnnotationType.REDACT, 0, BOX))
    doc.page(0).apply_redactions(None, RedactOptions())


def _rotation(doc: Document) -> None:
    doc.page(0).set_rotation(90)


FAMILIES: list[tuple[str, Callable[[Document], None]]] = [
    ("annotation add", _annotation),
    ("page insert", _page_insert),
    ("metadata set", _metadata),
    ("redaction apply", _redaction),
    ("rotation", _rotation),
]


@pytest.fixture
def signed_copy(tmp_path: Path) -> Path:
    """A copy of the signed sample: the in-place saves write bytes only, but the copy keeps the
    shared sample out of reach of any test that might save to its own path."""
    path = tmp_path / "signed.pdf"
    shutil.copyfile(SIGNED, path)
    return path


@pytest.mark.parametrize(("name", "edit"), FAMILIES, ids=[name for name, _ in FAMILIES])
def test_signed_family_cache(
    name: str, edit: Callable[[Document], None], signed_copy: Path
) -> None:
    session = DocumentSession.open(signed_copy)
    edit(session.document)
    if name == "redaction apply":
        # Redaction makes MuPDF refuse an incremental update (its content is rewritten), so the
        # session forces a full save, as the redaction action does. The in-place bytes are then
        # a full write that follows the state.
        session.require_full_save = True
        first = session.save_bytes("in_place")
        assert first.incremental is False
        _metadata(session.document)
        assert session.save_bytes("in_place").data != first.data
        session.close()
        return
    first = session.save_bytes("in_place")
    assert first.incremental is True
    again = session.save_bytes("in_place")
    assert again.data == first.data, f"{name}: no change must return the same bytes"

    # A further change after the one written update must refuse, not return the old bytes.
    _metadata(session.document)
    with pytest.raises(SaveError, match=ONCE_MESSAGE):
        session.save_bytes("in_place")
    session.close()


@pytest.mark.parametrize(("name", "edit"), FAMILIES, ids=[name for name, _ in FAMILIES])
def test_unsigned_family_bytes_follow_the_state(
    name: str, edit: Callable[[Document], None], fixture_pdf: Callable[[str], Path]
) -> None:
    session = DocumentSession.open(fixture_pdf("text_multipage"))
    before = session.save_bytes("in_place").data
    edit(session.document)
    after = session.save_bytes("in_place").data
    assert after != before, f"{name}: a change must show in the bytes"
    session.close()


def test_raw_change_behind_the_api_is_not_hidden_by_the_cache(signed_copy: Path) -> None:
    """The safety net: a MuPDF write that bypasses every counted entry point still changes the
    state digest, so the second call refuses instead of returning the cached bytes."""
    session = DocumentSession.open(signed_copy)
    first = session.save_bytes("in_place")
    assert first.incremental is True
    session.document.fz.set_metadata({"title": "raw"})  # not through any API method
    with pytest.raises(SaveError, match=ONCE_MESSAGE):
        session.save_bytes("in_place")
    session.close()


def test_unsigned_repeat_without_change_is_a_full_write(
    fixture_pdf: Callable[[str], Path],
) -> None:
    session = DocumentSession.open(fixture_pdf("text_multipage"))
    first = session.save_bytes("in_place")
    assert first.incremental is False
    assert session.save_bytes("in_place").incremental is False
    session.close()
