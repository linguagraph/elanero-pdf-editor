"""Page coordinate spaces (backend test: PyMuPDF builds the expected matrices).

``engine/mupdf/space.py`` must return exactly the matrices the writers used before wherever
PyMuPDF's ``transformation_matrix`` is right, and the corrected ones where it is not.
"""

from __future__ import annotations

import pymupdf
import pytest

from pdfeditor.engine.mupdf import space


def _same(a: pymupdf.Matrix, b: pymupdf.Matrix) -> bool:
    return all(abs(x - y) <= 1e-9 for x, y in zip(tuple(a), tuple(b), strict=True))


@pytest.mark.parametrize(
    ("name", "pages"),
    [
        ("rotated_pages", None),  # rotated, uncropped, and one landscape crop at /Rotate 0
        ("mixed_content", None),
        ("text_multipage", None),
        ("rotated_cropped", [8]),  # rotated, crop box at (0, 0): the transform is right here
    ],
)
def test_helpers_keep_the_old_matrices_where_the_transform_is_right(
    fixture_pdf, name: str, pages: list[int] | None
) -> None:
    doc = pymupdf.open(fixture_pdf(name))
    for index, page in enumerate(doc):
        if pages is not None and index not in pages:
            continue
        assert _same(space.helper_space(page), page.derotation_matrix), (name, index)
        assert _same(
            space.visible_to_pdf(page), page.derotation_matrix * ~page.transformation_matrix
        ), (name, index)
    doc.close()


@pytest.mark.parametrize("index", [1, 2, 3, 5, 6, 7])
def test_helpers_differ_from_the_old_matrices_on_rotated_cropped_pages(
    fixture_pdf, index: int
) -> None:
    """The fix changes these pages: the old helper space was offset by the crop origin."""
    page = pymupdf.open(fixture_pdf("rotated_cropped"))[index]
    assert not _same(space.helper_space(page), page.derotation_matrix)
    assert not _same(
        space.visible_to_pdf(page), page.derotation_matrix * ~page.transformation_matrix
    )
