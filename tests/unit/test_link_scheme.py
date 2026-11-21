"""The link scheme allow-list shared by the desktop and the web app (W5.3)."""

from __future__ import annotations

import pytest

from pdfeditor.model.link_scheme import is_allowed_link, link_scheme


@pytest.mark.parametrize(
    "uri",
    ["https://example.org/", "HTTP://EXAMPLE.ORG", "mailto:a@example.org", "  https://x.org  "],
)
def test_web_and_mail_links_are_allowed(uri: str) -> None:
    assert is_allowed_link(uri)


@pytest.mark.parametrize(
    "uri",
    [
        "javascript:alert(1)",
        "JaVaScRiPt:x",
        "java\tscript:x",
        "java\nscript:x",
        "data:text/html,x",
        "file:///C:/x.exe",
        "vbscript:x",
        "ftp://example.org/",
        "intent://x",
        "www.example.org",
        "",
        "   ",
    ],
)
def test_other_schemes_and_addresses_without_one_are_blocked(uri: str) -> None:
    assert not is_allowed_link(uri)


def test_scheme_is_read_the_way_a_browser_reads_it() -> None:
    assert link_scheme("java\tscript:x") == "javascript"
    assert link_scheme("MailTo:a@example.org") == "mailto"
    assert link_scheme("no scheme here") == ""
