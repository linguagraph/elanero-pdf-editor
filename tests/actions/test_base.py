"""The shared helpers of the actions layer on a real session (no Qt)."""

from __future__ import annotations

import copy

import pytest

from pdfeditor.actions.base import Busy, execute_command
from pdfeditor.core.commands import AddAnnotationCommand, UpdateAnnotationCommand
from pdfeditor.model.annotations import AnnotationModel, AnnotationType
from pdfeditor.model.color import Color
from pdfeditor.model.geometry import Rect
from tests.actions.conftest import Opener


def _square() -> AnnotationModel:
    return AnnotationModel(AnnotationType.SQUARE, 0, Rect(100, 100, 200, 200), color=Color(1, 0, 0))


def test_merged_edits_are_one_step_and_not_busy(open_copy: Opener) -> None:
    """An update that merges into the previous one leaves the undo top unchanged. That is a
    success, not a refusal, so it must not raise Busy."""
    s = open_copy("text_multipage")
    execute_command(s, AddAnnotationCommand(_square()))
    current = s.document.page(0).annotations()[0]

    moved = copy.deepcopy(current)
    moved.rect = Rect(300, 300, 400, 400)
    execute_command(s, UpdateAnnotationCommand(current, moved, "Move", merge_key="move"))
    moved2 = copy.deepcopy(moved)
    moved2.rect = Rect(310, 310, 410, 410)
    execute_command(s, UpdateAnnotationCommand(moved, moved2, "Move", merge_key="move"))

    assert len(s.undo_stack) == 2  # the add, and one move for both edits
    rect = s.document.page(0).annotations()[0].rect
    assert rect.intersects(Rect(310, 310, 410, 410))


def test_execute_command_raises_busy_while_a_task_runs(open_copy: Opener) -> None:
    s = open_copy("text_multipage")
    s.begin_task("x")
    try:
        with pytest.raises(Busy, match="x"):
            execute_command(s, AddAnnotationCommand(_square()))
    finally:
        s.end_task("x")
    assert not s.undo_stack.can_undo
