"""W0.1 browser smoke: the Python the worker runs (spike only; never imported by the app).

Six steps on the generated text fixture, through the real engine (``get_engine()``): open,
render page 0, replace the first text block, add a highlight, save to bytes, reopen the bytes and
check the edit and the highlight survived. Each step is timed. A failing step stops the run and
is reported with its error; the worker and the Playwright test both read the JSON this returns.
"""

import json
import time
from pathlib import Path

import pymupdf

from pdfeditor.engine.base import RenderRequest
from pdfeditor.engine.registry import get_engine
from pdfeditor.model.annotations import AnnotationModel, AnnotationType
from pdfeditor.model.color import Color
from pdfeditor.model.geometry import Quad
from pdfeditor.model.objects import ObjectType

EDITED = "Elanero web smoke"
STEP_NAMES = ["open", "render", "edit", "annotate", "save", "reopen"]


def run(input_path: str, output_path: str) -> str:
    ctx: dict[str, object] = {}
    steps: list[dict[str, object]] = []

    def step(name: str, fn: object) -> bool:
        started = time.perf_counter()
        try:
            detail = fn() or {}  # type: ignore[operator]
            ok, error = True, None
        except Exception as exc:  # the run reports the failure; it never raises into the worker
            detail, ok, error = {}, False, f"{type(exc).__name__}: {exc}"
        steps.append(
            {
                "step": name,
                "ok": ok,
                "ms": round((time.perf_counter() - started) * 1000, 1),
                "error": error,
                **detail,  # type: ignore[dict-item]
            }
        )
        return ok

    def open_doc() -> dict[str, object]:
        data = Path(input_path).read_bytes()
        ctx["engine"] = get_engine()
        ctx["doc"] = ctx["engine"].open(data)  # type: ignore[attr-defined]
        return {"bytes": len(data), "pages": ctx["doc"].page_count}  # type: ignore[attr-defined]

    def render() -> dict[str, object]:
        page = ctx["doc"].page(0)  # type: ignore[attr-defined]
        result = page.render(RenderRequest())
        samples = result.samples
        if len(samples) != result.height * result.stride:
            raise AssertionError("render returned a buffer of the wrong size")
        non_white = len(samples) - samples.count(255)
        if non_white == 0:
            raise AssertionError("rendered page 0 is blank")
        return {"width": result.width, "height": result.height, "nonWhiteBytes": non_white}

    def edit() -> dict[str, object]:
        page = ctx["doc"].page(0)  # type: ignore[attr-defined]
        target = next(o for o in page.content_objects() if o.type is ObjectType.TEXT and o.editable)
        ctx["bbox"] = target.bbox
        page.replace_text(target.key, EDITED)
        return {"replacedChars": len(target.text), "original": target.text[:60]}

    def annotate() -> dict[str, object]:
        page = ctx["doc"].page(0)  # type: ignore[attr-defined]
        bbox = ctx["bbox"]
        model = AnnotationModel(
            AnnotationType.HIGHLIGHT,
            0,
            bbox,
            quads=(Quad.from_rect(bbox),),  # type: ignore[arg-type]
            color=Color(1, 1, 0),
        )
        added = page.add_annotation(model)
        return {"annotationId": added.id}

    def save() -> dict[str, object]:
        data = ctx["doc"].to_bytes()  # type: ignore[attr-defined]
        Path(output_path).write_bytes(data)
        return {"bytes": len(data)}

    def reopen() -> dict[str, object]:
        data = Path(output_path).read_bytes()
        doc = ctx["engine"].open(data)  # type: ignore[attr-defined]
        page = doc.page(0)
        text = page.text_page().text
        highlights = [a for a in page.annotations() if a.type is AnnotationType.HIGHLIGHT]
        if EDITED not in text:
            raise AssertionError(f"edited text not found after reopen: {text[:80]!r}")
        if not highlights:
            raise AssertionError("highlight annotation not found after reopen")
        return {"editedTextFound": True, "highlights": len(highlights)}

    for name, fn in zip(STEP_NAMES, [open_doc, render, edit, annotate, save, reopen], strict=True):
        if not step(name, fn):
            break

    return json.dumps(
        {
            "ok": len(steps) == len(STEP_NAMES) and all(s["ok"] for s in steps),
            "steps": steps,
            "pymupdf": str(pymupdf.VersionBind),
            "mupdf": _mupdf_version(),
        }
    )


def _mupdf_version() -> str:
    try:
        return str(pymupdf.TOOLS.mupdf_version())
    except Exception as exc:
        return f"unknown ({exc})"
