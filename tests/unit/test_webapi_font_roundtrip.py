"""The uploaded-font round trip (W6.9 slice 2b): ``fonts.add``, a text edit that names the stored
face, save, reopen, and the host checks (pikepdf reads the structure, pypdfium2 finds the text).

It runs only under Pyodide: the engine reads the stored font from the worker's ``/fonts`` folder
(MEMFS), which a desktop run does not have, so the test is skipped on the desktop. The store is
the default one here, not a temporary folder, and every font the test adds is removed after it.
"""

from __future__ import annotations

import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.webapi import fontstore
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.hostcheck import record
from tests.unit.test_webapi_jobs import call, ok, open_data
from tests.unit.test_webapi_save import saved_bytes
from tests.unit.test_webapi_text_edit import heading_of, objects_of

pytestmark = pytest.mark.skipif(
    sys.platform != "emscripten", reason="the engine reads the worker's /fonts (Pyodide only)"
)

FONTS = Path(__file__).resolve().parents[1] / "fixtures" / "generated" / "fonts"
# The fixture face maps only A, B, C, a, b and c, so the edited text uses those letters. Its
# family is "Test Sans" (the PDF's BaseFont has the subset tag and no spaces).
SANS = "TestSans-Regular.ttf"
EDITED = "Abc Cab"


@pytest.fixture(autouse=True)
def default_store() -> Iterator[None]:
    fontstore.use_root(None)  # the worker's own store, at /fonts
    try:
        yield
    finally:
        for font in ok(call("fonts.list", {}))["fonts"]:
            ok(call("fonts.remove", {"id": font["id"]}))
        fontstore.use_root(None)


@pytest.fixture
def web() -> Iterator[None]:
    previous = model_platform.current()
    configure_web()
    try:
        yield
    finally:
        REGISTRY.close_all()
        model_platform.configure(previous)


def test_an_uploaded_font_saves_and_reopens_with_the_edited_text(
    web: None, fixture_pdf: Any
) -> None:
    data = (FONTS / SANS).read_bytes()
    added = ok(call("fonts.add", {"name": SANS, "data": {"$bin": 0}}, [data]))
    face = added["font"]["faces"][0]

    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    heading = heading_of(handle)
    style = dict(heading["style"]) if heading.get("style") else {}
    style["font_ref"] = {
        "kind": "file",
        "name": "Test Sans",
        "path": added["font"]["path"],
        "index": face["index"],
    }
    args = {
        "object": {
            "page": 0,
            "key": heading["key"],
            "revision": objects_of(handle)["revision"],
        },
        "text": EDITED,
        "style": style,
    }
    reply = ok(
        call("actions.run", {"handle": handle, "name": "content.replace_text", "args": args})
    )

    assert reply["executed"] is True
    assert reply["value"]["substituted"] is False  # the stored face covers the text
    _, saved = saved_bytes(handle, "copy")
    record("opens_pikepdf", saved)
    record("font_embedded_family_pikepdf", saved, family="Test Sans")
    record("text_contains_pdfium", saved, page=0, text=EDITED)
