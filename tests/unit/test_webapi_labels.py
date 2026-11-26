"""Page labels on the web (Organize, slice 1): the read call and the set through ``actions.run``.

``session.label_rules`` returns the document's rules, so a save from the Page labels dialog does
not wipe rules the document already has. ``pages.set_labels`` refuses bad rules as ``REFUSED``
with ``details.reason``, the same guard the desktop's dialog relies on.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest

from pdfeditor.model import platform as model_platform
from pdfeditor.webapi.platform import configure_web
from pdfeditor.webapi.registry import REGISTRY
from tests.unit.test_webapi_crop import call, error, ok, open_data, run


@pytest.fixture
def web() -> Iterator[None]:
    previous = model_platform.current()
    configure_web()
    try:
        yield
    finally:
        REGISTRY.close_all()
        model_platform.configure(previous)


def label_rules(handle: str) -> list[dict[str, Any]]:
    return list(ok(call("session.label_rules", {"handle": handle}))["rules"])


def rule(start: int, style: str = "D", prefix: str = "", first: int = 1) -> dict[str, Any]:
    return {"start": start, "style": style, "prefix": prefix, "first": first}


def test_label_rules_reads_the_four_rules_of_the_fixture(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("page_labels").read_bytes(), "labels.pdf")
    assert label_rules(handle) == [
        rule(0, "r"),
        rule(2, "D", "A-"),
        rule(5, "", "Cover"),
        rule(6, "A", first=26),
    ]


def test_label_rules_is_empty_for_a_document_without_labels(web: None, fixture_pdf: Any) -> None:
    handle = open_data(fixture_pdf("text_multipage").read_bytes(), "text.pdf")
    assert label_rules(handle) == []


def test_set_labels_through_actions_run_then_the_read_call_shows_them(
    web: None, fixture_pdf: Any
) -> None:
    handle = open_data(fixture_pdf("text_multipage").read_bytes(), "text.pdf")
    args = {"rules": [rule(0, "a", "P-", 3)]}
    result = ok(run(handle, "pages.set_labels", args))
    assert result["executed"] is True
    assert label_rules(handle) == [rule(0, "a", "P-", 3)]
    assert ok(call("session.pages", {"handle": handle}))["labels"][0] == "P-c"


@pytest.mark.parametrize(
    ("rules", "reason"),
    [
        ([rule(-1)], "invalid_pages"),
        ([rule(99)], "invalid_pages"),
        ([rule(0, first=0)], "invalid_label"),
        ([rule(0), rule(0, "r")], "duplicate_label_start"),
    ],
)
def test_set_labels_refuses_bad_rules_and_changes_nothing(
    web: None, fixture_pdf: Any, rules: list[dict[str, Any]], reason: str
) -> None:
    handle = open_data(fixture_pdf("page_labels").read_bytes(), "labels.pdf")
    before = label_rules(handle)
    reply = error(run(handle, "pages.set_labels", {"rules": rules}))
    assert reply["code"] == "REFUSED"
    assert reply["details"]["reason"] == reason
    assert label_rules(handle) == before
