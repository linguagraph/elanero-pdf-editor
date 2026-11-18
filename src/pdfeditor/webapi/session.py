"""The session calls of W3.2: open, close, info, pages, capabilities and unlock_owner.

The limits are read from :mod:`pdfeditor.webapi.limits` at call time, so tests can change them.
The open password is kept by the registry only while the document is open; it never goes into a
reply, a log or an error message.
"""

from __future__ import annotations

import dataclasses

from pdfeditor.core.engine_lock import ENGINE_LOCK
from pdfeditor.core.session import DocumentSession
from pdfeditor.engine.base import Page, PasswordRequired
from pdfeditor.model.metadata import EncryptionMethod
from pdfeditor.model.platform import current as platform_current
from pdfeditor.webapi import dto, limits
from pdfeditor.webapi.errors import (
    FILE_TOO_LARGE,
    PASSWORD_REQUIRED,
    TOO_MANY_PAGES,
    WRONG_PASSWORD,
    RpcFailure,
)
from pdfeditor.webapi.platform import WEB_SNAPSHOT_BUDGET
from pdfeditor.webapi.registry import REGISTRY


def open_document(params: dto.OpenParams) -> dto.OpenResult:
    size = len(params.data)  # checked before anything reads the bytes
    if size > limits.FILE_REFUSE_BYTES:
        raise RpcFailure(
            FILE_TOO_LARGE,
            "the file is too large for the browser",
            {"max_bytes": limits.FILE_REFUSE_BYTES, "size": size},
        )
    warning = None
    if size > limits.FILE_WARN_BYTES:
        warning = "the file is large; opening and editing may be slow"
    try:
        with ENGINE_LOCK:
            session = DocumentSession.open(
                params.data, params.password, snapshot_budget=WEB_SNAPSHOT_BUDGET
            )
    except PasswordRequired:
        # The engine raises the same class for a missing and a wrong password; only the
        # caller knows which one was sent.
        if params.password is None:
            raise RpcFailure(PASSWORD_REQUIRED, "the file is password protected") from None
        raise RpcFailure(WRONG_PASSWORD, "the password is wrong") from None
    session.name_hint = params.name
    with session.lock:
        pages = session.document.page_count
    if pages > limits.MAX_PAGES:
        session.close()
        raise RpcFailure(
            TOO_MANY_PAGES,
            "the file has too many pages for the browser",
            {"max_pages": limits.MAX_PAGES, "pages": pages},
        )
    handle = REGISTRY.open(session, params.password)
    return dto.OpenResult(handle=handle, info=_info(session), pages=pages, warning=warning)


def close_document(params: dto.HandleParams) -> dto.Empty:
    REGISTRY.close(params.handle)
    return dto.Empty()


def document_info(params: dto.HandleParams) -> dto.DocInfo:
    return _info(REGISTRY.get(params.handle))


def document_pages(params: dto.HandleParams) -> dto.PagesResult:
    session = REGISTRY.get(params.handle)
    with session.lock:
        document = session.document
        sizes = tuple(_page_size(document.page(i)) for i in range(document.page_count))
    return dto.PagesResult(pages=sizes)


def document_capabilities(params: dto.HandleParams) -> dto.CapabilitiesResult:
    session = REGISTRY.get(params.handle)
    engine = {
        name: bool(value) for name, value in dataclasses.asdict(session.engine.capabilities).items()
    }
    platform = dto.PlatformFlags(**dataclasses.asdict(platform_current()))
    return dto.CapabilitiesResult(engine=engine, platform=platform)


def unlock_owner(params: dto.UnlockParams) -> dto.UnlockResult:
    session = REGISTRY.get(params.handle)
    with session.lock:
        unlocked = session.document.unlock_owner(params.password)
    return dto.UnlockResult(unlocked=unlocked)


def _info(session: DocumentSession) -> dto.DocInfo:
    with session.lock:
        info = session.document.info()
        metadata = session.document.metadata()
    return dto.DocInfo(
        encrypted=info.encryption is not EncryptionMethod.NONE,
        has_signatures=info.has_signatures,
        page_count=info.page_count,
        title=metadata.title,
    )


def _page_size(page: Page) -> dto.PageSize:
    # rect is in visible space (points, after /Rotate and the CropBox), as everywhere above
    # the engine.
    return dto.PageSize(width=page.rect.width, height=page.rect.height, rotation=page.rotation)
