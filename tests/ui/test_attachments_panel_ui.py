"""The Attachments panel's Add, Remove and Open (W7.9 A3), on a real window and document."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pytest
from PySide6.QtWidgets import QFileDialog, QMessageBox

from pdfeditor.core.session import DocumentSession
from pdfeditor.ui.main_window import MainWindow
from pdfeditor.ui.panels.attachments import AttachmentsPanel
from tests.actions.conftest import pretend_signed
from tests.hostcheck import record

pytestmark = [pytest.mark.gui, pytest.mark.desktop_only]

MARKER = "hello from the desktop"


@pytest.fixture
def window(qtbot):
    w = MainWindow()
    # pytest-qt closes the window before this fixture's teardown, and closing a changed
    # document asks whether to save: a modal that would block the run. Discard without asking.
    w.ask_save_changes = lambda _session: QMessageBox.StandardButton.Discard  # type: ignore
    qtbot.addWidget(w)
    w.resize(1100, 800)
    w.show()
    qtbot.waitExposed(w)
    yield w
    w.close()


@pytest.fixture
def opened(window: MainWindow, fixture_pdf: Callable[[str], Path]) -> AttachmentsPanel:
    """The ``attachments`` fixture (notes.txt and brief.pdf) open in the window."""
    assert window.open_path(fixture_pdf("attachments")) is not None
    return window.attachments_panel


def _names(panel: AttachmentsPanel) -> list[str]:
    return [panel.tree.topLevelItem(i).text(0) for i in range(panel.tree.topLevelItemCount())]


def _select(panel: AttachmentsPanel, filename: str) -> None:
    for i in range(panel.tree.topLevelItemCount()):
        item = panel.tree.topLevelItem(i)
        if item.text(0) == filename:
            panel.tree.setCurrentItem(item)
            item.setSelected(True)
            return
    raise AssertionError(f"{filename} is not listed")


def _pick_file(monkeypatch: pytest.MonkeyPatch, path: Path) -> None:
    monkeypatch.setattr(
        QFileDialog, "getOpenFileName", staticmethod(lambda *_a, **_k: (str(path), ""))
    )


def _answer(monkeypatch: pytest.MonkeyPatch, answer: QMessageBox.StandardButton) -> list[str]:
    """Answer the confirmation; returns the texts it was asked with."""
    asked: list[str] = []

    def question(*args: object, **_kwargs: object) -> QMessageBox.StandardButton:
        asked.append(str(args[2]))
        return answer

    monkeypatch.setattr(QMessageBox, "question", staticmethod(question))
    return asked


def test_add_embeds_the_file_and_undo_removes_it(
    window: MainWindow, opened: AttachmentsPanel, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = tmp_path / "hello.txt"
    payload.write_bytes(MARKER.encode() + b"\n")
    _pick_file(monkeypatch, payload)

    opened.add_file()
    assert "hello.txt" in _names(opened)

    session = window.current_view().session
    assert session.undo()
    assert "hello.txt" not in _names(opened)
    assert session.redo()
    assert "hello.txt" in _names(opened)


def test_add_then_save_and_reopen_keeps_the_bytes(
    window: MainWindow, opened: AttachmentsPanel, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = tmp_path / "hello.txt"
    payload.write_bytes(MARKER.encode() + b"\n")
    _pick_file(monkeypatch, payload)
    opened.add_file()

    saved = window.current_view().session.save_bytes("copy").data
    # Independent readers: the attachment's bytes decode from the file, and it still renders.
    record("embedded_bytes_pikepdf", saved, marker=MARKER, present=True)
    record("opens_pdfium", saved)
    record("render_first_page_pdfium", saved)
    reopened_path = tmp_path / "reopened.pdf"
    reopened_path.write_bytes(saved)
    reopened = DocumentSession.open(reopened_path)
    try:
        with reopened.lock:
            assert reopened.document.extract_embedded_file("hello.txt") == payload.read_bytes()
    finally:
        with reopened.lock:
            reopened.document.close()


def test_remove_asks_first_then_removes_and_undo_restores(
    window: MainWindow, opened: AttachmentsPanel, monkeypatch: pytest.MonkeyPatch
) -> None:
    _select(opened, "notes.txt")
    asked = _answer(monkeypatch, QMessageBox.StandardButton.No)
    opened.remove_selected()
    assert len(asked) == 1 and "notes.txt" in asked[0]
    assert "notes.txt" in _names(opened)  # declined: nothing removed

    asked = _answer(monkeypatch, QMessageBox.StandardButton.Yes)
    opened.remove_selected()
    assert len(asked) == 1
    assert "notes.txt" not in _names(opened)

    session = window.current_view().session
    saved = session.save_bytes("copy").data
    record("embedded_bytes_pikepdf", saved, marker="attached notes", present=False)
    record("opens_pdfium", saved)

    assert session.undo()
    assert "notes.txt" in _names(opened)


def test_open_opens_a_pdf_attachment_as_a_new_unsaved_document(
    window: MainWindow, opened: AttachmentsPanel
) -> None:
    before = len(window.views())
    _select(opened, "brief.pdf")
    assert opened.open_button.isEnabled()
    opened.open_selected()
    assert len(window.views()) == before + 1
    # Built from its bytes: no file behind the tab, so Save asks for a name (Save As).
    session = window.views()[-1].session
    assert session.path is None
    assert session.save_target() is None
    assert session.display_name == "brief.pdf"


def test_open_leaves_file_recent_unchanged(window: MainWindow, opened: AttachmentsPanel) -> None:
    recent_before = list(window.recent.files())
    _select(opened, "brief.pdf")
    opened.open_selected()
    assert window.recent.files() == recent_before


def test_open_writes_no_temp_file_under_the_parent_snapshots(
    window: MainWindow, opened: AttachmentsPanel
) -> None:
    parent = window.current_view().session
    _select(opened, "brief.pdf")
    opened.open_selected()
    # The attachment is opened from memory; nothing is left in the parent's snapshot folder.
    assert not list(parent.snapshots.dir.glob("attachment-*"))


def test_save_on_an_opened_attachment_asks_for_a_new_path(
    window: MainWindow,
    opened: AttachmentsPanel,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _select(opened, "brief.pdf")
    opened.open_selected()
    view = window.views()[-1]
    asked: list[str] = []
    monkeypatch.setattr(window, "choose_save_path", lambda start: asked.append(start) or None)
    assert window.save(view) is False  # Save asks; the attachment's parent is not touched
    assert len(asked) == 1

    target = tmp_path / "brief-copy.pdf"
    monkeypatch.setattr(window, "choose_save_path", lambda _start: target)
    assert window.save(view) is True
    record("opens_pdfium", target.read_bytes())


def test_open_of_a_non_pdf_attachment_warns_and_opens_nothing(
    window: MainWindow, opened: AttachmentsPanel, monkeypatch: pytest.MonkeyPatch
) -> None:
    warnings: list[str] = []

    def warn(*args: object, **_kwargs: object) -> QMessageBox.StandardButton:
        warnings.append(str(args[2]))
        return QMessageBox.StandardButton.Ok

    monkeypatch.setattr(QMessageBox, "warning", staticmethod(warn))
    before = len(window.views())
    _select(opened, "notes.txt")
    assert opened.open_button.isEnabled()  # enabled for any file; the header decides on click
    opened.open_selected()
    assert warnings and "not a PDF" in warnings[0]
    assert len(window.views()) == before


def test_signed_document_disables_add_and_remove(
    window: MainWindow, opened: AttachmentsPanel, monkeypatch: pytest.MonkeyPatch
) -> None:
    pretend_signed(window.current_view().session, monkeypatch)
    opened.rebuild()
    _select(opened, "notes.txt")
    assert not opened.add_button.isEnabled()
    assert not opened.remove_button.isEnabled()
    assert "signed" in opened.add_button.toolTip()
    assert "signed" in opened.remove_button.toolTip()
