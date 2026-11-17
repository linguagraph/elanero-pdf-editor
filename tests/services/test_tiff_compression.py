"""TIFF compression comes from the platform flag. The web build writes LZW and must never
reach the deflate branch (W0.4 item 4), so both values are exercised and read back."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest
from PIL import Image

from pdfeditor.engine.registry import get_engine
from pdfeditor.model.platform import configure, current
from pdfeditor.services.export.images import ImageFormat, PageImageOptions, export_pages

ENGINE = get_engine()

# Pillow reports the deflate tag (8) as "tiff_adobe_deflate" when reading a file back.
READ_BACK = {"tiff_deflate": "tiff_adobe_deflate", "tiff_lzw": "tiff_lzw"}


@pytest.fixture
def text_doc(fixture_pdf):
    doc = ENGINE.open(fixture_pdf("text_multipage"))
    yield doc
    doc.close()


@pytest.mark.parametrize("compression", ["tiff_deflate", "tiff_lzw"])
def test_tiff_export_uses_platform_compression(text_doc, tmp_path: Path, compression: str) -> None:
    saved = current()
    configure(replace(saved, tiff_compression=compression))
    try:
        single = export_pages(
            text_doc, [0], tmp_path / "one", PageImageOptions(ImageFormat.TIFF, 50)
        )
        multi = export_pages(
            text_doc, [0, 1, 2], tmp_path / "three", PageImageOptions(ImageFormat.TIFF, 50)
        )
    finally:
        configure(saved)

    with Image.open(single[0]) as img:
        assert img.format == "TIFF" and img.n_frames == 1
        assert img.info.get("compression") == READ_BACK[compression]
    with Image.open(multi[0]) as img:
        assert img.format == "TIFF" and img.n_frames == 3
        assert img.info.get("compression") == READ_BACK[compression]
