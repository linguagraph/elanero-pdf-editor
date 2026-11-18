"""Opening damaged, empty, foreign and unsupported files: clear errors or repair, no crashes."""

from __future__ import annotations

import random
from pathlib import Path

import pytest

from pdfeditor.engine.base import Engine, OpenError


def test_truncated_file_is_repaired(engine: Engine, fixture_pdf, tmp_path: Path) -> None:
    data = fixture_pdf("report").read_bytes()
    path = tmp_path / "truncated.pdf"
    path.write_bytes(data[: len(data) // 2])
    doc = engine.open(path)
    assert doc.info().is_repaired and doc.page_count >= 1
    assert doc.page(0).text_page(with_chars=False).text.strip()
    doc.close()


# Fixed-seed noise, not os.urandom: xdist workers must collect identical test ids.
_NOISE = random.Random(20260917).randbytes(3000)


@pytest.mark.parametrize(
    ("content", "message"),
    [
        pytest.param(b"", "empty", id="empty"),
        pytest.param(_NOISE, "isn't a PDF", id="noise"),
        pytest.param(b"%PDF-1.7\n", "isn't a PDF", id="header-only"),
    ],
)
def test_unreadable_files(engine: Engine, tmp_path: Path, content: bytes, message: str) -> None:
    path = tmp_path / "bad.pdf"
    path.write_bytes(content)
    with pytest.raises(OpenError, match=message):
        engine.open(path)


def test_certificate_security_is_refused(engine: Engine, fixture_pdf) -> None:
    path = fixture_pdf("damaged_pubsec_filter")
    with pytest.raises(OpenError, match=r"Adobe.PubSec"):
        engine.open(path)


def test_standard_security_still_opens(engine: Engine, fixture_pdf) -> None:
    doc = engine.open(fixture_pdf("encrypted"), "user")
    assert doc.page_count == 1
    doc.close()
