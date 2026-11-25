"""Embedded files list: save to disk, add, remove, and open a PDF attachment (W7.9 A3)."""

from __future__ import annotations

import tempfile
from pathlib import Path

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QFileDialog,
    QHBoxLayout,
    QMessageBox,
    QPushButton,
    QTreeWidget,
    QTreeWidgetItem,
    QVBoxLayout,
    QWidget,
)

from pdfeditor.actions import attachments as attachment_actions
from pdfeditor.actions.attachments import (
    ADD_SIGNED_REFUSED,
    REMOVE_SIGNED_REFUSED,
    AddAttachment,
    RemoveAttachment,
    clean_filename,
)
from pdfeditor.core.commands import ChangeKind
from pdfeditor.ui.action_errors import run_action
from pdfeditor.ui.panels.base import EmptyState, ViewPanel

# An attachment is opened as a PDF only when its bytes start with this header (the spec allows
# junk before it, within the first 1024 bytes); the name is never trusted.
PDF_HEADER = b"%PDF-"


def human_size(n: int) -> str:
    size = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{n} B"


class AttachmentsPanel(ViewPanel):
    title = "Attachments"
    # Add and Remove are undoable edits, so the list follows Undo and Redo as well.
    rebuild_on = frozenset({ChangeKind.STRUCTURE, ChangeKind.METADATA})
    # The main window opens this file (a temporary copy of a PDF attachment) as a new document.
    open_requested = Signal(object)

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.tree = QTreeWidget(self)
        self.tree.setHeaderLabels(["Name", "Size", "Description"])
        self.tree.setRootIsDecorated(False)
        self.tree.itemDoubleClicked.connect(lambda *_: self.save_selected())
        self.tree.itemSelectionChanged.connect(self._update_buttons)
        self.add_button = QPushButton("Add…", self)
        self.add_button.clicked.connect(self.add_file)
        self.remove_button = QPushButton("Remove", self)
        self.remove_button.clicked.connect(self.remove_selected)
        self.open_button = QPushButton("Open", self)
        self.open_button.clicked.connect(self.open_selected)
        self.save_button = QPushButton("Save…", self)
        self.save_button.clicked.connect(self.save_selected)
        self.empty = EmptyState(
            "paperclip",
            "No attachments",
            "Files embedded in this PDF, such as spreadsheets or source documents, are listed "
            "here. Add a file to embed it in the PDF.",
            self,
        )
        self.empty.set_action("Add…", slot=self.add_file)
        buttons = QHBoxLayout()
        buttons.addWidget(self.add_button)
        buttons.addWidget(self.remove_button)
        buttons.addWidget(self.open_button)
        buttons.addStretch()
        buttons.addWidget(self.save_button)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(self.tree)
        layout.addWidget(self.empty)
        layout.addLayout(buttons)

    def rebuild(self) -> None:
        self.tree.clear()
        if self.view is not None:
            with self.view.session.lock:
                files = self.view.session.document.embedded_files()
            for f in files:
                node = QTreeWidgetItem([f.filename, human_size(f.size), f.description])
                node.setData(0, Qt.ItemDataRole.UserRole, f.name)
                self.tree.addTopLevelItem(node)
        has_files = self.tree.topLevelItemCount() > 0
        self.save_button.setEnabled(has_files)
        self.save_button.setVisible(has_files)
        self.tree.setVisible(has_files)
        self.empty.setVisible(not has_files)
        self._update_buttons()

    def _signed(self) -> bool:
        """Caller ensures a view is bound."""
        assert self.view is not None
        with self.view.session.lock:
            return self.view.session.document.info().has_signatures

    def _selected_node(self) -> QTreeWidgetItem | None:
        nodes = self.tree.selectedItems()
        return nodes[0] if nodes else None

    def _update_buttons(self) -> None:
        # Signed documents refuse Add and Remove; the tooltip gives the action's own reason.
        signed = self.view is not None and self._signed()
        node = self._selected_node()
        self.add_button.setEnabled(self.view is not None and not signed)
        self.add_button.setToolTip(ADD_SIGNED_REFUSED if signed else "")
        self.empty.button.setEnabled(self.view is not None and not signed)
        self.remove_button.setEnabled(node is not None and not signed)
        self.remove_button.setToolTip(REMOVE_SIGNED_REFUSED if signed else "")
        self.open_button.setEnabled(node is not None and node.text(0).lower().endswith(".pdf"))

    def _refused(self, message: str) -> None:
        QMessageBox.warning(self, "Attachments", message)

    def add_file(self) -> None:
        view = self.view
        if view is None:
            return
        chosen, _ = QFileDialog.getOpenFileName(self, "Add attachment")
        if not chosen:
            return
        path = Path(chosen)
        try:
            data = path.read_bytes()
        except OSError as exc:
            QMessageBox.warning(self, "Add attachment", f"Couldn't read the file:\n{exc}")
            return
        run_action(
            lambda: attachment_actions.add(view.session, AddAttachment(data, path.name)),
            self._refused,
        )

    def remove_selected(self) -> None:
        view = self.view
        node = self._selected_node()
        if view is None or node is None:
            return
        answer = QMessageBox.question(
            self,
            "Remove attachment",
            f"Remove {node.text(0)} from this PDF? You can undo this until you close the document.",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if answer != QMessageBox.StandardButton.Yes:
            return
        name = node.data(0, Qt.ItemDataRole.UserRole)
        run_action(
            lambda: attachment_actions.remove(view.session, RemoveAttachment(name)), self._refused
        )

    def open_selected(self) -> None:
        view = self.view
        node = self._selected_node()
        if view is None or node is None:
            return
        with view.session.lock:
            data = view.session.document.extract_embedded_file(
                node.data(0, Qt.ItemDataRole.UserRole)
            )
        if PDF_HEADER not in data[:1024]:
            QMessageBox.warning(self, "Open attachment", f"{node.text(0)} is not a PDF file.")
            return
        # Session temp storage: removed when the document closes, as the undo snapshots are.
        folder = Path(tempfile.mkdtemp(prefix="attachment-", dir=view.session.snapshots.dir))
        target = folder / (clean_filename(node.text(0)) or "attachment.pdf")
        try:
            target.write_bytes(data)
        except OSError as exc:
            QMessageBox.warning(self, "Open attachment", f"Couldn't open the attachment:\n{exc}")
            return
        self.open_requested.emit(target)

    def save_selected(self, target: Path | None = None) -> Path | None:
        node = self.tree.currentItem() or self.tree.topLevelItem(0)
        if node is None or self.view is None:
            return None
        name = node.data(0, Qt.ItemDataRole.UserRole)
        if target is None:
            chosen, _ = QFileDialog.getSaveFileName(self, "Save attachment", node.text(0))
            if not chosen:
                return None
            target = Path(chosen)
        try:
            with self.view.session.lock:
                data = self.view.session.document.extract_embedded_file(name)
            target.write_bytes(data)
        except OSError as exc:
            QMessageBox.warning(self, "Save attachment", f"Couldn't save the attachment:\n{exc}")
            return None
        return target
