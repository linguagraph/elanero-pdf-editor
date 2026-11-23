"""The font picker's standard fonts through the web's paragraph edit (W6.8b slice 2, design
section 9): ``content.replace_text`` with a ``standard`` font ref, as the style bar sends it.

A standard font is a base-14 face the engine embeds, so the saved file carries it and the text
shows in every reader. A character the face lacks (Cyrillic in Times) is reported in ``missing``
and the edit still saves.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.hostcheck import record
from tests.unit.test_webapi_jobs import call, ok, open_data
from tests.unit.test_webapi_save import saved_bytes
from tests.unit.test_webapi_text_edit import EDITED, heading_of, objects_of

BLACK = {"r": 0, "g": 0, "b": 0, "a": 1}


def times_style(font: str = "Times-Roman") -> dict[str, Any]:
    """The style the bar sends for a standard Times font (the picker's ref, as JSON)."""
    return {
        "font": font,
        "font_ref": {"kind": "standard", "name": font, "path": "", "index": 0},
        "size": 12.0,
        "color": BLACK,
        "bold": False,
        "italic": False,
        "align": "left",
        "line_height": 1.2,
        "char_spacing": 0.0,
        "word_spacing": 0.0,
    }


@pytest.fixture
def web() -> Iterator[None]:
    previous = model_platform.current()
    configure_web()
    try:
        yield
    finally:
        REGISTRY.close_all()
        model_platform.configure(previous)


def replace_with_style(handle: str, text: str, style: dict[str, Any]) -> dict[str, Any]:
    listed = objects_of(handle)
    args = {
        "object": {"page": 0, "key": heading_of(handle)["key"], "revision": listed["revision"]},
        "text": text,
        "style": style,
    }
    return call("actions.run", {"handle": handle, "name": "content.replace_text", "args": args})


def test_a_standard_font_sets_the_text_and_saves_with_it(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    reply = ok(replace_with_style(handle, EDITED, times_style()))

    value = reply["value"]
    assert isinstance(value, dict)
    assert value["substituted"] is False
    assert value["missing"] == ""
    _, saved = saved_bytes(handle, "copy")
    record("opens_pikepdf", saved)
    record("text_contains_pdfium", saved, page=0, text=EDITED)


def test_a_standard_font_without_the_characters_reports_them_and_still_saves(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    # The base-14 faces have Latin, Greek and Cyrillic but no CJK, so CJK is what they lack.
    reply = ok(replace_with_style(handle, "中文 Qwerty", times_style()))

    value = reply["value"]
    assert isinstance(value, dict)
    # The notice names the characters (design section 5.1, row 3).
    assert value["substituted"] is True
    assert set("中文") <= set(value["missing"])
    _, saved = saved_bytes(handle, "copy")
    record("opens_pikepdf", saved)
    record("text_contains_pdfium", saved, page=0, text="Qwerty")
