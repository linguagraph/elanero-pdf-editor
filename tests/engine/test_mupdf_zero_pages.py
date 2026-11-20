"""A document whose page tree is damaged is refused cleanly, not as an internal error.

Two shapes of fuzz damage reached the web save as INTERNAL:

- a page tree with no pages opened with ``page_count == 0``; the save then raised
  ``ValueError: cannot save with zero pages``;
- a page tree MuPDF accepts on open but cannot write (``FzErrorFormat: malformed page tree``,
  ``FzErrorSyntax``) failed inside ``tobytes``.

The first is refused at open (``OPEN_FAILED``), the second becomes a ``SaveError``, which the web
maps to ``SAVE_FAILED``. The input bytes are never written to, so the original file is unchanged.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import pymupdf
import pytest

from pdfeditor.engine.base import SaveError, SaveOptions
from pdfeditor.engine.mupdf.document import open_document
from pdfeditor.model import platform as model_platform
from pdfeditor.webapi import dispatch
from pdfeditor.webapi.errors import OPEN_FAILED
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY


def _pdf(objects: list[tuple[int, bytes]]) -> bytes:
    """A small PDF with a correct xref table; object 1 is the catalog."""
    out = bytearray(b"%PDF-1.4\n")
    offsets: dict[int, int] = {}
    for number, body in objects:
        offsets[number] = len(out)
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    size = max(offsets) + 1
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % size
    for number in range(1, size):
        if number in offsets:
            out += b"%010d 00000 n \n" % offsets[number]
        else:
            out += b"0000000000 65535 f \n"
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (size, xref)
    return bytes(out)


# The page tree has no kids, so MuPDF opens the file with zero pages.
ZERO_PAGE_PDF = _pdf(
    [
        (1, b"<< /Type /Catalog /Pages 2 0 R >>"),
        (2, b"<< /Type /Pages /Kids [] /Count 0 >>"),
    ]
)

ONE_PAGE_PDF = _pdf(
    [
        (1, b"<< /Type /Catalog /Pages 2 0 R >>"),
        (2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
        (3, b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>"),
    ]
)


@pytest.fixture
def web() -> Iterator[None]:
    previous = model_platform.current()
    configure_web()
    try:
        yield
    finally:
        REGISTRY.close_all()
        model_platform.configure(previous)


def call(method: str, params: dict[str, Any], buffers: list[bytes]) -> dict[str, Any]:
    request = json.dumps({"v": 1, "id": 1, "method": method, "params": params})
    reply_json, _ = dispatch(request, buffers)
    reply: dict[str, Any] = json.loads(reply_json)
    return reply


def test_zero_page_document_is_refused_at_open(web: None) -> None:
    data = bytes(ZERO_PAGE_PDF)
    reply = call(
        "session.open", {"name": "empty.pdf", "data": {"$bin": 0}, "password": None}, [data]
    )

    assert reply["ok"] is False
    assert reply["error"]["code"] == OPEN_FAILED
    assert "no readable pages" in reply["error"]["message"]
    assert len(REGISTRY) == 0
    assert data == ZERO_PAGE_PDF  # the input is only read


def _malformed() -> pymupdf.mupdf.FzErrorFormat:
    return pymupdf.mupdf.FzErrorFormat("malformed page tree")


def test_damaged_page_tree_in_save_preparation_is_a_save_error() -> None:
    # The fuzz files fail here: naming an unnamed annotation loads its page.
    document = open_document(ONE_PAGE_PDF, None)

    def _fail() -> int:
        raise _malformed()

    document._name_unnamed_annotations = _fail  # type: ignore[method-assign]

    with pytest.raises(SaveError, match="damaged"):
        document.prepare_full_save(SaveOptions())


def test_damaged_page_tree_on_write_is_a_save_error() -> None:
    class _FailingWrite:
        """Delegates to the real document, but its write fails as MuPDF's does for a damaged
        page tree that the open accepted."""

        def __init__(self, inner: pymupdf.Document) -> None:
            self._inner = inner

        def __getattr__(self, name: str) -> Any:
            return getattr(self._inner, name)

        def tobytes(self, **kwargs: Any) -> bytes:
            raise _malformed()

    document = open_document(ONE_PAGE_PDF, None)
    document._fz = _FailingWrite(document._fz)  # type: ignore[assignment]

    with pytest.raises(SaveError, match="damaged"):
        document.to_bytes()
