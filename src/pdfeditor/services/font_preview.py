"""Preview copies of embedded font programs for the text editor (W6.8a).

This module ships in the web package, so it must import without fontTools: fontTools is loaded
lazily, inside the function, and the web worker loads it before the first text edit (see
web/app/src/engine/loader.ts). Without fontTools the copy is refused, and the caller falls back.
"""

from __future__ import annotations

import io


def private_copy(font_data: bytes, family: str) -> bytes:
    """``font_data`` renamed to ``family``, or ``b""`` when it can't be rewritten.

    An embedded program keeps its family name ("Arial"). Registered under that name it would
    replace the installed font of the same name everywhere in the app, often with only the
    few glyphs the PDF used, so other text would show with the wrong metrics or no glyphs.
    """
    try:
        from fontTools.ttLib import TTFont  # lazy: the web worker loads fontTools on demand

        font = TTFont(io.BytesIO(font_data))
        if "cmap" not in font:
            # MuPDF drops the cmap when it subsets on save (the PDF maps codes to glyphs
            # itself): Qt couldn't map a single character, and would draw a fallback font
            font.close()
            return b""
        names = font["name"]
        for record in list(names.names):
            if record.nameID in (1, 3, 4, 6, 16, 17, 21, 22):
                names.removeNames(nameID=record.nameID)
        names.setName(family, 1, 3, 1, 0x409)
        names.setName("Regular", 2, 3, 1, 0x409)
        names.setName(family, 3, 3, 1, 0x409)
        names.setName(family, 4, 3, 1, 0x409)
        names.setName(family.replace(" ", ""), 6, 3, 1, 0x409)
        out = io.BytesIO()
        font.save(out)
        font.close()
        return out.getvalue()
    except Exception:
        return b""  # a program fontTools can't rewrite (or fontTools is absent) is not registered
