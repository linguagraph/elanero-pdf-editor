"""Reads the header of an image a user is adding to a page (W6.7b).

Pillow opens an image from its header only, so nothing is decoded here: the format and the size
come from the first bytes, and the engine decodes the picture later, once it is inserted. The
caller applies the platform's rules (formats, caps); this module only says what the bytes are.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

from PIL import Image


@dataclass(frozen=True, slots=True)
class ImageProbe:
    format: str  # Pillow's name: "PNG", "JPEG", "GIF", ...
    width: int
    height: int


class ImageTooManyPixels(ValueError):
    """Pillow's own bomb check fired: the header declares more pixels than it will ever decode."""


def probe_image(data: bytes) -> ImageProbe | None:
    """The format and size of the image in ``data``, or None when Pillow can't read its header.

    Raises :class:`ImageTooManyPixels` for a header past Pillow's bomb limit, which has no size to
    report. Pillow's warning band (above its limit, below twice it) is not an error here.
    """
    try:
        with Image.open(io.BytesIO(data)) as img:
            fmt = img.format
            width, height = img.size
    except Image.DecompressionBombError as exc:
        raise ImageTooManyPixels(str(exc)) from exc
    except Exception:  # Pillow raises many types on a damaged header (OSError, SyntaxError, ...)
        return None
    if fmt is None:
        return None
    return ImageProbe(format=fmt, width=width, height=height)
