"""The generated corpus is valid for independent PDF implementations."""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.conftest import FIXTURES
from tests.hostcheck import record

PLAIN = sorted(p for p in FIXTURES.glob("*.pdf") if p.stem not in {"encrypted", "broken_xref"})


@pytest.mark.parametrize("path", PLAIN, ids=lambda p: p.stem)
def test_fixture_opens_in_pikepdf_and_pdfium(path: Path) -> None:
    record("pages_nonempty_pikepdf", path)
    record("pages_nonempty_pdfium", path)


def test_encrypted_requires_password(fixture_pdf) -> None:
    record("refuses_without_password_pikepdf", fixture_pdf("encrypted"))
    record("page_count_pikepdf", fixture_pdf("encrypted"), pages=1, password="user")


def test_broken_xref_is_repairable(fixture_pdf) -> None:
    record("page_count_pikepdf", fixture_pdf("broken_xref"), pages=1)
