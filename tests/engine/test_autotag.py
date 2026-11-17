"""Auto-tagging (experimental) through the Protocol: tree, ParentTree, and nothing else changes."""

from __future__ import annotations

import itertools
from pathlib import Path

import pytest

from pdfeditor.core.commands import SnapshotCommand
from pdfeditor.core.session import DocumentSession
from pdfeditor.engine.base import Document, Engine, EngineError, RenderRequest
from pdfeditor.model.geometry import Matrix
from pdfeditor.services.accessibility import Status, check
from tests.hostcheck import record


@pytest.fixture
def tagger(engine: Engine) -> Engine:
    if not engine.capabilities.auto_tag:
        pytest.skip(f"{engine.name} can't auto-tag")
    return engine


def _pixels(doc: Document) -> list[bytes]:
    req = RenderRequest(matrix=Matrix.scale(1.5))
    return [doc.page(i).render(req).samples for i in range(doc.page_count)]


def _texts(doc: Document) -> list[str]:
    return [doc.page(i).text_page(with_chars=False).text for i in range(doc.page_count)]


def _collapse(types: list[str]) -> list[str]:
    return [t for t, _ in itertools.groupby(types)]


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        (
            "report",
            ["H1", "H2", "P", "H2", "P", "H2", "Figure", "P", "H2", "P"],
        ),
        ("text_multipage", ["H1", "P"] * 5),
    ],
)
def test_auto_tag_round_trip(
    tagger: Engine, fixture_pdf, tmp_path: Path, name: str, expected: list[str]
) -> None:
    doc = tagger.open(fixture_pdf(name))
    assert doc.structure_tree() == [] and not doc.info().is_tagged
    pixels, texts = _pixels(doc), _texts(doc)
    counts = doc.auto_tag()
    assert _pixels(doc) == pixels  # marked content doesn't change what's drawn
    assert _texts(doc) == texts
    out = doc.save(tmp_path / f"{name}-tagged.pdf")
    doc.close()

    reopened = tagger.open(out)
    assert reopened.info().is_tagged
    (root,) = reopened.structure_tree()
    assert root.type == "Document"
    types = [n.type for n in root.children]
    assert _collapse(types) == expected
    assert {t: types.count(t) for t in set(types)} == counts
    pages = [n.page_index for n in root.children]
    assert pages == sorted(pages) and set(pages) == set(range(reopened.page_count))
    assert _texts(reopened) == texts and _pixels(reopened) == pixels
    findings = check(reopened)
    assert next(f for f in findings if f.rule == "tagged").status is Status.PASSED
    assert next(f for f in findings if f.rule == "reading-order").status is Status.PASSED
    if "Figure" in counts:  # new figures still need a description from the user
        assert any(f.rule == "alt-text" and f.status is Status.FAILED for f in findings)
    reopened.close()

    record("marked_content_pikepdf", out, minimum=sum(counts.values()))  # each element has an MCID
    record("page_count_pdfium", out, pages=len(texts))
    for i in range(len(texts)):
        record("render_pdfium", out, page=i, scale=0.5)
    record("text_contains_pdfium", out, page=0, text=texts[0].split("\n", 1)[0])


def test_auto_tag_other_layouts(tagger: Engine, fixture_pdf, tmp_path: Path) -> None:
    """Rotated pages, optional content, forms of every kind: still pixel- and text-identical."""
    for name in ("rotated_pages", "layers", "mixed_content", "images", "two_columns"):
        doc = tagger.open(fixture_pdf(name))
        pixels, texts = _pixels(doc), _texts(doc)
        doc.auto_tag()
        assert _pixels(doc) == pixels, name
        assert _texts(doc) == texts, name
        out = doc.save(tmp_path / f"{name}.pdf")
        doc.close()
        record("marked_content_pikepdf", out, minimum=1)
        record("opens_pdfium", out)


def test_refuses_tagged_and_empty(tagger: Engine, fixture_pdf) -> None:
    doc = tagger.open(fixture_pdf("tagged"))
    with pytest.raises(EngineError, match="already tagged"):
        doc.auto_tag()
    doc.close()
    doc = tagger.open(fixture_pdf("vector_art"))
    with pytest.raises(EngineError, match="no text or image"):
        doc.auto_tag()
    assert not doc.info().is_tagged
    doc.close()


def test_undo_restores_untagged(fixture_pdf) -> None:
    session = DocumentSession.open(fixture_pdf("report"))
    if not session.engine.capabilities.auto_tag:
        pytest.skip("no auto-tag support")
    doc = session.document
    session.execute(SnapshotCommand("Auto-Tag", lambda d: d.auto_tag(), session.snapshots))
    assert doc.info().is_tagged and doc.structure_tree()
    session.undo()
    assert not doc.info().is_tagged and doc.structure_tree() == []
    session.redo()
    assert [n.type for n in doc.structure_tree()[0].children][:2] == ["H1", "H2"]
    session.undo_stack.set_clean()
    session.close()
