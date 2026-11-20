"""XFDF coordinates outside the bound are refused before any engine write (fuzz crash).

A number of 40 digits parses as a float fine, but PyMuPDF's point type overflows on it, and the
TypeError surfaced from the quad code during the write. The parser must refuse it first.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from pdfeditor.core.session import DocumentSession
from pdfeditor.services.xfdf import import_command, parse_xfdf, preview_xfdf

_HEAD = '<?xml version="1.0"?><xfdf xmlns="http://ns.adobe.com/xfdf/"><annots>'
_TAIL = "</annots></xfdf>"


def _highlight(coords: str) -> str:
    return (
        f'{_HEAD}<highlight page="0" name="h1" rect="72,500,300,520" '
        f'coords="{coords}" color="#FFFF00"><contents>hl</contents></highlight>{_TAIL}'
    )


@pytest.fixture
def session(fixture_pdf, tmp_path: Path):
    path = tmp_path / "doc.pdf"
    shutil.copy2(fixture_pdf("annotations"), path)
    s = DocumentSession.open(path)
    yield s
    s.close()


def test_forty_digit_highlight_coordinate_is_refused_cleanly(session: DocumentSession) -> None:
    text = _highlight("72,520,300,520,72,500,9999999999999999999999999999999999999999300,500")
    with session.lock, pytest.raises(ValueError, match="out of range"):
        parse_xfdf(text, session.document)
    with session.lock, pytest.raises(ValueError, match="out of range"):
        import_command(text, session.document)
    with session.lock, pytest.raises(ValueError, match="out of range"):
        preview_xfdf(text, session.document)


def test_non_finite_and_out_of_bound_values_are_refused(session: DocumentSession) -> None:
    bad = [
        _highlight("72,520,300,520,72,500,nan,500"),
        _highlight("72,520,inf,520,72,500,300,500"),
        _highlight(f"72,520,{1_000_001},520,72,500,300,500"),
        _highlight("72,520,-300000000000000000000000000000000000000000,520,72,500,300,500"),
        f'{_HEAD}<square page="0" name="s1" rect="72,600,200,7e999"/>{_TAIL}',
    ]
    for text in bad:
        with session.lock, pytest.raises(ValueError):
            parse_xfdf(text, session.document)


def test_values_within_the_bound_still_import(session: DocumentSession) -> None:
    text = _highlight("72,520,300,520,72,500,300,500")
    with session.lock:
        models = parse_xfdf(text, session.document)
    assert len(models) == 1
    assert len(models[0].quads) == 1
