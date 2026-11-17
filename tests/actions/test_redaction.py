"""Redaction actions on real documents: marks, unmarking, applying and the leak check.

No Qt here. The leak tests save the document and check the file with pikepdf and pypdfium2
(independent implementations), not only with MuPDF.
"""

from __future__ import annotations

from pathlib import Path

import pikepdf
import pypdfium2 as pdfium
import pytest

from pdfeditor.actions import run
from pdfeditor.actions.base import Busy, Refused
from pdfeditor.actions.redaction import (
    ApplyRedactions,
    MarkForRedaction,
    RemoveRedactionMarks,
)
from pdfeditor.core.session import DocumentSession
from pdfeditor.engine.base import SaveError
from pdfeditor.model.annotations import AnnotationModel, AnnotationType
from pdfeditor.model.color import WHITE, Color
from pdfeditor.model.geometry import Quad, Rect
from pdfeditor.model.redaction import MarkRef, RedactionArea
from pdfeditor.services.redaction import MarkStyle, find_sensitive, mark_for_area
from pdfeditor.services.text import PageTextIndex
from tests.actions.conftest import Opener, pretend_signed

BUSY_CASES = {
    "redaction.mark": MarkForRedaction((RedactionArea(0, Rect(0, 0, 10, 10)),)),
    "redaction.remove_marks": RemoveRedactionMarks((MarkRef(0, "x"),)),
    "redaction.apply": ApplyRedactions(),
}

STYLE = MarkStyle(Color(0.2, 0.4, 0.6), "REDACTED", WHITE)
UNKNOWN = "A redaction mark to apply no longer exists."
UNNAMED = (
    "Some of the selected marks come from another application and can't be applied one at a "
    "time. Choose “All redaction marks” instead."
)
DUPLICATE = "Two redaction marks share a name; apply all marks instead."


class _Cache:
    """Minimal TextIndexCache stand-in bound to a bare Document (the caller holds the lock)."""

    def __init__(self, doc) -> None:
        self._doc = doc
        self.session = type("S", (), {"page_count": doc.page_count})()

    def get(self, page: int):
        return PageTextIndex(self._doc.page(page).text_page(with_chars=True))


def _hits(session: DocumentSession, patterns: list[str]):
    with session.lock:
        return find_sensitive(_Cache(session.document), patterns)


def _area(hit) -> RedactionArea:
    """The mark a front end makes for a found text match: its box, its runs and its text."""
    return RedactionArea(
        hit.page_index, hit.rect, tuple(Quad.from_rect(q.rect) for q in hit.quads), hit.text
    )


def _marks(session: DocumentSession, page: int = 0) -> list[AnnotationModel]:
    with session.lock:
        return [
            a for a in session.document.page(page).annotations() if a.type is AnnotationType.REDACT
        ]


def _text(session: DocumentSession, page: int = 0) -> str:
    with session.lock:
        return session.document.page(page).text_page(with_chars=False).text


def _mark_hits(session: DocumentSession, patterns: list[str]) -> tuple[MarkRef, ...]:
    hits = _hits(session, patterns)
    result = run(session, "redaction.mark", MarkForRedaction(tuple(map(_area, hits)), STYLE))
    return result.value


def _streams_mention(path: Path, needle: bytes) -> bool:
    """Any decoded stream holds ``needle`` as a literal or hex string (independent of MuPDF)."""
    with pikepdf.open(path) as pdf:
        for obj in pdf.objects:
            if isinstance(obj, pikepdf.Stream):
                try:
                    data = obj.read_bytes().lower()
                except pikepdf.PdfError:
                    continue
                if needle.lower() in data or needle.hex().encode() in data:
                    return True
    return False


def _pdfium_text(path: Path) -> str:
    pd = pdfium.PdfDocument(path)
    try:
        return "\n".join(page.get_textpage().get_text_range() for page in pd)
    finally:
        pd.close()


# -- redaction.mark ------------------------------------------------------------------------


def test_mark_adds_marks_as_one_undo_step(open_copy: Opener) -> None:
    s = open_copy("sensitive")
    email = next(h for h in _hits(s, ["Email addresses"]))
    ssn = next(h for h in _hits(s, ["US Social Security numbers"]))
    areas = (_area(email), RedactionArea(0, ssn.rect))  # one with runs and text, one plain box
    result = run(s, "redaction.mark", MarkForRedaction(areas, STYLE, "Ada", "Mark Two"))

    assert result.label == "Mark Two" and result.executed
    marks = _marks(s)
    assert len(marks) == 2
    # the names returned are the names of the marks now on the page
    assert {(m.page_index, m.name) for m in marks} == {(r.page, r.name) for r in result.value}
    by_text = {m.contents: m for m in marks}
    text_mark = by_text[email.text]
    assert text_mark.overlay_text == "REDACTED" and text_mark.author == "Ada"
    # the engine stores colours as floats, so compare them as hex
    assert text_mark.fill.to_hex() == STYLE.fill.to_hex()
    assert "" in by_text  # the plain box has no text
    s.undo()
    assert _marks(s) == [] and not s.undo_stack.can_undo


def test_mark_with_no_areas_does_nothing(open_copy: Opener) -> None:
    s = open_copy("sensitive")
    result = run(s, "redaction.mark", MarkForRedaction(()))
    assert result.executed is False and result.value == ()
    assert result.label == "Mark for Redaction"
    assert not s.undo_stack.can_undo


def test_mark_that_loses_a_race_with_a_task_raises_busy(
    open_copy: Opener, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A task starting between the idle check and the execute must not look like success."""
    s = open_copy("sensitive")
    real_execute = s.execute

    def task_starts_first(command) -> None:
        s.begin_task("OCR")
        real_execute(command)

    monkeypatch.setattr(s, "execute", task_starts_first)
    with pytest.raises(Busy, match="OCR"):
        run(s, "redaction.mark", MarkForRedaction((RedactionArea(0, Rect(72, 72, 200, 90)),)))
    s.end_task("OCR")
    assert _marks(s) == [] and not s.undo_stack.can_undo


# -- redaction.remove_marks ----------------------------------------------------------------


def test_remove_marks_on_one_page_and_undo(open_copy: Opener) -> None:
    s = open_copy("sensitive")
    refs = _mark_hits(s, ["Email addresses", "US Social Security numbers"])
    result = run(s, "redaction.remove_marks", RemoveRedactionMarks(refs))
    assert result.label == "Remove Redaction Mark" and result.executed
    assert _marks(s) == []
    s.undo()
    assert len(_marks(s)) == 2


def test_remove_marks_on_two_pages_is_one_plural_step(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    refs = []
    for page in (0, 1):
        result = run(
            s, "redaction.mark", MarkForRedaction((RedactionArea(page, Rect(72, 72, 200, 90)),))
        )
        refs.extend(result.value)
    assert len(_marks(s, 0)) == 1 and len(_marks(s, 1)) == 1

    result = run(s, "redaction.remove_marks", RemoveRedactionMarks(tuple(refs)))
    assert result.label == "Remove Redaction Marks" and result.executed
    assert _marks(s, 0) == [] and _marks(s, 1) == []
    s.undo()
    assert len(_marks(s, 0)) == 1 and len(_marks(s, 1)) == 1


def test_remove_with_nothing_to_remove(open_copy: Opener) -> None:
    s = open_copy("sensitive")
    result = run(s, "redaction.remove_marks", RemoveRedactionMarks(()))
    assert result.label == "Remove Redaction Marks" and result.executed is False
    assert not s.undo_stack.can_undo


def test_remove_ignores_a_name_that_is_gone(open_copy: Opener) -> None:
    """A stale selection must not push an empty undo step, nor disturb the marks that remain."""
    s = open_copy("sensitive")
    refs = _mark_hits(s, ["Email addresses", "US Social Security numbers"])
    stale = MarkRef(0, "pdfeditor-no-such-mark")
    email_ref = next(r for r in refs if r.name == _name_of(s, "jane.example@example.com"))
    ssn_ref = next(r for r in refs if r is not email_ref)

    undo_before = s.undo_stack.undo_label
    result = run(s, "redaction.remove_marks", RemoveRedactionMarks((stale,)))
    assert result.executed is False and result.label == "Remove Redaction Marks"
    assert len(_marks(s)) == 2 and s.undo_stack.undo_label == undo_before  # no new step

    result = run(s, "redaction.remove_marks", RemoveRedactionMarks((stale, email_ref)))
    assert result.executed and result.label == "Remove Redaction Mark"
    assert [m.name for m in _marks(s)] == [ssn_ref.name]


def _name_of(session: DocumentSession, contents: str) -> str:
    return next(m.name for m in _marks(session) if m.contents == contents)


# -- redaction.apply -----------------------------------------------------------------------


def test_apply_all_removes_text_and_undo_restores_it(open_copy: Opener) -> None:
    s = open_copy("sensitive")
    _mark_hits(s, ["Email addresses", "US Social Security numbers"])
    result = run(s, "redaction.apply", ApplyRedactions())

    assert result.label == "Apply 2 Redactions"
    assert s.require_full_save
    report = result.value
    assert report.ok, report.leaks
    assert report.images_checked >= 1  # the image under the text was blanked too
    text = _text(s)
    assert "jane.example" not in text and "123-45-6789" not in text
    assert "Public paragraph that must survive." in text
    assert _marks(s) == []

    s.undo()
    assert "jane.example@example.com" in _text(s)
    assert len(_marks(s)) == 2


def test_apply_one_mark_uses_the_singular_label(open_copy: Opener) -> None:
    s = open_copy("sensitive")
    _mark_hits(s, ["Email addresses"])
    result = run(s, "redaction.apply", ApplyRedactions())
    assert result.label == "Apply Redaction"
    assert "jane.example" not in _text(s)


def test_selective_apply_keeps_the_other_marks(open_copy: Opener) -> None:
    s = open_copy("sensitive")
    _mark_hits(s, ["Email addresses", "US Social Security numbers", "Credit card numbers"])
    by_text = {m.contents: MarkRef(m.page_index, m.name) for m in _marks(s)}
    email, ssn, card = (
        by_text[t] for t in ("jane.example@example.com", "123-45-6789", "4111 1111 1111 1111")
    )
    result = run(s, "redaction.apply", ApplyRedactions((email, ssn)))

    assert result.label == "Apply 2 Redactions"
    text = _text(s)
    assert "jane.example" not in text and "123-45-6789" not in text
    assert "Card: 4111 1111 1111 1111" in text  # its mark was not applied, so its text stays
    assert [m.name for m in _marks(s)] == [card.name]


def test_apply_refuses_an_unknown_mark(open_copy: Opener) -> None:
    s = open_copy("sensitive")
    _mark_hits(s, ["Email addresses"])
    with pytest.raises(Refused) as refused:
        run(s, "redaction.apply", ApplyRedactions((MarkRef(0, "nope"),)))
    assert str(refused.value) == UNKNOWN
    assert len(_marks(s)) == 1 and not s.require_full_save
    assert "jane.example@example.com" in _text(s)


def test_apply_refuses_an_unnamed_mark_with_its_own_message(open_copy: Opener) -> None:
    s = open_copy("sensitive")
    _mark_hits(s, ["Email addresses"])
    with pytest.raises(Refused) as refused:
        run(s, "redaction.apply", ApplyRedactions((MarkRef(0, ""),)))
    assert str(refused.value) == UNNAMED
    assert len(_marks(s)) == 1 and not s.require_full_save


def test_selective_apply_of_an_unnamed_mark_applies_it(open_copy: Opener) -> None:
    """A mark from another application has no /NM; the engine gives it a synthetic name (#168),
    so applying it by name works and the redacted text leaves the saved file."""
    s = open_copy("annotations_unnamed")
    (mark,) = _marks(s, page=1)
    assert mark.name and mark.type is AnnotationType.REDACT
    result = run(s, "redaction.apply", ApplyRedactions((MarkRef(1, mark.name),)))
    assert result.label == "Apply Redaction"
    assert _marks(s, page=1) == []
    assert "Sensitive" not in _text(s, page=1)
    s.save()
    assert b"Sensitive" not in s.path.read_bytes()
    assert "Sensitive" not in _pdfium_text(s.path)


def test_apply_refuses_a_name_shared_by_two_marks(open_copy: Opener) -> None:
    s = open_copy("sensitive")
    with s.lock:
        page = s.document.page(0)
        for _ in range(2):
            model = mark_for_area(0, Rect(72, 300, 200, 320))
            model.name = "twin"
            page.add_annotation(model)
    assert [m.name for m in _marks(s)] == ["twin", "twin"]
    with pytest.raises(Refused) as refused:
        run(s, "redaction.apply", ApplyRedactions((MarkRef(0, "twin"),)))
    assert str(refused.value) == DUPLICATE
    assert len(_marks(s)) == 2 and not s.require_full_save


def test_apply_refuses_when_there_are_no_marks(open_copy: Opener) -> None:
    s = open_copy("sensitive")
    with pytest.raises(Refused, match="no redaction marks to apply"):
        run(s, "redaction.apply", ApplyRedactions())
    assert not s.undo_stack.can_undo and not s.require_full_save


def test_in_place_save_after_apply_keeps_no_redacted_text(
    open_copy: Opener, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The in-place save of a file that looks signed takes the incremental path unless
    ``require_full_save`` (set by apply) forces a rewrite. With the flag: one clean revision and no
    trace of the text, in the bytes or in any decoded stream."""
    secret = b"jane.example"

    s = open_copy("sensitive")
    _mark_hits(s, ["Email addresses"])
    run(s, "redaction.apply", ApplyRedactions())
    pretend_signed(s, monkeypatch)
    assert s.require_full_save
    s.save()  # in place
    data = s.path.read_bytes()
    assert data.count(b"%%EOF") == 1
    assert secret not in data and not _streams_mention(s.path, secret)

    # Control: without the flag, the engine itself refuses the incremental save (MuPDF reports
    # that a document changed by redaction can't be saved incrementally), so the file is left
    # alone. The flag is therefore a second guard, not the only one.
    control = open_copy("sensitive")
    _mark_hits(control, ["Email addresses"])
    run(control, "redaction.apply", ApplyRedactions())
    pretend_signed(control, monkeypatch)
    before = control.path.read_bytes()
    control.require_full_save = False
    with pytest.raises(SaveError):
        control.save()
    assert control.path.read_bytes() == before


def test_redacted_image_area_is_one_colour_after_save(open_copy: Opener, tmp_path: Path) -> None:
    """A mark over part of the image: after apply and a save, the pixels under it are one colour
    (the image was blanked), checked by pypdfium2 on the render and by pikepdf on the image."""
    s = open_copy("sensitive")
    plain = MarkStyle(Color(0.2, 0.4, 0.6))  # no overlay label: the area must stay one colour
    area = RedactionArea(0, Rect(60, 90, 250, 200))  # the image is placed at 60..400 x 90..200
    run(s, "redaction.mark", MarkForRedaction((area,), plain))
    result = run(s, "redaction.apply", ApplyRedactions())
    assert result.value.ok and result.value.images_checked >= 1

    out = s.save(tmp_path / "image.pdf")
    render = pdfium.PdfDocument(out)[0].render(scale=1).to_pil().convert("RGB")
    inside = render.crop((66, 96, 244, 194))  # within the mark, clear of its edges
    colours = inside.getcolors(maxcolors=16)
    assert colours is not None and len(colours) == 1, colours
    assert all(abs(c - e) <= 8 for c, e in zip(colours[0][1], (51, 102, 153), strict=True))

    with pikepdf.open(out) as pdf:  # the image under the mark is removed or blanked
        resources = pdf.pages[0].obj.get("/Resources", {})
        for xobject in resources.get("/XObject", {}).values():
            if xobject.get("/Subtype") != "/Image":
                continue
            picture = pikepdf.PdfImage(xobject).as_pil_image().convert("RGB")
            cut = round(picture.width * (250 - 60) / (400 - 60)) - 2
            under = picture.crop((2, 2, cut, picture.height - 2))
            found = under.getcolors(maxcolors=16)
            assert found is not None and len(found) == 1, found


def test_applied_file_leaks_nothing(open_copy: Opener, tmp_path: Path) -> None:
    """Leak test (AGENTS.md): marks over text and over part of the image, saved, then checked
    by MuPDF, pikepdf and pypdfium2."""
    s = open_copy("sensitive")
    _mark_hits(s, ["Email addresses", "US Social Security numbers"])
    image_mark = RedactionArea(0, Rect(60, 90, 250, 200))
    run(s, "redaction.mark", MarkForRedaction((image_mark,)))
    result = run(s, "redaction.apply", ApplyRedactions())
    assert result.value.ok, result.value.leaks
    assert result.value.images_checked >= 1

    out = s.save(tmp_path / "redacted.pdf")
    check = DocumentSession.open(out)
    try:
        mupdf_text = _text(check)
    finally:
        with check.lock:
            check.document.close()
    assert "jane.example" not in mupdf_text and "123-45-6789" not in mupdf_text

    with pikepdf.open(out) as pdf:
        assert len(pdf.pages) == 1
    for secret in (b"jane.example@example.com", b"123-45-6789"):
        assert not _streams_mention(out, secret), secret
    assert b"jane.example" not in out.read_bytes()

    pdfium_text = _pdfium_text(out)
    assert "jane.example" not in pdfium_text and "123-45-6789" not in pdfium_text
    assert "Public paragraph that must survive." in pdfium_text
    rendered = pdfium.PdfDocument(out)[0].render(scale=1).to_pil()
    assert rendered.width > 0 and rendered.height > 0
