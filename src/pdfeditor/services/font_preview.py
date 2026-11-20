"""Whether an embedded font program can preview a text edit: the check behind the editor's
preview font (W6.8a). Shared by the desktop editor and the web's ``content.preview_font`` call.

It is shipped in the web build, so fontTools is imported lazily: without it the check says
"no" and the caller falls back to a generic family, the same degraded path as a program that
has no character map.
"""

from __future__ import annotations

import io
import logging

logger = logging.getLogger(__name__)


def preview_font_program(data: bytes) -> bytes | None:
    """``data`` when it is a font program with a character map, else None.

    A program without ``cmap`` is what MuPDF leaves after it subsets on save: the PDF maps codes
    to glyphs itself, so no character can be looked up, and it can't preview text. Garbage and
    anything fontTools can't read give None too.
    """
    try:
        from fontTools.ttLib import TTFont
    except ImportError:
        logger.warning("fontTools is missing: the text editor previews no embedded font")
        return None
    try:
        font = TTFont(io.BytesIO(data), lazy=True)
    except Exception:
        return None  # not a font program
    try:
        return data if "cmap" in font else None
    except Exception:
        return None  # a corrupt table directory
    finally:
        font.close()
