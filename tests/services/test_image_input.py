"""The header read behind content.add_image (W6.7b): the format and size from the first bytes."""

from __future__ import annotations

import io
import zlib

import pytest
from PIL import Image

from pdfeditor.services.image_input import ImageProbe, ImageTooManyPixels, probe_image


def encoded(fmt: str, size: tuple[int, int] = (7, 5)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, (1, 2, 3)).save(buf, format=fmt)
    return buf.getvalue()


@pytest.mark.parametrize(("fmt", "name"), [("PNG", "PNG"), ("JPEG", "JPEG"), ("GIF", "GIF")])
def test_the_format_and_size_come_from_the_header(fmt: str, name: str) -> None:
    assert probe_image(encoded(fmt)) == ImageProbe(format=name, width=7, height=5)


@pytest.mark.parametrize("data", [b"", b"plainly not an image", b"\x89PNG\r\n\x1a\nbroken"])
def test_bytes_that_are_not_an_image_probe_as_none(data: bytes) -> None:
    assert probe_image(data) is None


def test_a_header_past_pillows_bomb_limit_is_too_many_pixels() -> None:
    # A 1-bit PNG whose header declares 2 x 89 MP and more: Pillow's bomb check fires at open.
    buf = io.BytesIO()
    Image.new("1", (1, 1)).save(buf, format="PNG")
    raw = bytearray(buf.getvalue())
    # The IHDR data (width, height, ...) is 13 bytes at offset 16; its CRC follows at 29. The CRC
    # is recomputed, since Pillow checks it before it reads the size.
    raw[16:20] = (20_000).to_bytes(4, "big")
    raw[20:24] = (20_000).to_bytes(4, "big")
    raw[29:33] = zlib.crc32(bytes(raw[12:29])).to_bytes(4, "big")
    with pytest.raises(ImageTooManyPixels):
        probe_image(bytes(raw))
