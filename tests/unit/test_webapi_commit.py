"""The web's edit commits (W6.7a S5): content.transform and content.delete through actions.run.

Each test edits through the same dispatch the web uses, then saves and checks the file with the
host checks: pikepdf reads the structure, pypdfium2 renders the page (``tests.hostcheck.record``).
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

# The image of mixed_content sits at (420, 80)-(540, 180) in visible points, top-left origin.
IMAGE_BOX = [420.0, 80.0, 540.0, 180.0]
MOVED_BOX = [420.0, 380.0, 540.0, 480.0]


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


def find(handle: str, kind: str) -> dict[str, Any]:
    return next(o for o in objects_of(handle)["objects"] if o["type"] == kind)


def ref(obj: dict[str, Any], revision: int) -> dict[str, Any]:
    return {"page": 0, "key": obj["key"], "revision": revision}


def transform(handle: str, refs: list[dict[str, Any]], dx: float, dy: float) -> dict[str, Any]:
    args = {
        "objects": refs,
        "matrix": {"a": 1.0, "b": 0.0, "c": 0.0, "d": 1.0, "e": dx, "f": dy},
        "resize": False,
    }
    return call("actions.run", {"handle": handle, "name": "content.transform", "args": args})


def revision_of(handle: str) -> int:
    session = REGISTRY.get(handle)
    with session.lock:
        return int(session.document.page(0).revision)


def test_a_moved_image_is_gone_from_its_place_and_drawn_at_the_new_one(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    image = find(handle, "image")
    reply = transform(handle, [ref(image, objects_of(handle)["revision"])], 0.0, 300.0)
    assert ok(reply)["executed"] is True

    moved = find(handle, "image")
    assert moved["bbox"]["y0"] == pytest.approx(MOVED_BOX[1], abs=0.5)

    _, saved = saved_bytes(handle, "copy")
    record("opens_pikepdf", saved)
    record("blank_region_pdfium", saved, page=0, clip=IMAGE_BOX)
    record("ink_region_pdfium", saved, page=0, clip=MOVED_BOX)


def test_a_deleted_heading_is_gone_from_the_saved_file(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    heading = next(o for o in objects_of(handle)["objects"] if "Mixed content heading" in o["text"])
    reply = call(
        "actions.run",
        {
            "handle": handle,
            "name": "content.delete",
            "args": {"objects": [ref(heading, objects_of(handle)["revision"])]},
        },
    )
    assert ok(reply)["executed"] is True

    _, saved = saved_bytes(handle, "copy")
    record("opens_pikepdf", saved)
    record("text_lacks_pdfium", saved, page=0, text="Mixed content heading")


def test_a_stale_ref_is_refused_and_changes_nothing(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    image = find(handle, "image")
    old = objects_of(handle)["revision"]
    ok(transform(handle, [ref(image, old)], 0.0, 300.0))
    before = revision_of(handle)

    # The ref was taken before the first move: the page changed, so the engine refuses it.
    reply = transform(handle, [ref(image, old)], 0.0, 50.0)
    assert error(reply)["code"] == STALE_OBJECT
    assert revision_of(handle) == before
    assert find(handle, "image")["bbox"]["y0"] == pytest.approx(MOVED_BOX[1], abs=0.5)


def test_undo_puts_the_moved_image_back(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("mixed_content").read_bytes(), "mixed.pdf")
    image = find(handle, "image")
    run = ok(transform(handle, [ref(image, objects_of(handle)["revision"])], 0.0, 300.0))
    assert run["executed"] is True
    ok(call("actions.undo", {"handle": handle, "expect_history": run["state"]["history"]}))

    assert find(handle, "image")["bbox"]["y0"] == pytest.approx(IMAGE_BOX[1], abs=0.5)
    _, saved = saved_bytes(handle, "copy")
    record("blank_region_pdfium", saved, page=0, clip=MOVED_BOX)
    record("ink_region_pdfium", saved, page=0, clip=IMAGE_BOX)
