"""The web's paragraph edit (W6.8a 8a-1): ``content.replace_text`` through ``actions.run``, as the
web's editor sends it (``style: null``, a JSON ObjectRef, the revision the list was read at).

Each commit is one step: it is saved, and the saved file is checked with the host checks
(pikepdf reads the structure, pypdfium2 finds the text), then undone. A stale ref is refused and
changes nothing.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.webapi.errors import STALE_OBJECT
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.hostcheck import record
from tests.unit.test_webapi_jobs import call, error, ok, open_data
from tests.unit.test_webapi_save import saved_bytes

HEADING = "Mixed content heading"
EDITED = "Edited through the web."


@pytest.fixture
def web() -> Iterator[None]:
    previous = model_platform.current()
    configure_web()
    try:
        yield
    finally:
        REGISTRY.close_all()
        model_platform.configure(previous)


def objects_of(handle: str) -> dict[str, Any]:
    return ok(call("content.objects", {"handle": handle, "page": 0}))


def text_objects(handle: str) -> list[dict[str, Any]]:
    return [o for o in objects_of(handle)["objects"] if o["type"] == "text"]


def heading_of(handle: str) -> dict[str, Any]:
    return next(o for o in text_objects(handle) if HEADING in o["text"])


def revision_of(handle: str) -> int:
    session = REGISTRY.get(handle)
    with session.lock:
        return int(session.document.page(0).revision)


def replace(handle: str, obj: dict[str, Any], revision: int, text: str) -> dict[str, Any]:
    args = {
        "object": {"page": 0, "key": obj["key"], "revision": revision},
        "text": text,
        "style": None,
    }
    return call("actions.run", {"handle": handle, "name": "content.replace_text", "args": args})


def test_an_edited_paragraph_saves_and_reopens_with_its_new_text(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    listed = objects_of(handle)
    reply = ok(replace(handle, heading_of(handle), listed["revision"], EDITED))

    assert reply["executed"] is True
    assert reply["label"] == "Edit Text"
    _, saved = saved_bytes(handle, "copy")
    record("opens_pikepdf", saved)
    record("text_contains_pdfium", saved, page=0, text=EDITED)
    record("text_lacks_pdfium", saved, page=0, text=HEADING)


def test_a_replaced_font_reply_names_the_font_and_is_not_a_substitution(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    reply = ok(replace(handle, heading_of(handle), objects_of(handle)["revision"], EDITED))

    value = reply["value"]
    assert isinstance(value, dict)
    assert value["substituted"] is False
    assert value["missing"] == ""
    assert isinstance(value["name"], str) and value["name"]


def test_a_character_the_subset_font_lacks_is_reported_and_still_saves(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_data(fixture_pdf("subset_fonts").read_bytes(), "subset.pdf")
    block = text_objects(handle)[0]
    text = "Ünïcødé €"
    reply = ok(replace(handle, block, objects_of(handle)["revision"], text))

    value = reply["value"]
    assert isinstance(value, dict)
    assert value["substituted"] is True
    # `missing` names the characters only for a requested font_ref, which 8a never sends, so the
    # web's notice carries the font's name alone.
    assert value["missing"] == ""
    assert value["name"]
    _, saved = saved_bytes(handle, "copy")
    record("opens_pikepdf", saved)
    record("text_contains_pdfium", saved, page=0, text="Ünïcødé")


def test_a_stale_ref_is_refused_and_the_document_is_unchanged(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    heading = heading_of(handle)
    old = objects_of(handle)["revision"]
    # A move of the page after the list was read makes the editor's ref stale.
    moved = ok(
        call(
            "actions.run",
            {
                "handle": handle,
                "name": "content.transform",
                "args": {
                    "objects": [{"page": 0, "key": heading["key"], "revision": old}],
                    "matrix": {"a": 1.0, "b": 0.0, "c": 0.0, "d": 1.0, "e": 0.0, "f": 20.0},
                    "resize": False,
                },
            },
        )
    )
    before_text = [o["text"] for o in text_objects(handle)]
    before_revision = revision_of(handle)
    before_undo = moved["state"]["history"]

    reply = replace(handle, heading, old, EDITED)

    assert error(reply)["code"] == STALE_OBJECT
    assert revision_of(handle) == before_revision
    assert [o["text"] for o in text_objects(handle)] == before_text
    # The refused step left no undo entry: the newest step is still the move.
    assert ok(call("actions.undo", {"handle": handle, "expect_history": before_undo}))["done"]


def test_undo_puts_the_original_paragraph_back(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    reply = ok(replace(handle, heading_of(handle), objects_of(handle)["revision"], EDITED))
    ok(call("actions.undo", {"handle": handle, "expect_history": reply["state"]["history"]}))

    texts = [o["text"] for o in text_objects(handle)]
    assert any(HEADING in text for text in texts)
    assert not any(EDITED in text for text in texts)
    _, saved = saved_bytes(handle, "copy")
    record("text_contains_pdfium", saved, page=0, text=HEADING)
