"""Sanitizing leak checks through MuPDF itself (backend test: uses PyMuPDF directly).

MuPDF's extraction hides OFF layers and clips to the page, so the checks switch every layer
on and read the raw text trace, which reports every glyph wherever it is drawn.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path

import pymupdf
import pytest

from pdfeditor.engine.base import SaveOptions
from pdfeditor.engine.mupdf import sanitize as scrub
from pdfeditor.engine.registry import get_engine
from pdfeditor.model.redaction import SanitizeOptions
from tests.hostcheck import record


def _all_text(path: Path) -> str:
    doc = pymupdf.open(path)
    try:
        for layer in doc.layer_ui_configs():
            doc.set_layer_ui_config(layer["number"], 0)  # switch on
        traced = "|".join(
            "".join(chr(c[0]) for c in span["chars"])
            for page in doc
            for span in page.get_texttrace()
        )
        return traced + "|" + "|".join(page.get_text() for page in doc)
    finally:
        doc.close()


def _sanitized(fixture_pdf, tmp_path: Path, name: str) -> Path:
    path = tmp_path / f"{name}.pdf"
    shutil.copy2(fixture_pdf(name), path)
    doc = get_engine("mupdf").open(path)
    doc.sanitize(SanitizeOptions())
    doc.save(options=SaveOptions(garbage=4))
    doc.close()
    return path


def test_hidden_layer_text_gone_even_with_all_layers_on(fixture_pdf, tmp_path: Path) -> None:
    before = _all_text(fixture_pdf("hidden_layers"))
    for secret in (
        "Hidden layer secret",
        "Membership secret",
        "Hidden form secret",
        "Nested form secret",
        "Hidden note secret",
    ):
        assert secret in before  # the check can see hidden-layer text
    after = _all_text(_sanitized(fixture_pdf, tmp_path, "hidden_layers"))
    assert "secret" not in after.lower()
    assert "Always visible" in after and "Visible form text" in after


def test_off_page_text_gone_from_text_trace(fixture_pdf, tmp_path: Path) -> None:
    before = _all_text(fixture_pdf("off_page_text"))
    assert "Cropped secret" in before and "Below media secret" in before
    after = _all_text(_sanitized(fixture_pdf, tmp_path, "off_page_text"))
    assert "secret" not in after.lower()
    assert after.count("Visible text stays") == 4  # trace + extraction, two pages
    assert after.count("Stradd") == 4


def test_shared_resources_and_ocmd_policies(tmp_path: Path) -> None:
    """Two pages sharing one resource dictionary, an OCMD kept visible by a shown group and a
    group that starts OFF through /BaseState."""
    doc = pymupdf.open()
    shown = doc.add_ocg("Shown", on=True)
    off = doc.add_ocg("Off", on=False)
    ocmd_visible = doc.set_ocmd(ocgs=[shown, off], policy="AnyOn")
    for i in range(2):
        page = doc.new_page()
        page.insert_text((72, 72), f"Visible {i}", fontsize=12)
        page.insert_text((72, 100), f"Off secret {i}", fontsize=12, oc=off)
        page.insert_text((72, 130), f"Either layer {i}", fontsize=12, oc=ocmd_visible)
    shared = doc.xref_get_key(doc[0].xref, "Resources")[1]
    doc.xref_set_key(doc[1].xref, "Resources", shared)
    path = tmp_path / "shared.pdf"
    doc.save(path)
    doc.close()
    sanitized = get_engine("mupdf").open(path)
    report = sanitized.sanitize(SanitizeOptions())
    sanitized.save(options=SaveOptions(garbage=4))
    sanitized.close()
    assert any("hidden layer" in r for r in report)
    text = _all_text(path)
    assert "secret" not in text.lower()
    assert "Either layer 0" in text and "Either layer 1" in text
    check = pymupdf.open(path)
    # the OFF group is still named by the visible OCMD, so it must stay defined
    assert sorted(v["name"] for v in check.get_ocgs().values()) == ["Off", "Shown"]
    check.close()


def _form_with_secret(path: Path) -> None:
    """A text field holding "secret" and a checkbox that is checked (/AS /Yes) with a /DV of Off,
    so a reset must unset it. PyMuPDF writes each field as a parent with one kid widget."""
    import pikepdf

    doc = pymupdf.open()
    page = doc.new_page()
    text = pymupdf.Widget()
    text.field_type = pymupdf.PDF_WIDGET_TYPE_TEXT
    text.field_name = "Name1"
    text.field_value = "secret"
    text.rect = pymupdf.Rect(72, 100, 300, 120)
    page.add_widget(text)
    box = pymupdf.Widget()
    box.field_type = pymupdf.PDF_WIDGET_TYPE_CHECKBOX
    box.field_name = "Agree"
    box.field_value = True
    box.rect = pymupdf.Rect(72, 150, 92, 170)
    page.add_widget(box)
    doc.save(path)
    doc.close()
    with pikepdf.open(path, allow_overwriting_input=True) as pdf:
        for field in pdf.Root.AcroForm.Fields:
            if str(field.T) == "Agree":
                field.DV = pikepdf.Name.Off
        pdf.save(path)


def _widget_leaks(path: Path, secret: str) -> list[str]:
    """Problems that would still show the old value: a kid widget keeps /AS /Yes, or a widget's
    normal appearance (its drawn text) still carries the secret, or a field keeps it in /V."""
    import pikepdf

    problems: list[str] = []
    with pikepdf.open(path) as pdf:
        for field in pdf.Root.AcroForm.Fields:
            if str(field.get("/V", "")) == secret:
                problems.append(f"{field.T}: /V still {secret}")
            # a field with no kids is its own widget
            for kid in field.get("/Kids") or [field]:
                if str(kid.get("/AS", "")) == "/Yes":
                    problems.append(f"{field.T}: kid keeps /AS /Yes")
                normal = kid.get("/AP", {}).get("/N")
                if isinstance(normal, pikepdf.Stream) and secret.encode() in normal.read_bytes():
                    problems.append(f"{field.T}: kid /AP still draws {secret}")
    return problems


@pytest.mark.desktop_only  # reads the saved file with pikepdf, which the Pyodide run does not have
def test_form_reset_leaks_neither_value_nor_appearance(tmp_path: Path) -> None:
    path = tmp_path / "form.pdf"
    _form_with_secret(path)
    assert _widget_leaks(path, "secret")  # the check sees the value before sanitizing

    doc = get_engine("mupdf").open(path)
    doc.sanitize(SanitizeOptions(form_data=True))
    doc.save(options=SaveOptions(garbage=4))
    doc.close()

    assert _widget_leaks(path, "secret") == []
    check = pymupdf.open(path)
    try:
        values = {w.field_name: w.field_value for w in check[0].widgets()}
        assert "secret" not in values.values()
        assert "secret" not in check[0].get_text()
    finally:
        check.close()
    record("render_size_pdfium", path, page=0, scale=1)


SIGNED = Path(__file__).parent.parent / "fixtures" / "real" / "signed_selfsigned.pdf"


def _signed_copy(tmp_path: Path) -> Path:
    path = tmp_path / "signed.pdf"
    shutil.copy2(SIGNED, path)
    return path


def _sanitize_incrementally(path: Path, options: SanitizeOptions) -> None:
    """Sanitize a signed copy and save it as an incremental update. A full rewrite would break
    the signature's digest even with no edits, so this is the save a signed file needs."""
    doc = get_engine("mupdf").open(path)
    try:
        doc.sanitize(options)
        doc.save(options=SaveOptions(incremental=True))
    finally:
        doc.close()


def _assert_signed_revision_intact(path: Path, signature_status) -> None:
    original = SIGNED.read_bytes()
    assert path.read_bytes()[: len(original)] == original  # the signed bytes are untouched
    statuses = signature_status(path)
    assert statuses and all(s.intact and s.valid for s in statuses)


def _object_text(doc: pymupdf.Document) -> str:
    """Every object and stream in the live document, so a leftover script or XMP shows up."""
    parts: list[str] = []
    for xref in range(1, doc.xref_length()):
        try:
            parts.append(doc.xref_object(xref, compressed=False))
        except RuntimeError:  # a gap or a free entry in the cross-reference table
            continue
        if doc.xref_is_stream(xref):
            parts.append(bytes(doc.xref_stream(xref) or b"").decode("latin-1"))
    return "\n".join(parts)


@pytest.mark.desktop_only  # reads the saved file with pikepdf and pyHanko, not in the Pyodide run
def test_form_reset_keeps_a_signature_value(tmp_path: Path, signature_status) -> None:
    """The /V of a /FT /Sig field is the signature dictionary; a form reset must not clear it."""
    import pikepdf

    path = _signed_copy(tmp_path)
    with pikepdf.open(path) as before:
        field = before.Root.AcroForm.Fields[0]
        assert str(field.FT) == "/Sig" and field.V.Type == "/Sig"
        expected = (
            [int(x) for x in field.V.ByteRange],
            bytes(field.V.Contents),
        )

    _sanitize_incrementally(path, SanitizeOptions(form_data=True))

    _assert_signed_revision_intact(path, signature_status)
    with pikepdf.open(path) as after:
        field = after.Root.AcroForm.Fields[0]
        assert str(field.FT) == "/Sig"
        assert isinstance(field.get("/V"), pikepdf.Dictionary)
        assert field.V.Type == "/Sig"
        assert [int(x) for x in field.V.ByteRange] == expected[0]
        assert bytes(field.V.Contents) == expected[1]
    record("render_size_pdfium", path, page=0, scale=1)


@pytest.mark.desktop_only  # reads the saved file with pikepdf and pyHanko, not in the Pyodide run
def test_default_sanitize_on_the_signed_sample(tmp_path: Path, signature_status) -> None:
    """Default options on a signed file used to raise on the xref gap (issue #538). The signed
    revision must survive: sanitize changes the file after signing, but only in the update."""
    import pikepdf

    path = _signed_copy(tmp_path)
    with pikepdf.open(SIGNED) as original:
        field = original.Root.AcroForm.Fields[0]
        expected = ([int(x) for x in field.V.ByteRange], bytes(field.V.Contents))

    _sanitize_incrementally(path, SanitizeOptions())

    _assert_signed_revision_intact(path, signature_status)
    with pikepdf.open(path) as after:
        field = after.Root.AcroForm.Fields[0]
        assert str(field.FT) == "/Sig" and field.V.Type == "/Sig"
        assert [int(x) for x in field.V.ByteRange] == expected[0]
        assert bytes(field.V.Contents) == expected[1]
    record("render_size_pdfium", path, page=0, scale=1)


def test_xref_gap_is_sanitized_past_the_gap(fixture_pdf, tmp_path: Path) -> None:
    """Object 7 is declared by no cross-reference section. PyMuPDF's scrub() raises there; the
    JavaScript action and XMP stream above the gap must still be scrubbed."""
    path = tmp_path / "xref_gap.pdf"
    shutil.copy2(fixture_pdf("xref_gap"), path)
    doc = get_engine("mupdf").open(path)
    report = doc.sanitize(SanitizeOptions())
    assert "JavaScript" in report and "XMP metadata" in report
    # garbage=0 keeps unreferenced objects, so the action object itself is checked, not just
    # the catalog entry that points at it
    doc.save(options=SaveOptions(garbage=0))
    doc.close()

    check = pymupdf.open(path)
    try:
        assert "gap secret" not in _object_text(check)
        assert "xmp secret" not in _object_text(check)
        assert check.get_xml_metadata() == ""
        assert check[0].get_text().strip() == "Visible text"
    finally:
        check.close()
    record("render_size_pdfium", path, page=0, scale=1)


def _with_script_and_xmp(src: Path, dst: Path) -> None:
    doc = pymupdf.open(src)
    doc.set_xml_metadata("<x:xmpmeta>xmp</x:xmpmeta>")
    action = doc.get_new_xref()
    doc.update_object(action, "<</S/JavaScript/JS(app.alert('scrub check');)>>")
    doc.xref_set_key(doc.pdf_catalog(), "OpenAction", f"{action} 0 R")
    doc.save(dst)
    doc.close()


def test_scrub_objects_matches_pymupdf_scrub_without_gaps(fixture_pdf, tmp_path: Path) -> None:
    """On a file with no gaps, the JavaScript and XMP pass must do what PyMuPDF's own scrub()
    does: the same bytes out. This is the no-effect-on-unsigned-files guarantee, and it also
    flags a PyMuPDF change to the scrub loop at the next version bump."""
    outputs: list[bytes] = []
    for mine in (True, False):
        path = tmp_path / f"{'ours' if mine else 'theirs'}.pdf"
        _with_script_and_xmp(fixture_pdf("text_multipage"), path)
        doc = pymupdf.open(path)
        flags = dict(
            attached_files=False,
            clean_pages=False,
            embedded_files=False,
            hidden_text=False,
            metadata=False,
            redactions=False,
            remove_links=False,
            reset_fields=False,
            reset_responses=False,
            thumbnails=False,
        )
        if mine:
            doc.scrub(javascript=False, xml_metadata=False, **flags)
            scrub.scrub_objects(doc, javascript=True, xmp=True)
        else:
            doc.scrub(javascript=True, xml_metadata=True, **flags)
        # MuPDF draws a random second /ID on each save; it is not part of the comparison
        outputs.append(re.sub(rb"<[0-9A-Fa-f]+><[0-9A-Fa-f]+>", b"", doc.tobytes(garbage=0)))
        doc.close()
    assert b"app.alert" not in outputs[0]  # the pass did change the file
    assert outputs[0] == outputs[1]
