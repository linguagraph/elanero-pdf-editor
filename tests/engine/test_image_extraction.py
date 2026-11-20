"""Extract Images through the engine Protocols only (W4.15): the service reads the document via
``Document.images()`` and ``extract_image`` and writes into the folder it is given, never beside
the source. The pixel ceiling (the web build) skips and counts images, and nothing else changes."""

from __future__ import annotations

import shutil
from pathlib import Path

from pdfeditor.engine.base import Engine
from pdfeditor.services.export.images import extract_images, oversized_images


def test_images_are_written_into_the_folder_and_never_beside_the_source(
    engine: Engine, fixture_pdf, tmp_path: Path
) -> None:
    source_dir = tmp_path / "source"
    source_dir.mkdir()
    source = source_dir / "doc.pdf"
    shutil.copyfile(fixture_pdf("images"), source)
    folder = tmp_path / "out"

    doc = engine.open(source)
    try:
        written = extract_images(doc, folder)
    finally:
        doc.close()

    assert written
    assert all(path.parent == folder for path in written)
    assert sorted(p.name for p in source_dir.iterdir()) == ["doc.pdf"]


def test_pixel_ceiling_skips_and_counts_the_same_images(
    engine: Engine, fixture_pdf, tmp_path: Path
) -> None:
    doc = engine.open(fixture_pdf("images"))
    try:
        everything = extract_images(doc, tmp_path / "all")
        assert everything, "the images fixture has images"
        assert oversized_images(doc, None, max_pixels=1) == len(everything)
        assert extract_images(doc, tmp_path / "none", max_pixels=1) == []
        assert oversized_images(doc, None, max_pixels=10**9) == 0
    finally:
        doc.close()


def test_a_page_filter_takes_only_the_images_that_page_shows(
    engine: Engine, fixture_pdf, tmp_path: Path
) -> None:
    doc = engine.open(fixture_pdf("images"))
    try:
        assert extract_images(doc, tmp_path / "beyond", pages=[doc.page_count + 5]) == []
        first = extract_images(doc, tmp_path / "first", pages=[0])
        assert len(first) <= len(extract_images(doc, tmp_path / "all"))
    finally:
        doc.close()
