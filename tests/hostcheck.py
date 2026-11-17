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
import math
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


# -- engine-module checks ------------------------------------------------------------------------


def _approx(actual: list[float], expected: list[float]) -> None:
    """The comparison ``pytest.approx`` makes with its default tolerances."""
    assert len(actual) == len(expected)
    for a, b in zip(actual, expected, strict=True):
        assert math.isclose(a, b, rel_tol=1e-6, abs_tol=1e-12)


def _pdfium_rgb(data: bytes, index: int) -> Any:
    import numpy as np
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(data)
    try:
        bitmap = pdf[index].render(scale=1, may_draw_forms=True)
        return np.array(bitmap.to_pil().convert("RGB"))
    finally:
        pdf.close()


def _red_count(rgb: Any, clip: list[float]) -> int:
    x0, y0, x1, y1 = clip
    part = rgb[int(y0) : int(y1), int(x0) : int(x1)].astype(int)
    red = (part[:, :, 0] > 150) & (part[:, :, 1] < 110) & (part[:, :, 2] < 110)
    return int(red.sum())


def _doc_text(pd: Any) -> str:
    return "\n".join(page.get_textpage().get_text_range() for page in pd)


def _comment_annots(pdf: Any, page: int = 0) -> list[tuple[str, str | None]]:
    """(subtype, /NM) of each comment on ``page``; a note's /Popup is not a comment."""
    return [
        (str(a.get("/Subtype")), str(a["/NM"]) if "/NM" in a else None)
        for a in pdf.pages[page].get("/Annots", [])
        if a.get("/Subtype") != "/Popup"
    ]


@host_check("opens_pikepdf")
def _opens_pikepdf(data: bytes) -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data)):
        pass


@host_check("render_pdfium")
def _render_pdfium(data: bytes, page: int, scale: float) -> None:
    import pypdfium2 as pdfium

    pd = pdfium.PdfDocument(data)
    try:
        pd[page].render(scale=scale).to_pil()
    finally:
        pd.close()


@host_check("render_width_pdfium")
def _render_width_pdfium(data: bytes, scale: float) -> None:
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(data)
    try:
        assert doc[0].render(scale=scale).width > 0
    finally:
        doc.close()


@host_check("text_contains_pdfium_no_cr")
def _text_contains_pdfium_no_cr(data: bytes, page: int, text: str) -> None:
    import pypdfium2 as pdfium

    pd = pdfium.PdfDocument(data)
    try:
        assert text in pd[page].get_textpage().get_text_range().replace("\r", "")
    finally:
        pd.close()


@host_check("text_lacks_pdfium")
def _text_lacks_pdfium(data: bytes, page: int, text: str) -> None:
    import pypdfium2 as pdfium

    pd = pdfium.PdfDocument(data)
    try:
        assert text not in pd[page].get_textpage().get_text_range()
    finally:
        pd.close()


@host_check("doc_text_contains_pdfium")
def _doc_text_contains_pdfium(data: bytes, text: str) -> None:
    import pypdfium2 as pdfium

    pd = pdfium.PdfDocument(data)
    try:
        assert text in _doc_text(pd)
    finally:
        pd.close()


@host_check("doc_text_lacks_pdfium")
def _doc_text_lacks_pdfium(data: bytes, text: str, fold_case: bool = False) -> None:
    import pypdfium2 as pdfium

    pd = pdfium.PdfDocument(data)
    try:
        joined = _doc_text(pd)
        if fold_case:
            assert text.lower() not in joined.lower()
        else:
            assert text not in joined
    finally:
        pd.close()


@host_check("doc_text_count_pdfium")
def _doc_text_count_pdfium(data: bytes, text: str, count: int) -> None:
    import pypdfium2 as pdfium

    pd = pdfium.PdfDocument(data)
    try:
        assert _doc_text(pd).count(text) == count
    finally:
        pd.close()


@host_check("same_pages_as_pdfium")
def _same_pages_as_pdfium(data: bytes, reference: str) -> None:
    """Each page of ``data`` renders like the same page of the reference file (base64)."""
    import pypdfium2 as pdfium
    from PIL import ImageChops

    def renders(src: bytes) -> list[Any]:
        pd = pdfium.PdfDocument(src)
        try:
            return [page.render(scale=1, draw_annots=False).to_pil().convert("L") for page in pd]
        finally:
            pd.close()

    def same(a: Any, b: Any) -> bool:
        if a.size != b.size:
            return False
        diff = ImageChops.difference(a, b)
        return max(diff.getextrema()) <= 8  # antialiasing noise only

    before = renders(base64.b64decode(reference))
    after = renders(data)
    assert all(same(a, b) for a, b in zip(before, after, strict=True))


@host_check("red_pixels_pdfium")
def _red_pixels_pdfium(data: bytes, page: int, clip: list[float], minimum: int) -> None:
    assert _red_count(_pdfium_rgb(data, page), clip) > minimum


@host_check("stamp_orientation_pdfium")
def _stamp_orientation_pdfium(data: bytes, page: int) -> None:
    rgb = _pdfium_rgb(data, page).astype(int)
    left, right = rgb[350, 220], rgb[350, 280]
    assert left[0] > 150 and left[2] < 100  # red on the left: not rotated or mirrored
    assert right[2] > 150 and right[0] < 100


@host_check("encrypted_pages_pikepdf")
def _encrypted_pages_pikepdf(data: bytes, pages: int, password: str) -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data), password=password) as pdf:
        assert pdf.is_encrypted and len(pdf.pages) == pages


@host_check("ocg_count_pikepdf")
def _ocg_count_pikepdf(data: bytes, count: int) -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        assert len(pdf.Root.OCProperties.OCGs) == count


@host_check("streams_lack_pikepdf")
def _streams_lack_pikepdf(data: bytes, needle: str) -> None:
    """No decoded stream holds ``needle`` as a literal or hex string (independent of MuPDF)."""
    import pikepdf

    raw_needle = needle.encode()
    with pikepdf.open(io.BytesIO(data)) as pdf:
        for obj in pdf.objects:
            if isinstance(obj, pikepdf.Stream):
                try:
                    body = obj.read_bytes().lower()
                except pikepdf.PdfError:
                    continue
                assert not (raw_needle.lower() in body or raw_needle.hex().encode() in body)


@host_check("page0_contents_lack_pikepdf")
def _page0_contents_lack_pikepdf(data: bytes, needle: str) -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        streams = b"".join(
            bytes(pdf.pages[0].Contents.read_bytes())
            if not isinstance(pdf.pages[0].Contents, pikepdf.Array)
            else b"".join(c.read_bytes() for c in pdf.pages[0].Contents)
            for _ in [0]
        )
    assert needle.encode() not in streams


@host_check("annot_count_pikepdf")
def _annot_count_pikepdf(data: bytes, page: int, minimum: int) -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        assert len(pdf.pages[page].Annots) >= minimum


@host_check("annot_keys_pikepdf")
def _annot_keys_pikepdf(
    data: bytes,
    subtype: str,
    page: int = 0,
    present: list[str] | None = None,
    absent: list[str] | None = None,
    contents: str | None = None,
) -> None:
    """The first annotation of ``subtype`` on ``page`` has the keys ``present`` and not
    ``absent``; with ``contents`` its /Contents text is that string (empty when unset)."""
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        annots = [a for a in pdf.pages[page].get("/Annots", []) if a.get("/Subtype") == subtype]
        assert annots, "saved file lost the annotation"
        raw = {str(key): str(value) for key, value in annots[0].items()}
    for key in present or []:
        assert key in raw
    for key in absent or []:
        assert key not in raw
    if contents is not None:
        assert raw.get("/Contents", "") == contents


@host_check("annot_lacks_keys_pikepdf")
def _annot_lacks_keys_pikepdf(data: bytes, subtype: str, keys: list[str]) -> None:
    """The first annotation of ``subtype`` on page 0 has none of ``keys`` (pikepdf's own
    membership test, where a null value counts as absent)."""
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        annot = next(a for a in pdf.pages[0].Annots if a.Subtype == subtype)
        for key in keys:
            assert key not in annot


@host_check("callout_annot_pikepdf")
def _callout_annot_pikepdf(data: bytes, page: int) -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        annot = next(a for a in pdf.pages[page].Annots if a.Subtype == "/FreeText")
        assert annot.IT == "/FreeTextCallout"
        assert len(annot.CL) == 6
        assert annot.LE == "/OpenArrow"
        assert "/N" in annot.AP


@host_check("stamp_image_pikepdf")
def _stamp_image_pikepdf(data: bytes, page: int) -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        annot = next(a for a in pdf.pages[page].Annots if a.Subtype == "/Stamp")
        xobjects = annot.AP.N.Resources.XObject
        assert any(xobjects[k].Subtype == "/Image" for k in xobjects)


@host_check("attachment_bytes_pikepdf")
def _attachment_bytes_pikepdf(data: bytes, expected: str) -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        annot = next(a for a in pdf.pages[0].Annots if a.Subtype == "/FileAttachment")
        assert annot.FS.EF.F.read_bytes() == expected.encode()


@host_check("comments_unnamed_pikepdf")
def _comments_unnamed_pikepdf(data: bytes) -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        nm = [str(a.NM) for a in pdf.pages[0].Annots if a.get("/NM") is not None]
        assert not any(n.startswith("#") for n in nm)
        assert [a.Subtype for a in pdf.pages[0].Annots if a.Subtype != "/Popup"] == [
            "/Square",
            "/Square",
            "/Text",
        ]


@host_check("quad_points_pikepdf")
def _quad_points_pikepdf(data: bytes, subtype: str, corners: list[list[float]]) -> None:
    """The saved /QuadPoints hold ``corners`` (visible space) in PDF space, origin bottom-left."""
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        annot = next(a for a in pdf.pages[0].Annots if a.get("/Subtype") == subtype)
        height = float(pdf.pages[0].MediaBox[3])
        stored = [float(v) for v in annot.QuadPoints]
    expected: list[float] = []
    for x, y in corners:
        expected.extend([x, height - y])
    _approx(stored, expected)


@host_check("marked_content_pikepdf")
def _marked_content_pikepdf(data: bytes, minimum: int) -> None:
    """Every MCID in the page content has a ParentTree entry pointing at an element that
    claims it (on that page); at least ``minimum`` MCIDs in all."""
    import pikepdf

    total = 0
    with pikepdf.open(io.BytesIO(data)) as pdf:
        root = pdf.Root.StructTreeRoot
        assert pdf.Root.MarkInfo.Marked is True
        nums = list(root.ParentTree.Nums)
        tree = {int(nums[i]): nums[i + 1] for i in range(0, len(nums), 2)}
        assert int(root.ParentTreeNextKey) == len(tree)
        for page in pdf.pages:
            mcids = [
                int(operands[1].MCID)
                for operands, op in pikepdf.parse_content_stream(page)
                if str(op) == "BDC" and isinstance(operands[1], pikepdf.Dictionary)
            ]
            if not mcids:
                assert "/StructParents" not in page.obj
                continue
            assert sorted(mcids) == list(range(len(mcids)))  # unique, from 0
            parents = tree[int(page.obj.StructParents)]
            assert len(parents) == len(mcids)
            for mcid in mcids:
                elem = parents[mcid]
                kids = elem.K if isinstance(elem.K, pikepdf.Array) else [elem.K]
                assert mcid in [int(k) for k in kids]
                assert elem.Pg.objgen == page.obj.objgen
                assert elem.P.S == "/Document"
            total += len(mcids)
    assert total >= minimum


@host_check("comment_names_pikepdf")
def _comment_names_pikepdf(data: bytes, count: int, prefix: str) -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        annots = _comment_annots(pdf)
    nm = [name for _, name in annots]
    assert len(annots) == count and all(name is not None for name in nm)
    assert len(set(nm)) == count and all(n.startswith(prefix) for n in nm)


@host_check("first_comment_name_pikepdf")
def _first_comment_name_pikepdf(data: bytes, prefix: str) -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        annots = _comment_annots(pdf)
    assert annots[0][1] is not None and annots[0][1].startswith(prefix)


@host_check("no_prefixed_names_pikepdf")
def _no_prefixed_names_pikepdf(data: bytes, prefix: str) -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        nm = [str(a.NM) for a in pdf.pages[0].Annots if a.get("/NM") is not None]
    assert not any(n.startswith(prefix) for n in nm)


@host_check("widget_link_names_pikepdf")
def _widget_link_names_pikepdf(data: bytes, prefix: str) -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        every = [(str(a.get("/Subtype")), str(a.get("/NM", ""))) for a in pdf.pages[0].Annots]
    subtypes = dict(every)
    assert "/Link" in subtypes and "/Widget" in subtypes
    # links and widgets keep whatever name they had; the full save doesn't name them
    for kind in ("/Link", "/Widget", "/Popup"):
        for subtype, nm in every:
            if subtype == kind:
                assert not nm.startswith(prefix), (kind, nm)
    assert subtypes["/Text"].startswith(prefix)


@host_check("docinfo_title_pikepdf")
def _docinfo_title_pikepdf(data: bytes, title: str) -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        assert str(pdf.docinfo.get("/Title", "")) == title


@host_check("font_names_complete_pikepdf")
def _font_names_complete_pikepdf(data: bytes, family: str) -> None:
    """Some font of ``family`` is still whole (no subset tag), not only subsets of it."""
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        names = {
            str(f.get("/BaseFont"))
            for page in pdf.pages
            for f in page.Resources.get("/Font", {}).values()
        }
    assert any(family in n and "+" not in n for n in names), names


@host_check("artifact_tags_pikepdf")
def _artifact_tags_pikepdf(data: bytes, present: list[list[str]]) -> None:
    """Each (Subtype, PDFEditorMark) pair is a marked-content artifact on page 0."""
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        ops = pikepdf.parse_content_stream(pdf.pages[0])
        tags = [
            (str(o.operands[1].get("/Subtype", "")), str(o.operands[1].get("/PDFEditorMark")))
            for o in ops
            if str(o.operator) == "BDC" and str(o.operands[0]) == "/Artifact"
        ]
    for pair in present:
        assert tuple(pair) in tags


@host_check("no_do_operators_pikepdf")
def _no_do_operators_pikepdf(data: bytes, page: int) -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        ops = pikepdf.parse_content_stream(pdf.pages[page])
        assert not [o for o in ops if str(o.operator) == "Do"]


@host_check("image_count_pikepdf")
def _image_count_pikepdf(data: bytes, count: int, page: int = 0) -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        assert len(pdf.pages[page].get_images()) == count


@host_check("no_image_streams_pikepdf")
def _no_image_streams_pikepdf(data: bytes) -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        assert not [
            o
            for o in pdf.objects
            if isinstance(o, pikepdf.Stream) and o.get("/Subtype") == "/Image"
        ]


@host_check("structure_saved_pikepdf")
def _structure_saved_pikepdf(data: bytes, lang: str, alt: str) -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        assert str(pdf.Root.Lang) == lang and pdf.Root.ViewerPreferences.DisplayDocTitle
        assert str(pdf.Root.StructTreeRoot.K.K[2].Alt) == alt
        assert all(p.obj.Tabs == "/S" for p in pdf.pages)
