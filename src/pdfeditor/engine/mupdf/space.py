"""Page coordinate spaces for the MuPDF backend's writes.

See docs/web/design/rotated-crop-placement.md (issue #537).

Visible space (top-left of the crop box, /Rotate applied) is what the layers above the engine
use. PyMuPDF's ``Page.transformation_matrix`` maps PDF space to "unrotated" space, but on a
rotated page it drops the crop box's origin, so every write that went through it landed offset
by that origin. The helpers here take the page transform from MuPDF itself, the one rendering
uses, and so are right on every box layout and rotation.

On pages where ``transformation_matrix`` is already right (unrotated pages, and pages whose crop
box starts at (0, 0)) the helpers return exactly the matrices the call sites used before, so
their output stays byte-identical.
"""

from __future__ import annotations

import pymupdf


def _mupdf_visible_to_pdf(fz: pymupdf.Page) -> pymupdf.Matrix:
    """Visible space -> PDF user space, from MuPDF's page transform (the one rendering uses)."""
    ctm = pymupdf.mupdf.FzMatrix()
    pymupdf.mupdf.pdf_page_transform(
        pymupdf.mupdf.pdf_page_from_fz_page(fz.this),
        pymupdf.mupdf.FzRect(pymupdf.mupdf.FzRect.Fixed_UNIT),
        ctm,
    )
    return ~pymupdf.Matrix(ctm.a, ctm.b, ctm.c, ctm.d, ctm.e, ctm.f)


def _transform_is_right(fz: pymupdf.Page) -> bool:
    """True where PyMuPDF's ``transformation_matrix`` agrees with MuPDF's page transform.

    That covers every unrotated page and every page whose crop box starts at (0, 0). On those
    the old matrices are kept as they are, so their output does not change by a float's worth.
    """
    old = fz.derotation_matrix * ~fz.transformation_matrix
    new = _mupdf_visible_to_pdf(fz)
    return all(abs(a - b) <= 1e-9 for a, b in zip(tuple(old), tuple(new), strict=True))


def visible_to_pdf(fz: pymupdf.Page) -> pymupdf.Matrix:
    """Visible space -> PDF user space."""
    if _transform_is_right(fz):
        return fz.derotation_matrix * ~fz.transformation_matrix
    return _mupdf_visible_to_pdf(fz)


def helper_space(fz: pymupdf.Page) -> pymupdf.Matrix:
    """Visible space -> the "unrotated" coordinates PyMuPDF's drawing helpers take.

    ``Shape``, ``insert_image``, ``insert_htmlbox``, ``show_pdf_page`` and ``draw_rect`` convert
    their input with ``~transformation_matrix`` internally. Composing with ``transformation_matrix``
    here cancels that matrix's error. Where it is right this is exactly ``derotation_matrix``.
    """
    if _transform_is_right(fz):
        return fz.derotation_matrix
    return visible_to_pdf(fz) * fz.transformation_matrix


def toc_point(fz: pymupdf.Page, p: pymupdf.Point) -> pymupdf.Point:
    """A visible point, encoded so that ``Document.set_toc`` writes the destination for it.

    ``set_toc`` flips a bookmark's "to" point and applies the page's ``rotation_matrix`` to it
    before writing ``/XYZ``. This inverts those two steps for the PDF point of ``p``.
    """
    q = p * visible_to_pdf(fz) * fz.derotation_matrix
    return pymupdf.Point(q.x, fz.cropbox.height - q.y)
