"""Which link addresses the app may open: the scheme allow-list (W5.3).

The web app and the desktop share it. A PDF can carry any address in a link, so only the schemes
below open, and only after the user agrees. Everything else (javascript:, file:, data:, custom
app schemes) is refused. The scheme is read the way a browser reads it: tabs and line breaks are
dropped first, the scheme is lower-cased, and an address with no scheme gives "".
"""

from __future__ import annotations

import re

ALLOWED_LINK_SCHEMES: frozenset[str] = frozenset({"http", "https", "mailto"})

_SCHEME = re.compile(r"^([A-Za-z][A-Za-z0-9+.-]*):")
# The ASCII whitespace and control characters a URL parser strips at the ends of an address.
_EDGE = "".join(chr(code) for code in range(0x21))


def link_scheme(uri: str) -> str:
    """The lower-cased scheme of a link address, or "" when it has none."""
    cleaned = uri.replace("\t", "").replace("\n", "").replace("\r", "").strip(_EDGE)
    match = _SCHEME.match(cleaned)
    return match.group(1).lower() if match else ""


def is_allowed_link(uri: str) -> bool:
    """Whether a link address may be offered to the user to open."""
    return link_scheme(uri) in ALLOWED_LINK_SCHEMES
