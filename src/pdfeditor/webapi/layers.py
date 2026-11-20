"""The read-only layers call of W7.9 S3: ``layers.list``.

It mirrors the desktop's layers panel (``Document.layers()``, shown only when
``capabilities.layers`` is set) and changes nothing: no Command, no dirty flag, no page revision.
Toggling a layer's view visibility is a later slice, so this module has no setter.
"""

from __future__ import annotations

from pdfeditor.webapi import dto
from pdfeditor.webapi.registry import REGISTRY


def list_layers(params: dto.HandleParams) -> dto.LayersResult:
    session = REGISTRY.get(params.handle)
    with session.lock:
        if not session.engine.capabilities.layers:
            # Same as the desktop panel: a backend without layers shows an empty list.
            return dto.LayersResult(layers=())
        found = session.document.layers()
    return dto.LayersResult(
        layers=tuple(
            dto.LayerEntry(
                id=layer.id,
                name=layer.name,
                visible=layer.visible,
                depth=layer.depth,
                locked=layer.locked,
            )
            for layer in found
        )
    )
