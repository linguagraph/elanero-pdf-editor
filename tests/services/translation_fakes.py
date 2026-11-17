"""Helpers shared by the translation tests. The transport's Request is plain data, so headers
are looked up here, case-insensitively, the way HTTP names them."""

from __future__ import annotations

from pdfeditor.services.translation.http import Request


def header_of(request: Request, name: str, default: str | None = None) -> str | None:
    wanted = name.lower()
    for key, value in request.headers.items():
        if key.lower() == wanted:
            return value
    return default
