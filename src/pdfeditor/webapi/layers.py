"""The layer calls of W7.9: ``layers.list`` (S3, read only) and ``layers.set_visible`` (L1).

They mirror the desktop's layers panel (``Document.layers()``, shown only when
``capabilities.layers`` is set). Listing changes nothing. Setting a layer's visibility is view
state, as on the desktop: no Command, no Undo entry, no dirty flag, and nothing is saved. The
session announces every page as changed, so the reply carries ``changed`` with the new revisions.
"""

from __future__ import annotations

from pdfeditor.core.session import DocumentSession
from pdfeditor.webapi import dto
from pdfeditor.webapi.errors import REFUSED, STALE_OBJECT, RpcFailure
from pdfeditor.webapi.registry import REGISTRY

UNSUPPORTED_MESSAGE = "This document's layers can't be shown or hidden here."
LOCKED_MESSAGE = "This layer is locked and can't be shown or hidden."


def _layers_result(session: DocumentSession) -> dto.LayersResult:
    """The layers in the engine's UI order. The caller holds the session lock."""
    if not session.engine.capabilities.layers:
        # Same as the desktop panel: a backend without layers shows an empty list.
        return dto.LayersResult(layers=())
    return dto.LayersResult(
        layers=tuple(
            dto.LayerEntry(
                id=layer.id,
                name=layer.name,
                visible=layer.visible,
                depth=layer.depth,
                locked=layer.locked,
            )
            for layer in session.document.layers()
        )
    )


def list_layers(params: dto.HandleParams) -> dto.LayersResult:
    session = REGISTRY.get(params.handle)
    with session.lock:
        return _layers_result(session)


def set_layer_visible(params: dto.LayerVisibleParams) -> dto.LayersResult:
    """Show or hide one layer. Refused when the backend has no layers or the layer is locked;
    STALE_OBJECT when the id is not in the document's list (the panel's list is out of date)."""
    session = REGISTRY.get(params.handle)
    with session.lock:
        if not session.engine.capabilities.layers:
            raise RpcFailure(REFUSED, UNSUPPORTED_MESSAGE, {"reason": "layers_unsupported"})
        found = next((layer for layer in session.document.layers() if layer.id == params.id), None)
        if found is None:
            raise RpcFailure(STALE_OBJECT, "the layer is no longer in the document")
        if found.locked:
            raise RpcFailure(REFUSED, LOCKED_MESSAGE, {"reason": "layer_locked"})
        session.set_layer_visible(params.id, params.visible)
        return _layers_result(session)
