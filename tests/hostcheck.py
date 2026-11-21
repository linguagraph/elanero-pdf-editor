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
def _render_first_page_pdfium(data: bytes, password: str = "") -> None:
    import pypdfium2 as pdfium

    pd = pdfium.PdfDocument(data, password=password or None)
    try:
        assert pd[0].render(scale=0.5).to_pil().size[0] > 0
    finally:
        pd.close()


@host_check("copied_form_fields_pikepdf")
def _copied_form_fields_pikepdf(data: bytes) -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        fields = pdf.Root.AcroForm.Fields
        assert [len(p.obj.Annots) for p in pdf.pages] == [1, 1]
        assert pdf.pages[0].obj.Annots[0].objgen != pdf.pages[1].obj.Annots[0].objgen
        # PyMuPDF 1.28 writes a text field as one object, so the copy is a second field named
        # after the first; PyMuPDF 2.1 writes a parent field with a kid widget, so the copy is
        # a second kid of that field (the same field, as the copy code's docstring describes)
        if len(fields) == 2:
            names = [str(f.T) for f in fields]
            assert len(set(names)) == 2 and names[0] == "name"
        else:
            assert len(fields) == 1 and str(fields[0].T) == "name"
            kids = list(fields[0].Kids)
            assert len(kids) == 2
            assert kids[0].objgen != kids[1].objgen
            assert all(str(k.get("/Subtype")) == "/Widget" for k in kids)
            page_two = pdf.pages[1].obj.Annots[0].objgen
            assert page_two in [k.objgen for k in kids]


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
    """The page as a Pillow RGB image (pure Python: the host replay has no numpy)."""
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(data)
    try:
        bitmap = pdf[index].render(scale=1, may_draw_forms=True)
        return bitmap.to_pil().convert("RGB")
    finally:
        pdf.close()


def _red_count(rgb: Any, clip: list[float]) -> int:
    x0, y0, x1, y1 = clip
    part = rgb.crop((int(x0), int(y0), int(x1), int(y1)))
    raw = part.tobytes()  # RGB bytes, three per pixel
    return sum(
        1
        for r, g, b in zip(raw[0::3], raw[1::3], raw[2::3], strict=True)
        if r > 150 and g < 110 and b < 110
    )


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


def _darkest(rgb: Any, clip: list[float]) -> int:
    """The lowest channel value anywhere in the clip (255 is white)."""
    x0, y0, x1, y1 = clip
    part = rgb.crop((int(x0), int(y0), int(x1), int(y1)))
    return int(min(low for low, _high in part.getextrema()))


@host_check("blank_region_pdfium")
def _blank_region_pdfium(data: bytes, page: int, clip: list[float]) -> None:
    """Nothing but white in the clip: the object that stood there has moved away."""
    assert _darkest(_pdfium_rgb(data, page), clip) >= 245


@host_check("ink_region_pdfium")
def _ink_region_pdfium(data: bytes, page: int, clip: list[float]) -> None:
    """Some dark ink in the clip: the object is drawn there."""
    assert _darkest(_pdfium_rgb(data, page), clip) < 200


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
    rgb = _pdfium_rgb(data, page)
    left, right = rgb.getpixel((220, 350)), rgb.getpixel((280, 350))  # (x, y)
    assert left[0] > 150 and left[2] < 100  # red on the left: not rotated or mirrored
    assert right[2] > 150 and right[0] < 100


@host_check("zip_parts_pdf")
def _zip_parts_pdf(data: bytes, names: list[str], pages: list[int]) -> None:
    """The ZIP holds the part files ``names``, in that order. Each part has ``pages[i]`` pages in
    pikepdf, and pypdfium2 opens it and renders its first page (W6.2 section 7)."""
    import zipfile

    import pikepdf

    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        assert archive.namelist() == names, archive.namelist()
        for name, count in zip(names, pages, strict=True):
            part = archive.read(name)
            with pikepdf.open(io.BytesIO(part)) as pdf:
                assert len(pdf.pages) == count, (name, len(pdf.pages))
            _render_first_page_pdfium(part)


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


@host_check("same_object_count_pikepdf")
def _same_object_count_pikepdf(data: bytes, reference: str) -> None:
    """The file has as many indirect objects as ``reference`` (base64 of another saved file)."""
    import pikepdf

    with (
        pikepdf.open(io.BytesIO(data)) as pdf,
        pikepdf.open(io.BytesIO(base64.b64decode(reference))) as ref,
    ):
        assert len(pdf.objects) == len(ref.objects), (len(pdf.objects), len(ref.objects))


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


@host_check("redact_rects_pikepdf")
def _redact_rects_pikepdf(data: bytes, page: int, count: int, rect: list[float]) -> None:
    """The page has ``count`` /Redact annotations, each with /Rect ``rect`` (PDF points)."""
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        marks = [a for a in pdf.pages[page].Annots if str(a.get("/Subtype")) == "/Redact"]
        assert len(marks) == count
        for mark in marks:
            _approx([float(v) for v in mark.Rect], rect)


def _field_attr(node: Any, key: str, default: Any = None) -> Any:
    """A field attribute as a reader sees it: on the widget, or inherited from its parent field
    (PyMuPDF 2.1 writes a text field as a parent with a kid widget, and /T and /V sit there)."""
    for _ in range(32):  # field hierarchies are shallow; guards against a cycle
        if key in node:
            return node[key]
        if "/Parent" not in node:
            break
        node = node.Parent
    return default


@host_check("widget_named_pikepdf")
def _widget_named_pikepdf(data: bytes, page: int, field: str, value: str) -> None:
    """Exactly one widget on the page is named ``field`` and holds ``value``."""
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        widgets = [
            a
            for a in pdf.pages[page].obj.get(pikepdf.Name.Annots, [])
            if a.get("/Subtype") == pikepdf.Name.Widget and str(_field_attr(a, "/T", "")) == field
        ]
        assert len(widgets) == 1, field
        assert str(_field_attr(widgets[0], "/V", "")) == value


@host_check("no_annots_pikepdf")
def _no_annots_pikepdf(data: bytes, page: int) -> None:
    """The page has no annotations left (an empty /Annots array counts as none)."""
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        assert not pdf.pages[page].obj.get(pikepdf.Name.Annots)


@host_check("signed_form_pikepdf")
def _signed_form_pikepdf(data: bytes, page: int, field: str, flags: int) -> None:
    """/SigFlags is ``flags``, and the page's only annotations are widgets, one named ``field``."""
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        assert int(pdf.Root.AcroForm.SigFlags) == flags
        annots = list(pdf.pages[page].obj.get(pikepdf.Name.Annots, []))
        assert annots and all(str(a.get("/Subtype")) == "/Widget" for a in annots)
        assert any(str(_field_attr(a, "/T")) == field for a in annots)


@host_check("widget_count_pikepdf")
def _widget_count_pikepdf(data: bytes, page: int, count: int) -> None:
    """The page has exactly ``count`` form widgets (signature and text fields alike)."""
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        annots = list(pdf.pages[page].obj.get(pikepdf.Name.Annots, []))
        assert sum(str(a.get("/Subtype")) == "/Widget" for a in annots) == count


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


@host_check("embedded_file_name_pikepdf")
def _embedded_file_name_pikepdf(data: bytes, attachment: str) -> None:
    """The catalog's name tree lists the embedded file ``attachment``: it survived a save."""
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        assert str(pdf.Root.Names.EmbeddedFiles.Names[0]) == attachment


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


@host_check("redact_annot_pikepdf")
def _redact_annot_pikepdf(
    data: bytes, page: int, mark: str, fill: list[float], overlay: str, text: list[float]
) -> None:
    """The REDACT annotation named ``mark`` on ``page`` has box colour ``fill`` (/IC), overlay
    text ``overlay`` (absent when empty) and text colour ``text`` (the colour in /DA)."""
    import pikepdf

    def close(a: list[float], b: list[float]) -> bool:
        return len(a) == len(b) and all(abs(x - y) < 0.001 for x, y in zip(a, b, strict=True))

    with pikepdf.open(io.BytesIO(data)) as pdf:
        annots = pdf.pages[page].obj.get("/Annots", [])
        found = [a for a in annots if str(a.get("/NM", "")) == mark]
        assert len(found) == 1, f"{len(found)} annotations named {mark}"
        annot = found[0]
        assert annot.get("/Subtype") == "/Redact"
        assert close([float(v) for v in annot.IC], fill), list(annot.IC)
        overlay_obj = annot.get("/OverlayText")
        if overlay:
            assert str(overlay_obj) == overlay, overlay_obj
        else:
            assert overlay_obj is None, overlay_obj
        tokens = str(annot.DA).split()
        i = tokens.index("rg")
        assert close([float(t) for t in tokens[i - 3 : i]], text), tokens


@host_check("annot_author_pikepdf")
def _annot_author_pikepdf(data: bytes, page: int, mark: str, author: str) -> None:
    """The annotation named ``mark`` on ``page`` has the author ``author`` (its /T title)."""
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        annots = pdf.pages[page].obj.get("/Annots", [])
        found = [a for a in annots if str(a.get("/NM", "")) == mark]
        assert len(found) == 1, f"{len(found)} annotations named {mark}"
        assert str(found[0].get("/T", "")) == author, found[0].get("/T")


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
def _docinfo_title_pikepdf(data: bytes, title: str, password: str = "") -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data), password=password) as pdf:
        assert str(pdf.docinfo.get("/Title", "")) == title


@host_check("xmp_dc_title_pikepdf")
def _xmp_dc_title_pikepdf(data: bytes, title: str, password: str = "") -> None:
    """The XMP packet's dc:title, which must agree with the Info /Title (W7.6)."""
    import pikepdf

    with pikepdf.open(io.BytesIO(data), password=password) as pdf, pdf.open_metadata() as meta:
        assert meta.get("dc:title") == title


@host_check("no_xmp_pikepdf")
def _no_xmp_pikepdf(data: bytes, password: str = "") -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data), password=password) as pdf:
        assert "/Metadata" not in pdf.Root


@host_check("pdf_version_pikepdf")
def _pdf_version_pikepdf(data: bytes, version: str, password: str = "") -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data), password=password) as pdf:
        assert pdf.pdf_version == version


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


@host_check("font_program_sha256_pikepdf")
def _font_program_sha256_pikepdf(data: bytes, resource: str, sha256: str) -> None:
    """The FontFile2 stream of page 0's font ``resource`` (a composite font's descendant) has
    the SHA-256 ``sha256``: the bytes the PDF itself embeds, not the engine's copy."""
    import hashlib

    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        font = pdf.pages[0].Resources.Font[resource]
        if "/DescendantFonts" in font:  # a composite (Type0) font keeps its descriptor below
            font = font.DescendantFonts[0]
        program = bytes(font.FontDescriptor.FontFile2.read_bytes())
    assert hashlib.sha256(program).hexdigest() == sha256


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


# -- shared-object checks (tests/engine/test_shared_objects.py) ------------------------------------


def _indirect_objgens(value: Any) -> set[tuple[int, int]]:
    """The indirect objects an entry names: the indirect items of an array, or the value itself."""
    import pikepdf

    if isinstance(value, pikepdf.Array):
        return {item.objgen for item in value if item.is_indirect}
    return {value.objgen} if isinstance(value, pikepdf.Object) and value.is_indirect else set()


@host_check("optimized_pages_merged_pikepdf")
def _optimized_pages_merged_pikepdf(data: bytes) -> None:
    """Optimize merged the two duplicate pages' content or resources (issue #49)."""
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        a, b = (p.obj for p in pdf.pages)
        contents = (_indirect_objgens(a.Contents) or {a.Contents.objgen}) & (
            _indirect_objgens(b.Contents) or {b.Contents.objgen}
        )
        assert contents or a.Resources.objgen == b.Resources.objgen


def _page_look_pdfium(data: bytes, index: int) -> tuple[str, bytes]:
    """Text and pixels of a page, as an independent implementation (PDFium) sees them."""
    import pypdfium2 as pdfium

    pd = pdfium.PdfDocument(data)
    try:
        page = pd[index]
        text = page.get_textpage().get_text_range()
        pixels = page.render(scale=1, may_draw_forms=True).to_pil().convert("RGB").tobytes()
        return text, pixels
    finally:
        pd.close()


@host_check("page_looks_same_pdfium")
def _page_looks_same_pdfium(data: bytes, source: str, index: int) -> None:
    """Page ``index`` of ``data`` has the text and pixels of the same page of ``source``
    (base64 of the bytes the edit started from)."""
    before = _page_look_pdfium(base64.b64decode(source), index)
    assert _page_look_pdfium(data, index) == before


# -- action-module checks (tests/actions/) ---------------------------------------------------------


@host_check("pages_at_least_pikepdf")
def _pages_at_least_pikepdf(data: bytes, minimum: int) -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        assert len(pdf.pages) >= minimum


def _pixel_pdfium(data: bytes, page: int, x: int, y: int) -> tuple[int, int, int]:
    """Pixel (x, y) of ``page`` rendered at 72 dpi, so it is the visible-space point (x, y)."""
    import pypdfium2 as pdfium

    pd = pdfium.PdfDocument(data)
    try:
        image = pd[page].render(scale=1).to_pil().convert("RGB")
        r, g, b = image.getpixel((x, y))
        return int(r), int(g), int(b)
    finally:
        pd.close()


@host_check("pixel_green_pdfium")
def _pixel_green_pdfium(data: bytes, page: int, x: int, y: int) -> None:
    r, g, b = _pixel_pdfium(data, page, x, y)
    assert g > 150 and r < 80 and b < 80


@host_check("pixel_red_pdfium")
def _pixel_red_pdfium(data: bytes, page: int, x: int, y: int) -> None:
    r, g, b = _pixel_pdfium(data, page, x, y)
    assert r > 200 and g < 80 and b < 80


@host_check("shape_operators_pikepdf")
def _shape_operators_pikepdf(data: bytes, page: int, kind: str) -> None:
    """The last shape on ``page`` is one q ... Q block: its path operators (re; or four c; or m and
    l), the stroke width 1.5, a black stroke colour and the stroke paint S, and no fill."""
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        ops = list(pikepdf.parse_content_stream(pdf.pages[page]))
    start = max(i for i, (_operands, op) in enumerate(ops) if str(op) == "q")
    block = [(list(operands), str(op)) for operands, op in ops[start:]]
    names = [name for _operands, name in block]
    assert names[-1] == "Q"
    if kind == "line":
        assert names.count("m") == 1 and names.count("l") == 1 and "re" not in names
    elif kind == "rectangle":
        assert names.count("re") == 1 and "c" not in names
    elif kind == "ellipse":
        assert names.count("c") == 4 and names.count("m") == 1 and "re" not in names
    else:
        raise AssertionError(f"unknown shape kind {kind}")
    (width,) = (float(operands[0]) for operands, name in block if name == "w")
    assert math.isclose(width, 1.5, abs_tol=1e-6)
    (stroke,) = ([float(v) for v in operands] for operands, name in block if name == "RG")
    assert stroke == [0.0, 0.0, 0.0]
    assert names.count("S") == 1 and "f" not in names and "B" not in names


@host_check("crop_box_size_pikepdf")
def _crop_box_size_pikepdf(
    data: bytes, width: float, height: float, page: int = 0, password: str = ""
) -> None:
    """Page ``page``'s CropBox is ``width`` x ``height`` (pytest.approx with abs=0.5).

    The box is the stored, unrotated one, so a rotated page's check passes the unrotated size.
    """
    import pikepdf

    with pikepdf.open(io.BytesIO(data), password=password) as pdf:
        box = [float(v) for v in pdf.pages[page].obj.CropBox]
    assert math.isclose(box[2] - box[0], width, rel_tol=1e-6, abs_tol=0.5)
    assert math.isclose(box[3] - box[1], height, rel_tol=1e-6, abs_tol=0.5)


@host_check("rotation_pikepdf")
def _rotation_pikepdf(data: bytes, page: int, degrees: int) -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        assert int(pdf.pages[page].obj.get("/Rotate", 0)) == degrees


@host_check("page_label_rule_pikepdf")
def _page_label_rule_pikepdf(data: bytes, start: int, style: str, prefix: str, first: int) -> None:
    """The /PageLabels number tree holds the rule starting at ``start``, as written."""
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        tree = pdf.Root.get("/PageLabels")
        assert tree is not None, "no /PageLabels in the catalogue"
        nums = list(tree.Nums)
        rules = {int(nums[i]): nums[i + 1] for i in range(0, len(nums), 2)}
        rule = rules[start]
        assert str(rule.get("/P", "")) == prefix
        style_name = rule.get("/S")
        expected_style = f"/{style}" if style else ""
        assert (str(style_name) if style_name is not None else "") == expected_style
        assert int(rule.get("/St", 1)) == first


@host_check("catalog_has_key_pikepdf")
def _catalog_has_key_pikepdf(data: bytes, key: str) -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        assert key in pdf.Root


@host_check("docinfo_lacks_key_pikepdf")
def _docinfo_lacks_key_pikepdf(data: bytes, key: str) -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        assert key not in pdf.docinfo


@host_check("sanitized_catalog_pikepdf")
def _sanitized_catalog_pikepdf(data: bytes, parts: list[str]) -> None:
    """Each named part of a sanitize is absent from the file (pikepdf, not MuPDF).

    ``xmp``, ``attachments``, ``javascript``, ``links`` and ``thumbnails`` name what sanitize
    removes from the catalog and the pages; a sanitize with every option on names all five.
    """
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        root = pdf.Root
        pages = list(pdf.pages)
        annots = [a for p in pages for a in p.get("/Annots", [])]
        if "xmp" in parts:
            assert "/Metadata" not in root
        if "attachments" in parts:
            # sanitize empties the embedded-files name tree rather than removing the key
            names = root.get("/Names", {}).get("/EmbeddedFiles", {}).get("/Names", [])
            assert len(names) == 0
            assert all(a.get("/Subtype") != "/FileAttachment" for a in annots)
        if "javascript" in parts:
            action = root.get("/OpenAction")
            assert not (
                isinstance(action, pikepdf.Dictionary) and action.get("/S") == "/JavaScript"
            )
            assert "/AA" not in root and "/JavaScript" not in root.get("/Names", {})
            assert all("/AA" not in p for p in pages)
        if "links" in parts:
            assert all(a.get("/Subtype") != "/Link" for a in annots)
        if "thumbnails" in parts:
            assert all("/Thumb" not in p for p in pages)


@host_check("form_fields_pikepdf")
def _form_fields_pikepdf(data: bytes, fields: dict[str, str]) -> None:
    """Each named top-level AcroForm field is there, as a widget too, with the value given
    ("" when the value was reset: the key is absent or empty)."""
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        values = {str(f.T): str(f.get("/V", "")) for f in pdf.Root.AcroForm.Fields}
        # a widget may carry no /T of its own: PyMuPDF 2.1 names the parent field instead
        widgets = {
            str(a.get("/T", a.get("/Parent", {}).get("/T", "")))
            for p in pdf.pages
            for a in p.get("/Annots", [])
            if a.get("/Subtype") == "/Widget"
        }
    assert values == fields, values
    assert set(fields) <= widgets, widgets


@host_check("outline_pikepdf")
def _outline_pikepdf(data: bytes, expected: list[list[Any]]) -> None:
    """(level, title) of every bookmark, walked by hand through /First and /Next."""
    import pikepdf

    out: list[tuple[int, str]] = []

    def walk(node: Any, level: int) -> None:
        child = node.get("/First")
        while child is not None:
            out.append((level, str(child.Title)))
            walk(child, level + 1)
            child = child.get("/Next")

    with pikepdf.open(io.BytesIO(data)) as pdf:
        walk(pdf.Root.Outlines, 1)
    assert out == [(int(level), title) for level, title in expected]


@host_check("outline_top_pikepdf")
def _outline_top_pikepdf(data: bytes, tops: list[list[Any]]) -> None:
    """For each ``[title, visible_y]``, the bookmark's /XYZ destination has its top at that many
    points below the page's crop box top (the visible space the web and desktop use), within 1 pt.

    The destination is read by hand (/Dest, or /A /D), so the check does not depend on MuPDF.
    """
    import pikepdf

    found: dict[str, Any] = {}

    def walk(node: Any) -> None:
        child = node.get("/First")
        while child is not None:
            found.setdefault(str(child.Title), child)
            walk(child)
            child = child.get("/Next")

    with pikepdf.open(io.BytesIO(data)) as pdf:
        walk(pdf.Root.Outlines)
        index_of = {page.obj.objgen: number for number, page in enumerate(pdf.pages)}
        for title, visible_y in tops:
            item = found[title]
            dest = item.get("/Dest")
            if dest is None:
                dest = item["/A"]["/D"]
            assert str(dest[1]) == "/XYZ", dest
            page = pdf.pages[index_of[dest[0].objgen]]
            crop_top = float(page.cropbox[3])
            assert abs((crop_top - float(visible_y)) - float(dest[3])) < 1.0, (title, dest)


@host_check("render_size_pdfium")
def _render_size_pdfium(data: bytes, page: int, scale: float) -> None:
    import pypdfium2 as pdfium

    pd = pdfium.PdfDocument(data)
    try:
        rendered = pd[page].render(scale=scale).to_pil()
        assert rendered.width > 0 and rendered.height > 0
    finally:
        pd.close()


@host_check("permissions_pikepdf")
def _permissions_pikepdf(data: bytes, password: str, allowed: dict[str, bool]) -> None:
    """Opened with ``password``, each named flag of ``pdf.allow`` has the expected value.

    The keys are pikepdf's own names (``extract``, ``print_lowres``, ...), so the check reads the
    permissions as an independent implementation does.
    """
    import pikepdf

    with pikepdf.open(io.BytesIO(data), password=password) as pdf:
        for name, value in allowed.items():
            assert getattr(pdf.allow, name) is value, name


@host_check("not_encrypted_pikepdf")
def _not_encrypted_pikepdf(data: bytes) -> None:
    """Opens with no password, and is not encrypted."""
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        assert not pdf.is_encrypted


@host_check("comment_count_pikepdf")
def _comment_count_pikepdf(data: bytes, count: int, page: int = 0) -> None:
    """Page ``page`` has ``count`` comments (its annotations other than popups)."""
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        annots = pdf.pages[page].obj.get("/Annots", [])
        assert len([a for a in annots if a.get("/Subtype") != "/Popup"]) == count


@host_check("comment_names_unique_pikepdf")
def _comment_names_unique_pikepdf(data: bytes, count: int, avoid_prefix: str) -> None:
    """Every comment on page 0 has a /NM; there are ``count`` distinct names, and none starts
    with ``avoid_prefix``."""
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        annots = [a for a in pdf.pages[0].Annots if a.get("/Subtype") != "/Popup"]
        nm = [str(a.NM) for a in annots if a.get("/NM") is not None]
    assert len(nm) == len(annots) == count
    assert not any(n.startswith(avoid_prefix) for n in nm)
    assert len(set(nm)) == count


@host_check("comments_lack_names_pikepdf")
def _comments_lack_names_pikepdf(data: bytes) -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        annots = [a for a in pdf.pages[0].Annots if a.get("/Subtype") != "/Popup"]
        assert all(a.get("/NM") is None for a in annots)


@host_check("names_present_none_prefixed_pikepdf")
def _names_present_none_prefixed_pikepdf(data: bytes, prefix: str) -> None:
    """Some annotation on any page has a /NM, and none of those names starts with ``prefix``."""
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        nm = [str(x.NM) for pg in pdf.pages for x in pg.get("/Annots", []) if x.get("/NM")]
    assert nm and not any(n.startswith(prefix) for n in nm)


@host_check("crop_one_colour_pdfium")
def _crop_one_colour_pdfium(
    data: bytes, page: int, box: list[int], expected: list[int], tolerance: int
) -> None:
    """The render of ``page``, cropped to ``box``, holds one colour within ``tolerance`` of
    ``expected`` on each channel."""
    import pypdfium2 as pdfium

    pd = pdfium.PdfDocument(data)
    try:
        render = pd[page].render(scale=1).to_pil().convert("RGB")
    finally:
        pd.close()
    colours = render.crop(tuple(box)).getcolors(maxcolors=16)
    assert colours is not None and len(colours) == 1, colours
    assert all(abs(c - e) <= tolerance for c, e in zip(colours[0][1], expected, strict=True))


@host_check("image_under_mark_one_colour_pikepdf")
def _image_under_mark_one_colour_pikepdf(
    data: bytes, mark_x1: float, image_x0: float, image_x1: float
) -> None:
    """Each image of page 0 is one colour left of the mark's right edge, less a 2 px margin."""
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        resources = pdf.pages[0].obj.get("/Resources", {})
        for xobject in resources.get("/XObject", {}).values():
            if xobject.get("/Subtype") != "/Image":
                continue
            picture = pikepdf.PdfImage(xobject).as_pil_image().convert("RGB")
            cut = round(picture.width * (mark_x1 - image_x0) / (image_x1 - image_x0)) - 2
            under = picture.crop((2, 2, cut, picture.height - 2))
            found = under.getcolors(maxcolors=16)
            assert found is not None and len(found) == 1, found


@host_check("watermark_drawn_pdfium")
def _watermark_drawn_pdfium(data: bytes, reference: str) -> None:
    """Page 0 of ``data`` differs from the same page of ``reference`` (base64) in its centre
    part, and both pages have the same size."""
    import pypdfium2 as pdfium
    from PIL import ImageChops

    def first_page(src: bytes) -> Any:
        pd = pdfium.PdfDocument(src)
        try:
            return pd[0].render(scale=1).to_pil().convert("RGB")
        finally:
            pd.close()

    with_mark = first_page(data)
    without = first_page(base64.b64decode(reference))
    assert with_mark.size == without.size
    w, h = with_mark.size
    centre = (int(w * 0.3), int(h * 0.3), int(w * 0.7), int(h * 0.7))
    changed = ImageChops.difference(
        without.crop(centre).convert("RGB"), with_mark.crop(centre).convert("RGB")
    )
    assert changed.getbbox() is not None


# -- unit and service checks (tests/unit/, tests/services/) ----------------------------------------


@host_check("pages_nonempty_pikepdf")
def _pages_nonempty_pikepdf(data: bytes) -> None:
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        assert len(pdf.pages) > 0


@host_check("pages_nonempty_pdfium")
def _pages_nonempty_pdfium(data: bytes) -> None:
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(data)
    assert len(doc) > 0
    doc.close()


@host_check("refuses_without_password_pikepdf")
def _refuses_without_password_pikepdf(data: bytes) -> None:
    """Opening without a password raises pikepdf's PasswordError."""
    import pikepdf

    try:
        pikepdf.open(io.BytesIO(data))
    except pikepdf.PasswordError:
        return
    raise AssertionError("opened without a password")


@host_check("annot_names_pikepdf")
def _annot_names_pikepdf(data: bytes, prefix: str) -> None:
    """Every annotation on any page (links and popups aside) has a /NM; at least one name
    starts with ``prefix``."""
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        annots = [
            annot
            for page in pdf.pages
            for annot in page.get("/Annots", [])
            if str(annot.get("/Subtype", "")) not in ("/Link", "/Popup")
        ]
        names = [str(annot.get("/NM", "")) for annot in annots]
    assert names, "the fixture has annotations"
    assert all(names), "every annotation has a name in the saved bytes"
    assert any(name.startswith(prefix) for name in names)


def _pdfium_page_texts(data: bytes) -> list[str]:
    """Text of every page, as PDFium reads it; each page is rendered first, as the callers did."""
    import pypdfium2 as pdfium

    pd = pdfium.PdfDocument(data)
    try:
        out = []
        for page in pd:
            page.render(scale=0.3)
            out.append(page.get_textpage().get_text_range())
        return out
    finally:
        pd.close()


@host_check("page_text_pdfium")
def _page_text_pdfium(
    data: bytes,
    page: int | None,
    absent: list[str] | None = None,
    once: list[str] | None = None,
    present: list[str] | None = None,
) -> None:
    """Text of ``page`` (every page when None) lacks each ``absent`` string, holds each ``once``
    string exactly once, and holds each ``present`` string."""
    texts = _pdfium_page_texts(data)
    selected = texts if page is None else [texts[page]]
    for text in selected:
        for needle in absent or []:
            assert needle not in text
        for needle in once or []:
            assert text.count(needle) == 1
        for needle in present or []:
            assert needle in text


@host_check("page_render_width_pdfium")
def _page_render_width_pdfium(data: bytes, page: int, scale: float) -> None:
    import pypdfium2 as pdfium

    pd = pdfium.PdfDocument(data)
    try:
        assert pd[page].render(scale=scale).to_pil().size[0] > 0
    finally:
        pd.close()


@host_check("first_page_not_blank_pdfium")
def _first_page_not_blank_pdfium(data: bytes) -> None:
    import pypdfium2 as pdfium

    pd = pdfium.PdfDocument(data)
    try:
        rendered = pd[0].render(scale=0.5).to_pil().convert("L")
    finally:
        pd.close()
    assert rendered.getextrema() != (255, 255)  # not blank


@host_check("perf_page_one_pikepdf")
def _perf_page_one_pikepdf(data: bytes) -> None:
    """Page 1 has one DCT photo of 1200 x 800, a base-14 font, an embedded TrueType font, and
    text set in two fonts (the W0.2 perf fixture shape)."""
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        page = pdf.pages[0]
        xobjects = page.Resources.get("/XObject", {})
        images = [
            obj
            for obj in xobjects.values()
            if obj.get("/Subtype") == "/Image" and obj.get("/Filter") == "/DCTDecode"
        ]
        assert len(images) == 1
        assert (int(images[0].Width), int(images[0].Height)) == (1200, 800)

        fonts = page.Resources.Font
        assert len(fonts) >= 2
        base14 = [
            f for f in fonts.values() if f.get("/Subtype") == "/Type1" and "/FontFile" not in f
        ]
        assert base14, "expected a base-14 font"

        embedded = []
        for font in fonts.values():
            if font.get("/Subtype") == "/Type0":
                descendant = font.DescendantFonts[0]
                if "/FontFile2" in descendant.FontDescriptor:
                    embedded.append(font)
        assert embedded, "expected an embedded TrueType font"

        used = set()
        for operands, operator in pikepdf.parse_content_stream(page):
            if operator == pikepdf.Operator("Tf"):
                used.add(str(operands[0]))
        assert len(used) >= 2, f"expected text in two fonts, saw {sorted(used)}"


@host_check("comments_pikepdf")
def _comments_pikepdf(data: bytes, comments: int, replies: int) -> None:
    """The saved comments are annotations with /Contents, and each reply has /IRT to its parent."""
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        annots = [a for page in pdf.pages for a in page.get("/Annots", [])]
        with_text = [a for a in annots if "/Contents" in a]
        linked = [a for a in with_text if "/IRT" in a]
        assert len(with_text) == comments, len(with_text)
        assert len(linked) == replies, len(linked)


@host_check("comment_replies_pikepdf")
def _comment_replies_pikepdf(data: bytes, parent: str, replies: list[list[str]]) -> None:
    """The replies to the comment named ``parent``, in file order, as [/Contents, state] pairs.

    Each reply has /IRT to the parent. A text reply has /State None, and a status has its review
    state with /StateModel Review (what Acrobat reads as a status). The state is "" for a text
    reply. MuPDF writes /State and /StateModel as text strings, so the leading slash is dropped.
    """
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        annots = [a for page in pdf.pages for a in page.get("/Annots", [])]
        targets = [a for a in annots if str(a.get("/NM", "")) == parent]
        assert len(targets) == 1, len(targets)
        found: list[list[str]] = []
        for annot in annots:
            irt = annot.get("/IRT")
            if irt is None or irt.objgen != targets[0].objgen:
                continue
            state = str(annot.get("/State", "None")).lstrip("/")
            if state == "None":
                state = ""
            else:
                assert str(annot.get("/StateModel", "")).lstrip("/") == "Review"
            found.append([str(annot.get("/Contents", "")), state])
        assert found == replies, found


@host_check("irt_states_pikepdf")
def _irt_states_pikepdf(data: bytes, states: list[str]) -> None:
    """Every annotation that replies to another (/IRT), in file order, as its review state: "" for
    a text reply, or the status name for a status (/StateModel Review). The parent's name is made by
    the engine, so the check does not name it (comment_replies_pikepdf needs it)."""
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        annots = [a for page in pdf.pages for a in page.get("/Annots", [])]
        found: list[str] = []
        for annot in annots:
            if "/IRT" not in annot:
                continue
            state = str(annot.get("/State", "None")).lstrip("/")
            if state == "None":
                state = ""
            else:
                assert str(annot.get("/StateModel", "")).lstrip("/") == "Review"
            found.append(state)
        assert found == states, found


@host_check("comment_contents_pikepdf")
def _comment_contents_pikepdf(data: bytes, comment: str, contents: str | None) -> None:
    """The comment named ``comment`` has /Contents ``contents``; None means no comment has that name
    (it was deleted, and so is its /IRT link to any reply)."""
    import pikepdf

    with pikepdf.open(io.BytesIO(data)) as pdf:
        annots = [a for page in pdf.pages for a in page.get("/Annots", [])]
        targets = [a for a in annots if str(a.get("/NM", "")) == comment]
        if contents is None:
            assert targets == [], len(targets)
            return
        assert len(targets) == 1, len(targets)
        assert str(targets[0].get("/Contents", "")) == contents


# -- bookmarks (W5.2 S1) -------------------------------------------------------------------------


@host_check("outline_pdfium")
def _outline_pdfium(data: bytes, rows: list[list[Any]], password: str = "") -> None:
    """The saved bookmark tree as ``[level, title, page index]`` rows, from pypdfium2."""
    import pypdfium2 as pdfium

    pd = pdfium.PdfDocument(data, password=password or None)
    try:
        found = []
        for item in pd.get_toc():
            dest = item.get_dest()
            found.append([item.level + 1, item.get_title(), dest.get_index() if dest else -1])
    finally:
        pd.close()
    assert found == rows, found
