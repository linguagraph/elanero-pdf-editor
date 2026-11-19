"""The memory figures of ``system.memory`` (W1.2 section 12, W3.9 S1): what the front end needs to
warn that the engine heap is large.

The wasm linear memory is read from Pyodide's Emscripten module (``pyodide_js._module.HEAPU8``).
It is the committed size of the heap, which only grows, so it includes MuPDF's C heap, which
``tracemalloc`` cannot see. A Pyodide release that moves that private handle makes the probe
return None: the warning is then disabled, and the host check catches the regression (R6).
"""

from __future__ import annotations

import importlib
import logging
import sys
from collections.abc import Callable

from pdfeditor.webapi import dto, limits
from pdfeditor.webapi.registry import REGISTRY

log = logging.getLogger(__name__)


def _read_heap() -> int | None:
    """The size in bytes of the wasm linear memory, or None where it cannot be read."""
    if sys.platform != "emscripten":
        return None
    try:
        # Imported here, not at module level: pyodide_js exists only under Pyodide.
        module = importlib.import_module("pyodide_js")._module
        return int(module.HEAPU8.length)
    except Exception:  # a missing or moved handle disables the warning; it never fails a call
        log.debug("the wasm heap size cannot be read", exc_info=True)
        return None


# A test seam: tests replace it to pass a value through without Pyodide.
_probe: Callable[[], int | None] = _read_heap


def wasm_heap_bytes() -> int | None:
    return _probe()


def system_memory(params: dto.Empty) -> dto.MemoryResult:
    snapshot = 0
    sessions = REGISTRY.sessions()
    for session in sessions:
        with session.lock:
            snapshot += session.undo_stack.disk_bytes
    return dto.MemoryResult(
        wasm_heap_bytes=wasm_heap_bytes(),
        heap_warn_bytes=limits.HEAP_WARN_BYTES,
        snapshot_bytes=snapshot,
        documents=len(REGISTRY),
    )
