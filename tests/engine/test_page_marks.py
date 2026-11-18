"""Contract tests for page marks (capability ``page_marks``): stamps tagged as headers,
watermarks and backgrounds can be found, carry their settings and are removed cleanly."""

from __future__ import annotations

import io
import shutil
from pathlib import Path

import pytest
from PIL import Image

from pdfeditor.engine.base import ColorMode, Engine, RenderRequest
from pdfeditor.model.color import Color
from pdfeditor.model.geometry import Point, Rect
from pdfeditor.model.pages import ImageStamp, MarkKind, PageMark, TextStamp
from tests.hostcheck import record


@pytest.fixture
def marks(engine: Engine) -> Engine:
    if not engine.capabilities.page_marks:
        pytest.skip("engine lacks page marks")
    return engine


def _copy(fixture_pdf, tmp_path: Path, name: str) -> Path:
    path = tmp_path / f"{name}.pdf"
    shutil.copy2(fixture_pdf(name), path)
    return path


def _text(doc, index: int) -> str:
    return doc.page(index).text_page(with_chars=False).text


def _png(rgb: tuple[int, int, int]) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (64, 64), rgb).save(buf, format="PNG")
    return buf.getvalue()


def _pixel(doc, index: int, x: float, y: float) -> tuple[int, int, int]:
    probe = RenderRequest(color=ColorMode.RGB, clip=Rect(x, y, x + 1, y + 1))
    r, g, b = doc.page(index).render(probe).samples[:3]
    return r, g, b


def test_marks_round_trip_and_remove_only_their_kind(
    marks: Engine, fixture_pdf, tmp_path: Path
) -> None:
    path = _copy(fixture_pdf, tmp_path, "text_multipage")
    doc = marks.open(path)
    page = doc.page(0)
    assert page.page_marks() == []
    page.stamp_text(TextStamp("HEADER-X", Point(36, 30), 9, mark=MarkKind.HEADER_FOOTER))
    page.stamp_text(TextStamp("FOOTER-X", Point(36, 820), 9, mark=MarkKind.HEADER_FOOTER))
    page.stamp_text(TextStamp("BATES-0001", Point(400, 820), 9, mark=MarkKind.BATES))
    page.stamp_image(
        ImageStamp(_png((0, 0, 255)), Rect(250, 350, 350, 450), mark=MarkKind.WATERMARK)
    )
    page.fill_background(Color(1, 0.9, 0.9), 1.0, MarkKind.BACKGROUND)
    page.set_mark_settings(MarkKind.HEADER_FOOTER, '{"text": "HEADER-X é"}')
    page.stamp_text(TextStamp("unmarked stamp", Point(36, 300)))
    doc.save()
    doc.close()

    # an independent reader sees standard artifacts
    record(
        "artifact_tags_pikepdf",
        path,
        present=[
            ["/Header", "/HeaderFooter"],
            ["/Footer", "/HeaderFooter"],
            ["/Watermark", "/Watermark"],
            ["/Footer", "/Bates"],
        ],
    )

    doc = marks.open(path)
    found = {m.kind: m for m in doc.page(0).page_marks()}
    assert set(found) == set(MarkKind)
    assert found[MarkKind.HEADER_FOOTER] == PageMark(
        MarkKind.HEADER_FOOTER, '{"text": "HEADER-X é"}', foreign=False
    )
    assert found[MarkKind.WATERMARK].settings == ""
    assert doc.page(1).page_marks() == []

    assert doc.page(0).remove_marks([MarkKind.HEADER_FOOTER, MarkKind.WATERMARK]) == 3
    text = _text(doc, 0)
    assert "HEADER-X" not in text and "FOOTER-X" not in text
    assert "BATES-0001" in text and "unmarked stamp" in text and "Page 1 heading" in text
    assert {m.kind for m in doc.page(0).page_marks()} == {MarkKind.BATES, MarkKind.BACKGROUND}
    assert _pixel(doc, 0, 300, 400)[2] < 240  # watermark gone: the pink background shows
    doc.save()
    doc.close()

    # the watermark picture isn't drawn any more
    record("no_do_operators_pikepdf", path, page=0)
    record("text_lacks_pdfium", path, page=0, text="HEADER-X")
    record("text_contains_pdfium", path, page=0, text="BATES-0001")
    record("text_contains_pdfium", path, page=0, text="needle-1")
    record("render_pdfium", path, page=0, scale=0.5)
    doc = marks.open(path)
    assert doc.page(0).remove_marks(list(MarkKind)) == 2
    assert doc.page(0).page_marks() == []
    assert _pixel(doc, 0, 300, 400) == (255, 255, 255)
    doc.close()


def test_marks_on_rotated_pages(marks: Engine, fixture_pdf, tmp_path: Path) -> None:
    doc = marks.open(_copy(fixture_pdf, tmp_path, "rotated_pages"))
    for index in range(doc.page_count):
        page = doc.page(index)
        page.stamp_text(TextStamp("TOP", Point(40, 30), mark=MarkKind.HEADER_FOOTER))
        assert [m.kind for m in page.page_marks()] == [MarkKind.HEADER_FOOTER]
        assert "TOP" in _text(doc, index)
        assert page.remove_marks([MarkKind.HEADER_FOOTER]) == 1
        text = _text(doc, index)
        assert "TOP" not in text and ("Rotation" in text or "Landscape" in text)
    doc.close()


def test_removed_watermark_picture_leaves_the_file(marks: Engine, tmp_path: Path) -> None:
    doc = marks.new_document()
    doc.insert_blank_page(0, 300, 300)
    stamp = ImageStamp(_png((0, 200, 0)), Rect(50, 50, 250, 250), mark=MarkKind.WATERMARK)
    doc.page(0).stamp_image(stamp)
    path = tmp_path / "wm.pdf"
    doc.save(path)
    record("image_count_pikepdf", path, count=1)
    assert doc.page(0).remove_marks([MarkKind.WATERMARK]) == 1
    doc.save(path)
    doc.close()
    record("image_count_pikepdf", path, count=0)
    record("no_image_streams_pikepdf", path)


# -- other tools' marks -------------------------------------------------------------------------
def test_acrobat_marks_are_found_and_removed_others_left_alone(
    marks: Engine, fixture_pdf, tmp_path: Path
) -> None:
    path = _copy(fixture_pdf, tmp_path, "page_marks_acrobat_like")
    doc = marks.open(path)
    page = doc.page(0)
    assert page.page_marks() == [PageMark(MarkKind.WATERMARK, "", foreign=True)]
    assert page.remove_marks([MarkKind.HEADER_FOOTER]) == 0  # the running header isn't ours
    assert page.remove_marks([MarkKind.WATERMARK]) == 1
    doc.save()
    doc.close()
    record("text_lacks_pdfium", path, page=0, text="ACRO-WM")
    record("text_contains_pdfium", path, page=0, text="Running header")
    record("text_contains_pdfium", path, page=0, text="Body text")
    record("render_pdfium", path, page=0, scale=0.5)
