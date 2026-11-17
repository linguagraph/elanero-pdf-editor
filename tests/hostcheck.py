"""Host checks: the pikepdf and pypdfium2 assertions that the Pyodide run cannot make.

Pyodide has no pikepdf or pypdfium2, so a test cannot assert with them there. The test declares
its assertion here as a named check and calls ``record`` with the saved file:

- on desktop (CPython) the check runs at once, so the assertion is the same as before;
- under Pyodide the saved bytes and the check's arguments are recorded, and
  ``scripts/web_host_verify.py`` replays them on host CPython in the same CI job.

Nothing here imports pikepdf or pypdfium2 at module level: each check imports what it uses, so
this module imports fine under Pyodide.
"""

from __future__ import annotations

import base64
import io
import json
import os
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

CheckFn = Callable[..., None]

HOST_CHECKS: dict[str, CheckFn] = {}
_RECORDED: list[dict[str, Any]] = []


def host_check(name: str) -> Callable[[CheckFn], CheckFn]:
    """Register the decorated function as the host check ``name``. Names are unique."""

    def register(func: CheckFn) -> CheckFn:
        if name in HOST_CHECKS:
            raise ValueError(f"duplicate host check: {name}")
        HOST_CHECKS[name] = func
        return func

    return register


def in_pyodide() -> bool:
    return sys.platform == "emscripten"


def record(name: str, data: bytes | Path, **args: Any) -> None:
    """Run host check ``name`` on ``data`` (desktop), or record it for the host replay (Pyodide).

    The name and the arguments are validated in both modes, so a typo or a value that cannot be
    recorded fails in the desktop run, not only in the Pyodide run.
    """
    if name not in HOST_CHECKS:
        raise KeyError(f"unknown host check: {name}")
    try:
        encoded = json.dumps(args, sort_keys=True)
    except TypeError as exc:
        raise TypeError(f"host check {name}: arguments must be JSON-serialisable: {exc}") from exc
    raw = data.read_bytes() if isinstance(data, Path) else data
    if not in_pyodide():
        HOST_CHECKS[name](raw, **args)
        return
    _RECORDED.append(
        {
            "name": name,
            "args": encoded,
            "data_b64": base64.b64encode(raw).decode("ascii"),
            "test": os.environ.get("PYTEST_CURRENT_TEST", ""),
        }
    )


def recorded() -> list[dict[str, Any]]:
    return list(_RECORDED)


def clear() -> None:
    _RECORDED.clear()


# -- saved-file checks ---------------------------------------------------------------------------


@host_check("page_count_pikepdf")
def _page_count_pikepdf(data: bytes, pages: int, password: str = "") -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data), password=password) as pdf:
        assert len(pdf.pages) == pages


@host_check("page_count_pdfium")
def _page_count_pdfium(data: bytes, pages: int, password: str = "") -> None:
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(data, password=password or None)
    assert len(doc) == pages
    doc.close()


@host_check("opens_pdfium")
def _opens_pdfium(data: bytes) -> None:
    import pypdfium2 as pdfium

    pd = pdfium.PdfDocument(data)
    pd.close()


@host_check("text_contains_pdfium")
def _text_contains_pdfium(data: bytes, page: int, text: str) -> None:
    import pypdfium2 as pdfium

    pd = pdfium.PdfDocument(data)
    assert text in pd[page].get_textpage().get_text_range()
    pd.close()


def _objgens(items: Any) -> set[tuple[int, int]]:
    return {o.objgen for o in items}


def _contents(page: Any) -> set[tuple[int, int]]:
    import pikepdf

    contents = page.obj.Contents
    return _objgens(contents) if isinstance(contents, pikepdf.Array) else {contents.objgen}


@host_check("duplicate_objects_pikepdf")
def _duplicate_objects_pikepdf(data: bytes) -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        first, second = pdf.pages
        assert first.objgen != second.objgen
        assert not _contents(first) & _contents(second)
        assert not _objgens(first.obj.Annots) & _objgens(second.obj.Annots)
        for page in (first, second):
            for annot in page.obj.Annots:
                assert "/P" not in annot or annot.P.objgen == page.objgen
                if "/Popup" in annot:  # the popup pairs up within the same page
                    assert annot.Popup.objgen in _objgens(page.obj.Annots)
                    assert annot.Popup.Parent.objgen == annot.objgen


@host_check("duplicate_copy_text_pdfium")
def _duplicate_copy_text_pdfium(data: bytes, marker: str) -> None:
    import pypdfium2 as pdfium

    pd = pdfium.PdfDocument(data)
    try:
        texts = [pd[i].get_textpage().get_text_range() for i in range(len(pd))]
        assert marker not in texts[0] and marker in texts[1]
        for i in range(len(pd)):
            assert pd[i].render(scale=0.5).to_pil().size[0] > 0
    finally:
        pd.close()


@host_check("duplicate_shares_images_pikepdf")
def _duplicate_shares_images_pikepdf(data: bytes, size_before: int) -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        images = [{x.objgen for x in page.obj.Resources.XObject.values()} for page in pdf.pages]
        assert images[0] and images[0] == images[1] == images[2]
        assert len({page.objgen for page in pdf.pages}) == 3
        streams = [_contents(page) for page in pdf.pages]
        assert not streams[0] & streams[1] and not streams[1] & streams[2]
        image_bytes = sum(len(x.read_raw_bytes()) for x in pdf.pages[0].Resources.XObject.values())
    assert len(data) < size_before + image_bytes // 2


@host_check("render_first_page_pdfium")
def _render_first_page_pdfium(data: bytes) -> None:
    import pypdfium2 as pdfium

    pd = pdfium.PdfDocument(data)
    try:
        assert pd[0].render(scale=0.5).to_pil().size[0] > 0
    finally:
        pd.close()


@host_check("copied_form_fields_pikepdf")
def _copied_form_fields_pikepdf(data: bytes) -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        names = [str(f.T) for f in pdf.Root.AcroForm.Fields]
        assert len(names) == 2 and len(set(names)) == 2 and names[0] == "name"
        assert [len(p.obj.Annots) for p in pdf.pages] == [1, 1]
        assert pdf.pages[0].obj.Annots[0].objgen != pdf.pages[1].obj.Annots[0].objgen


@host_check("copied_form_page_pdfium")
def _copied_form_page_pdfium(data: bytes, widths: list[int], page: int, text: str) -> None:
    import pypdfium2 as pdfium

    pd = pdfium.PdfDocument(data)
    try:
        assert [round(pd[i].get_width()) for i in range(len(pd))] == widths
        assert text in pd[page].get_textpage().get_text_range()
    finally:
        pd.close()


@host_check("catalog_keys_pikepdf")
def _catalog_keys_pikepdf(data: bytes) -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        root = pdf.Root
        assert str(root.Lang) == "de-CH" and bool(root.MarkInfo.Marked)
        assert bool(root.ViewerPreferences.DisplayDocTitle) and root.PageMode == "/UseOutlines"
        assert [str(f.T) for f in root.AcroForm.Fields] == ["agree"]
        assert len(pdf.pages) == 2 and len(pdf.pages[0].obj.Annots) == 1
