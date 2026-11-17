"""Document actions (metadata, bookmarks) and comment flattening on real documents: results, labels,
undo, refusals and the round-trip rule.

No Qt. The fixture ``annotations`` has six comments named ``fitz-A0`` to ``fitz-A5``; the fixture
``outline`` has a bookmark tree. Saved files must open in pikepdf and render in pypdfium2.
"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from typing import cast

import pikepdf
import pypdfium2 as pdfium
import pytest

from pdfeditor.actions import REGISTRY, document, run
from pdfeditor.actions.base import NotSupported
from pdfeditor.actions.document import FlattenAnnotations, SetMetadata, SetOutline
from pdfeditor.core.session import DocumentSession
from pdfeditor.engine.registry import get_engine
from pdfeditor.model.annotations import AnnotRef
from pdfeditor.model.metadata import Metadata
from pdfeditor.model.outline import Destination, OutlineItem
from pdfeditor.services.comments import flattenable
from tests.actions.conftest import Opener

# One minimal value per action; the Busy test in test_registry.py runs each one.
BUSY_CASES: dict[str, object] = {
    "document.set_metadata": SetMetadata(Metadata(title="Busy")),
    "document.set_outline": SetOutline(()),
    "annotations.flatten": FlattenAnnotations(None),
}


def comment_names(session: DocumentSession, page: int = 0) -> list[str]:
    with session.lock:
        return sorted(
            a.name for a in session.document.page(page).annotations() if a.type.is_comment
        )


def metadata_of(session: DocumentSession) -> Metadata:
    with session.lock:
        return session.document.metadata()


def outline_titles(session: DocumentSession) -> list[str]:
    with session.lock:
        return [item.title for _, item in _walk(session.document.outline())]


def _walk(items: list[OutlineItem]) -> list[tuple[int, OutlineItem]]:
    out: list[tuple[int, OutlineItem]] = []
    for item in items:
        out.extend(item.walk())
    return out


def texts(session: DocumentSession) -> list[str]:
    with session.lock:
        doc = session.document
        return [doc.page(i).text_page(with_chars=False).text for i in range(doc.page_count)]


def close(session: DocumentSession) -> None:
    with session.lock:
        session.document.close()


def assert_reads_everywhere(path: Path, pages: int) -> None:
    """The saved file opens in pikepdf and renders page 1 in pypdfium2."""
    with pikepdf.open(path) as pdf:
        assert len(pdf.pages) == pages
    pd = pdfium.PdfDocument(path)
    try:
        assert len(pd) == pages
        assert pd[0].render(scale=0.5).to_pil().size[0] > 0
    finally:
        pd.close()


def ref(name: str, page: int = 0) -> AnnotRef:
    return AnnotRef(page, name)


# -- metadata ---------------------------------------------------------------------------------


def test_set_metadata_then_undo_restores_the_old_fields(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    before = metadata_of(s)
    new = replace(before, title="Quarterly report", author="Finance")
    result = document.set_metadata(s, SetMetadata(new))
    assert result.label == "Change Document Properties" and result.executed
    assert s.undo_stack.undo_label == "Change Document Properties"
    assert metadata_of(s).title == "Quarterly report" and metadata_of(s).author == "Finance"
    assert s.undo()
    assert metadata_of(s) == before


def test_set_metadata_unchanged_is_not_executed(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    result = document.set_metadata(s, SetMetadata(metadata_of(s)))
    assert result.executed is False and result.value is None
    assert not s.undo_stack.can_undo


def test_set_metadata_round_trip(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("text_multipage")
    document.set_metadata(s, SetMetadata(replace(metadata_of(s), title="Saved title")))
    out = s.save(tmp_path / "meta.pdf")
    reopened = DocumentSession.open(out)
    try:
        assert metadata_of(reopened).title == "Saved title"
    finally:
        close(reopened)
    with pikepdf.open(out) as pdf:
        assert str(pdf.docinfo["/Title"]) == "Saved title"
    assert_reads_everywhere(out, s.page_count)


# -- bookmarks --------------------------------------------------------------------------------


def test_set_outline_replaces_the_bookmarks_and_undo_restores_them(open_copy: Opener) -> None:
    s = open_copy("outline")
    before = outline_titles(s)
    items = (
        OutlineItem("Introduction", dest=Destination(0)),
        OutlineItem(
            "Appendix",
            dest=Destination(5),
            children=[OutlineItem("Glossary", dest=Destination(5))],
        ),
    )
    result = document.set_outline(s, SetOutline(items))
    assert result.label == "Edit Bookmarks" and result.executed
    assert s.undo_stack.undo_label == "Edit Bookmarks"
    assert outline_titles(s) == ["Introduction", "Appendix", "Glossary"]
    assert s.undo()
    assert outline_titles(s) == before


def test_set_outline_with_a_custom_label(open_copy: Opener) -> None:
    s = open_copy("outline")
    items = (OutlineItem("Only", dest=Destination(1)),)
    result = document.set_outline(s, SetOutline(items, "Delete Bookmark"))
    assert result.label == "Delete Bookmark"
    assert s.undo_stack.undo_label == "Delete Bookmark"
    assert s.undo()


def pikepdf_outline(pdf: pikepdf.Pdf) -> list[tuple[int, str]]:
    """(level, title) of every bookmark, walked by hand through /First and /Next."""
    out: list[tuple[int, str]] = []

    def walk(node: pikepdf.Object, level: int) -> None:
        child = node.get("/First")
        while child is not None:
            out.append((level, str(child.Title)))
            walk(child, level + 1)
            child = child.get("/Next")

    walk(pdf.Root.Outlines, 1)
    return out


def test_set_outline_round_trip(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("text_multipage")
    last = Destination(s.page_count - 1)
    items = (
        OutlineItem("Start", dest=Destination(0)),
        OutlineItem("Appendix", dest=last, children=[OutlineItem("Glossary", dest=last)]),
    )
    document.set_outline(s, SetOutline(items))
    out = s.save(tmp_path / "outline.pdf")
    reopened = DocumentSession.open(out)
    try:
        with reopened.lock:
            levels = [(level, item.title) for level, item in _walk(reopened.document.outline())]
        assert levels == [(1, "Start"), (1, "Appendix"), (2, "Glossary")]
    finally:
        close(reopened)
    with pikepdf.open(out) as pdf:
        assert pikepdf_outline(pdf) == [(1, "Start"), (1, "Appendix"), (2, "Glossary")]
    assert_reads_everywhere(out, s.page_count)


# -- flatten comments --------------------------------------------------------------------------


def test_flatten_one_comment_keeps_the_others_and_undo_restores_it(open_copy: Opener) -> None:
    s = open_copy("annotations")
    before = comment_names(s)
    result = document.flatten(s, FlattenAnnotations((ref("fitz-A1"),)))
    assert result.label == "Flatten Comment" and result.value == 1 and result.executed
    assert s.undo_stack.undo_label == "Flatten Comment"
    assert comment_names(s) == [n for n in before if n != "fitz-A1"]
    assert s.undo()
    assert comment_names(s) == before


def test_flatten_several_named_comments_counts_them(open_copy: Opener) -> None:
    s = open_copy("annotations")
    result = document.flatten(s, FlattenAnnotations((ref("fitz-A2"), ref("fitz-A3"))))
    assert result.label == "Flatten Comment"  # singular, as the desktop has always said
    assert result.value == 2
    assert comment_names(s) == ["fitz-A0", "fitz-A1", "fitz-A4", "fitz-A5"]


def test_flatten_all_matches_flattenable_and_undo_restores_them(open_copy: Opener) -> None:
    s = open_copy("annotations")
    with s.lock:
        expected, _pages = flattenable(s.document)
    before = comment_names(s)
    result = document.flatten(s, FlattenAnnotations(None))
    assert result.label == "Flatten Comments" and result.value == expected == 6
    assert comment_names(s) == []
    assert s.undo()
    assert comment_names(s) == before


def test_flatten_unknown_or_unnamed_comments_is_not_executed(open_copy: Opener) -> None:
    s = open_copy("annotations")
    before = comment_names(s)
    result = document.flatten(s, FlattenAnnotations((ref("no-such-comment"), ref(""))))
    assert result.label == "Flatten Comment"
    assert result.executed is False and result.value == 0
    assert not s.undo_stack.can_undo and comment_names(s) == before


def test_flatten_one_comment_round_trip(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("annotations")
    document.flatten(s, FlattenAnnotations((ref("fitz-A0"),)))
    out = s.save(tmp_path / "flat_one.pdf")
    reopened = DocumentSession.open(out)
    try:
        assert comment_names(reopened) == ["fitz-A1", "fitz-A2", "fitz-A3", "fitz-A4", "fitz-A5"]
    finally:
        close(reopened)
    assert_reads_everywhere(out, 1)


def test_flatten_all_round_trip(open_copy: Opener, tmp_path: Path) -> None:
    s = open_copy("annotations")
    document.flatten(s, FlattenAnnotations(None))
    out = s.save(tmp_path / "flat_all.pdf")
    reopened = DocumentSession.open(out)
    try:
        assert comment_names(reopened) == []
        assert "Highlight this sentence" in texts(reopened)[0]
    finally:
        close(reopened)
    assert_reads_everywhere(out, 1)


# -- capabilities and registration ------------------------------------------------------------


def test_flatten_needs_the_annotations_flatten_capability(open_copy: Opener) -> None:
    s = open_copy("annotations")
    off = replace(get_engine().capabilities, annotations_flatten=False)
    fake = cast(DocumentSession, SimpleNamespace(engine=SimpleNamespace(capabilities=off)))
    with pytest.raises(NotSupported, match="annotations_flatten"):
        run(fake, "annotations.flatten", FlattenAnnotations(None))
    assert not s.undo_stack.can_undo


def test_document_actions_are_registered_with_their_flags() -> None:
    assert REGISTRY["document.set_metadata"].requires == ("metadata_write",)
    assert REGISTRY["document.set_outline"].requires == ("outline_write",)
    assert REGISTRY["annotations.flatten"].requires == ("annotations_flatten",)
    assert REGISTRY["annotations.flatten"].long
