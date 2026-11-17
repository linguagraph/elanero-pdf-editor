"""W0.2 measurement harness: the Python the perf workers call (spike only).

Each function returns JSON text, so the worker keeps the numbers and the browser never touches a
Python object. Times are wall-clock milliseconds from ``time.perf_counter``. The worker and the
main thread are driven by ``perf/index.html``; this file only does the engine work.
"""

import gc
import importlib
import json
import random
import sys
import time
from pathlib import Path

SEARCH_NEEDLE = "consequat"  # one LOREM word: on every page of every mixed fixture
RANDOM_SEED = 20261117  # fixed, so every run and every browser renders the same page sequence
_state: dict[str, object] = {}


def _ms(start: float) -> float:
    return round((time.perf_counter() - start) * 1000, 3)


def import_pdfeditor(zip_path: str) -> str:
    """Put the trimmed pdfeditor zip on sys.path and import the engine's front door."""
    start = time.perf_counter()
    sys.path.insert(0, zip_path)
    for name in ("pdfeditor.core.session", "pdfeditor.engine.registry"):
        importlib.import_module(name)

    return json.dumps({"ms": _ms(start)})


def engine_ready() -> str:
    """The first ``get_engine()`` call imports the PyMuPDF backend (the wheel must be loaded)."""
    from pdfeditor.engine.registry import get_engine

    start = time.perf_counter()
    engine = get_engine()
    _state["engine"] = engine
    import pymupdf

    return json.dumps({"ms": _ms(start), "pymupdf": str(pymupdf.VersionBind)})


def open_doc(path: str) -> str:
    """Open the fixture (bytes already written to the Pyodide file system) and start a session."""
    from pdfeditor.core.session import DocumentSession
    from pdfeditor.services.text import TextIndexCache

    engine = _state["engine"]
    data = Path(path).read_bytes()
    start = time.perf_counter()
    doc = engine.open(data)  # type: ignore[attr-defined]
    open_ms = _ms(start)
    session = DocumentSession(doc, engine)  # type: ignore[arg-type]
    _state.update(doc=doc, session=session, cache=TextIndexCache(session))
    return json.dumps({"ms": open_ms, "pages": doc.page_count, "bytes": len(data)})


def render(index: int, scale: float, out_path: str) -> str:
    """Render one page at ``scale`` (RGBA, the app's default). Writes the samples to ``out_path``
    as tightly packed rows (width * 4 bytes each) so the browser can wrap them in ImageData."""
    from pdfeditor.engine.base import RenderRequest
    from pdfeditor.model.geometry import Matrix

    doc = _state["doc"]
    request = RenderRequest(matrix=Matrix.scale(scale))
    start = time.perf_counter()
    result = doc.page(index).render(request)  # type: ignore[attr-defined]
    ms = _ms(start)
    samples = result.samples
    row = result.width * 4
    if result.stride != row:
        samples = b"".join(
            samples[r * result.stride : r * result.stride + row] for r in range(result.height)
        )
    Path(out_path).write_bytes(samples)
    return json.dumps({"ms": ms, "width": result.width, "height": result.height})


def text_page(index: int) -> str:
    doc = _state["doc"]
    start = time.perf_counter()
    doc.page(index).text_page()  # type: ignore[attr-defined]
    return json.dumps({"ms": _ms(start)})


def search(needle: str = SEARCH_NEEDLE) -> str:
    from pdfeditor.services.search import SearchQuery, search_document

    cache = _state["cache"]
    start = time.perf_counter()
    hits = search_document(cache, SearchQuery(needle))  # type: ignore[arg-type]
    return json.dumps({"ms": _ms(start), "hits": len(hits), "needle": needle})


def save() -> str:
    doc = _state["doc"]
    start = time.perf_counter()
    data = doc.to_bytes()  # type: ignore[attr-defined]
    return json.dumps({"ms": _ms(start), "bytes": len(data)})


def close() -> str:
    """Close the session and the document, then run a full collection (M7 after close)."""
    session = _state.pop("session", None)
    _state.pop("cache", None)
    _state.pop("doc", None)
    start = time.perf_counter()
    if session is not None:
        session.close()  # type: ignore[attr-defined]
    del session
    close_ms = _ms(start)
    start = time.perf_counter()
    collected = gc.collect()
    return json.dumps({"closeMs": close_ms, "gcMs": _ms(start), "collected": collected})


def plan_pages(count: int) -> str:
    """M5's page sequence: pages 1-10 in order, then 20 random pages (fixed seed, with
    replacement). A document shorter than 10 pages repeats its pages."""
    first = [i % count for i in range(10)] if count else []
    rng = random.Random(RANDOM_SEED)
    later = [rng.randrange(count) for _ in range(20)] if count else []
    return json.dumps({"first": first, "random": later})
