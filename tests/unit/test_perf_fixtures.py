"""The W0.2 performance fixtures have the shape the measurements assume (web/spike/perf).

Checked with pikepdf (independent of PyMuPDF): the page count of each size, and that page 1 has
one photo-like JPEG and text set in two fonts, one of them an embedded TrueType program.

The fixture_pdf fixture asserts the file exists, so a missing fixture fails the test rather than
skipping it (a skipped check would pass vacuously).
"""

from __future__ import annotations

from pathlib import Path

import pikepdf
import pytest

SIZES = {"perf_mixed_10": 10, "perf_mixed_200": 200, "perf_mixed_1000": 1000}


@pytest.mark.parametrize("name", list(SIZES), ids=list(SIZES))
def test_perf_fixture_page_count(name: str, fixture_pdf) -> None:
    path: Path = fixture_pdf(name)
    with pikepdf.open(path) as pdf:
        assert len(pdf.pages) == SIZES[name]


def test_perf_page_one_has_one_jpeg_and_two_fonts(fixture_pdf) -> None:
    with pikepdf.open(fixture_pdf("perf_mixed_10")) as pdf:
        page = pdf.pages[0]
        xobjects = page.Resources.get("/XObject", {})
        images = [
            obj
            for obj in xobjects.values()
            if obj.get("/Subtype") == "/Image" and obj.get("/Filter") == "/DCTDecode"
        ]
        assert len(images) == 1
        assert (int(images[0].Width), int(images[0].Height)) == (1200, 800)

        fonts = page.Resources.Font
        assert len(fonts) >= 2
        base14 = [
            f for f in fonts.values() if f.get("/Subtype") == "/Type1" and "/FontFile" not in f
        ]
        assert base14, "expected a base-14 font"

        embedded = []
        for font in fonts.values():
            if font.get("/Subtype") == "/Type0":
                descendant = font.DescendantFonts[0]
                if "/FontFile2" in descendant.FontDescriptor:
                    embedded.append(font)
        assert embedded, "expected an embedded TrueType font"

        used = set()
        for operands, operator in pikepdf.parse_content_stream(page):
            if operator == pikepdf.Operator("Tf"):
                used.add(str(operands[0]))
        assert len(used) >= 2, f"expected text in two fonts, saw {sorted(used)}"
