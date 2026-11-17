"""Actions with refs made before a full save (issue #168 follow-up).

A full save gives every unnamed comment a real /NM, so the name a caller holds can change under
it. The actions resolve each ref's name through the engine first, so the ref still acts on the
same comment, as it did before the save.
"""

from __future__ import annotations

from pdfeditor.actions import comments, document
from pdfeditor.actions.comments import (
    DeleteAnnotations,
    SetAnnotationText,
    StyleField,
    restyle_args,
)
from pdfeditor.actions.document import FlattenAnnotations
from pdfeditor.model.annotations import AnnotRef
from pdfeditor.model.color import Color
from tests.actions.conftest import Opener


def ref(name: str, page: int = 0) -> AnnotRef:
    return AnnotRef(page, name)


def _page0(s):
    with s.lock:
        return s.document.page(0).annotations()


def test_refs_made_before_a_full_save_still_act_on_their_comment(open_copy: Opener) -> None:
    s = open_copy("annotations_unnamed")
    _, second, third = (a.name for a in _page0(s))
    s.save()  # a full save: every unnamed comment gets a real /NM
    assert all(a.name.startswith("pdfeditor-") for a in _page0(s))

    assert comments.set_text(s, SetAnnotationText(ref(second), "Edited")).executed
    result = comments.restyle(
        s, restyle_args((ref(second),), StyleField.COLOR, Color(0, 1, 0), "Change Color")
    )
    assert result.executed
    edited = next(a for a in _page0(s) if a.contents == "Edited")
    assert edited.color == Color(0, 1, 0)

    flat = document.flatten(s, FlattenAnnotations((ref(third),)))
    assert flat.executed and flat.value == 1
    assert sorted(a.contents for a in _page0(s)) == ["Box one", "Edited"]

    assert comments.delete(s, DeleteAnnotations((ref(second),))).executed
    assert [a.contents for a in _page0(s)] == ["Box one"]
    assert s.undo()
    assert sorted(a.contents for a in _page0(s)) == ["Box one", "Edited"]
