"""Protect ribbon: redaction (mark, review, apply, verify) and sanitizing."""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING

from PySide6.QtCore import QSettings, Qt
from PySide6.QtGui import QAction, QActionGroup, QMouseEvent
from PySide6.QtWidgets import QGraphicsView, QInputDialog, QLineEdit, QMessageBox

import pdfeditor.actions.redaction as redaction_actions
import pdfeditor.actions.security as security_actions
from pdfeditor.actions.base import Busy, Refused
from pdfeditor.actions.redaction import ApplyRedactions, MarkForRedaction, RemoveRedactionMarks
from pdfeditor.actions.security import RemoveSecurity, SanitizeDocument, SetSecurity
from pdfeditor.model.annotations import AnnotationModel
from pdfeditor.model.color import Color
from pdfeditor.model.geometry import Point, Quad, Rect
from pdfeditor.model.metadata import EncryptionMethod
from pdfeditor.model.redaction import MarkRef, RedactionArea
from pdfeditor.services.redaction import (
    MarkStyle,
    VerificationReport,
    find_sensitive,
    redaction_marks,
)
from pdfeditor.ui.dialogs.redaction import (
    ApplyRedactionsDialog,
    MarkTextDialog,
    RedactionPropertiesDialog,
    SanitizeDialog,
)
from pdfeditor.ui.dialogs.security import SecurityDialog
from pdfeditor.ui.icons import icon
from pdfeditor.ui.panels.redactions import RedactionsPanel
from pdfeditor.ui.toasts import undo_action
from pdfeditor.ui.tools.base import Tool

if TYPE_CHECKING:
    from pdfeditor.core.session import DocumentSession
    from pdfeditor.ui.main_window import MainWindow
    from pdfeditor.ui.view.document_view import DocumentView


class RedactTool(Tool):
    """Drag a box over anything (text, images, graphics) to mark it for redaction."""

    name = "redact"
    respects_existing = True  # clicking an existing mark selects it

    def __init__(self, controller: ProtectController) -> None:
        self.controller = controller
        self._start: tuple[int, Point] | None = None

    def activate(self, view: DocumentView) -> None:
        view.setDragMode(QGraphicsView.DragMode.NoDrag)

    def hover(self, view: DocumentView, event: QMouseEvent) -> None:
        view.viewport().setCursor(Qt.CursorShape.CrossCursor)

    def press(self, view: DocumentView, event: QMouseEvent) -> bool:
        if event.button() != Qt.MouseButton.LeftButton:
            return False
        self._start = view.page_point_at(view.mapToScene(event.position().toPoint()))
        return self._start is not None

    def move(self, view: DocumentView, event: QMouseEvent) -> bool:
        if self._start is None:
            return False
        page, a = self._start
        b = view.scene_to_page(page, view.mapToScene(event.position().toPoint()))
        view.set_annotation_preview({page: [Rect.from_points([a, b])]})
        return True

    def release(self, view: DocumentView, event: QMouseEvent) -> bool:
        if self._start is None:
            return False
        page, a = self._start
        self._start = None
        view.set_annotation_preview({})
        b = view.scene_to_page(page, view.mapToScene(event.position().toPoint()))
        if abs(b.x - a.x) < 3 or abs(b.y - a.y) < 3:
            return True
        rect = Rect.from_points([a, b]).intersection(view.page_rect(page))
        self.controller.add_marks(view, [RedactionArea(page, rect)], "Mark for Redaction")
        view.tool_used.emit()
        return True


class ProtectController:
    def __init__(
        self, window: MainWindow, tool_group: QActionGroup, tool_actions: dict[str, QAction]
    ) -> None:
        self.w = window
        self.style = self._load_style()
        tool = QAction(icon("eraser"), "&Redact", window, checkable=True)
        tool.setProperty("needs_doc", True)
        tool.setToolTip("Drag over content to mark it for redaction (or mark the selected text)")
        tool.triggered.connect(lambda _=False: self.start_redact_tool())
        tool_group.addAction(tool)
        tool_actions["redact"] = tool
        self.act_redact = tool

        def act(
            text: str, icon_name: str, slot: Callable[[], object], needs_doc: bool = True
        ) -> QAction:
            a = QAction(icon(icon_name), text, window)
            a.triggered.connect(lambda _=False: slot())
            a.setProperty("needs_doc", needs_doc)
            window.addAction(a)
            return a

        self.act_mark_text = act("&Find Text to Redact…", "text-search", self.find_and_mark)
        self.act_mark_pages = act("Mark Whole &Pages", "file-lock", self.mark_pages)
        self.act_properties = act(
            "Redaction &Properties…", "settings-2", self.edit_properties, needs_doc=False
        )
        self.act_apply = act("&Apply Redactions…", "check-check", lambda: self.apply(None))
        self.act_sanitize = act("&Sanitize Document…", "brush-cleaning", self.sanitize)
        self.act_encrypt = act("&Encrypt with Password…", "lock", self.encrypt)
        self.act_remove_security = act("Remove &Security", "lock-open", self.remove_security)
        self.last_message = ""
        self.panel = RedactionsPanel()
        self.panel.on_apply = self.apply
        self.panel.on_remove = self.remove_marks

    # -- settings -------------------------------------------------------------------------
    @staticmethod
    def _load_style() -> MarkStyle:
        s = QSettings()
        try:
            fill = Color.from_hex(str(s.value("redaction/fill", "#000000")))
            text_color = Color.from_hex(str(s.value("redaction/text_color", "#ffffff")))
        except ValueError:
            return MarkStyle()
        return MarkStyle(fill, str(s.value("redaction/overlay", "")), text_color)

    def edit_properties(self, dialog: RedactionPropertiesDialog | None = None) -> None:
        dialog = dialog or RedactionPropertiesDialog(self.style, self.w)
        if not dialog.result() and not dialog.exec():
            return
        self.style = dialog.mark_style()
        s = QSettings()
        s.setValue("redaction/fill", self.style.fill.to_hex())
        s.setValue("redaction/overlay", self.style.overlay_text)
        s.setValue("redaction/text_color", self.style.text_color.to_hex())

    def ribbon(self) -> None:
        r = self.w.ribbon.add_tab("Protect")
        r.add_group(
            self.act_redact,
            self.act_mark_text,
            self.act_mark_pages,
            self.act_properties,
            self.act_apply,
            title="Redact",
        )
        r.add_group(self.act_sanitize, title="Clean Up")
        if self.w.engine().capabilities.encrypt:
            r.add_group(self.act_encrypt, self.act_remove_security, title="Security")

    # -- marking --------------------------------------------------------------------------
    def add_marks(self, view: DocumentView, areas: list[RedactionArea], label: str) -> bool:
        """Mark the areas as one undo step. False only when the session was busy and the marks
        weren't added (the BLOCKED event has already told the user)."""
        try:
            redaction_actions.mark(
                view.session, MarkForRedaction(tuple(areas), self.style, view.author, label)
            )
        except Busy:
            return False
        return True

    def start_redact_tool(self) -> None:
        """With text selected, mark the selection at once; otherwise switch to the box tool
        (or, if it's already active, back to Select)."""
        if self.w.current_tool == "redact":
            self.w.set_tool("select")
            return
        view = self.w.current_view()
        if view is not None and view.has_selection() and view.selection is not None:
            areas: list[RedactionArea] = []
            for page, rects in view.selection.rects(view.text_cache).items():
                if not rects:
                    continue
                box = rects[0]
                for r in rects[1:]:
                    box = box.union(r)
                areas.append(RedactionArea(page, box, tuple(Quad.from_rect(r) for r in rects)))
            view.clear_selection()
            self.add_marks(view, areas, "Mark Selection for Redaction")
            self.w.tool_actions[self.w.current_tool].setChecked(True)
            return
        self.w.set_tool("redact")

    def mark_dialog(self, view: DocumentView) -> MarkTextDialog:
        """The Find Text to Redact dialog, with its Find button searching ``view``."""
        dialog = MarkTextDialog(self.w)

        def search() -> None:
            dialog.show_hits(find_sensitive(view.text_cache, dialog.patterns()), view.page_label)

        dialog.search_button.clicked.connect(search)
        return dialog

    def find_and_mark(self, dialog: MarkTextDialog | None = None) -> int:
        view = self.w.current_view()
        if view is None:
            return 0
        dialog = dialog or self.mark_dialog(view)
        if not dialog.result() and not dialog.exec():
            return 0
        hits = dialog.selected_hits()
        areas = [
            RedactionArea(
                h.page_index, h.rect, tuple(Quad.from_rect(q.rect) for q in h.quads), h.text
            )
            for h in hits
        ]
        if not self.add_marks(view, areas, "Mark Text for Redaction"):
            return 0  # busy: the marks weren't added, so there is nothing to show
        self.show_panel()
        return len(hits)

    def mark_pages(self) -> None:
        tab = self.w.current_tab()
        if tab is None:
            return
        view = tab.view
        areas = [RedactionArea(p, view.page_rect(p)) for p in tab.target_pages()]
        self.add_marks(view, areas, "Mark Pages for Redaction")

    def remove_marks(self, marks: list[AnnotationModel]) -> None:
        view = self.w.current_view()
        if view is None or not marks:
            return
        refs = tuple(MarkRef(m.page_index, m.name) for m in marks)
        try:
            redaction_actions.remove_marks(view.session, RemoveRedactionMarks(refs))
        except Busy:
            return

    def show_panel(self) -> None:
        self.w.show_panel(self.panel)

    # -- applying -------------------------------------------------------------------------
    def apply(
        self, marks: list[AnnotationModel] | None, dialog: ApplyRedactionsDialog | None = None
    ) -> VerificationReport | None:
        view = self.w.current_view()
        if view is None:
            return None
        all_marks = self.panel.marks() if self.panel.view is view else self._all_marks(view)
        if not all_marks:
            QMessageBox.information(
                self.w, "Apply Redactions", "There are no redaction marks to apply."
            )
            return None
        dialog = dialog or ApplyRedactionsDialog(
            len(all_marks),
            len(marks or []),
            self.w,
            total_pages=len({m.page_index for m in all_marks}),
            selected_pages=len({m.page_index for m in marks or []}),
        )
        if not dialog.result() and not dialog.exec():
            return None
        chosen = marks if (marks and dialog.selected.isChecked()) else all_marks
        # None means "every mark", so the action needs no names for marks chosen one by one
        refs = (
            None
            if len(chosen) == len(all_marks)
            else tuple(MarkRef(m.page_index, m.name) for m in chosen)
        )
        try:
            result = redaction_actions.apply(view.session, ApplyRedactions(refs, dialog.options()))
        except Busy:
            return None  # nothing was applied, so there is nothing to verify
        except Refused as exc:
            QMessageBox.information(self.w, "Apply Redactions", str(exc))
            return None
        self._report(result.value)
        return result.value

    @staticmethod
    def _all_marks(view: DocumentView) -> list[AnnotationModel]:
        with view.session.lock:
            return redaction_marks(view.session.document)

    def _report(self, report: VerificationReport) -> None:
        if report.ok:
            details = f"Verified {report.areas} area(s)"
            if report.images_checked:
                details += f" and {report.images_checked} image(s)"
            message = f"{details}: no text or image content is left under the redactions."
            if report.unverified:
                message += "\n\nNot verified:\n" + "\n".join(report.unverified)
            self.w.notify(message.splitlines()[0], "success")
            self.last_message = message
        else:
            self.last_message = "Some content may still be readable:\n\n" + "\n".join(report.leaks)
            QMessageBox.warning(self.w, "Redaction Check", self.last_message)

    def sanitize(self, dialog: SanitizeDialog | None = None) -> list[str]:
        view = self.w.current_view()
        if view is None:
            return []
        dialog = dialog or SanitizeDialog(self.w)
        if not dialog.result() and not dialog.exec():
            return []
        session = view.session
        try:
            result = security_actions.sanitize(session, SanitizeDocument(dialog.options()))
        except Busy:
            return []  # the BLOCKED event has already told the user
        except Refused as exc:
            QMessageBox.warning(self.w, "Sanitize Document", str(exc))
            return []
        removed = list(result.value)
        summary = ("Removed: " + "; ".join(removed)) if removed else "Nothing needed removing."
        self.last_message = summary + "\n\nSave the document to write the cleaned file."
        self.w.notify(summary, "success", undo_action(session) if removed else None)
        return removed

    last_message = ""

    # -- password security --------------------------------------------------------------------
    def owner_access(self, session: DocumentSession, owner_password: str | None) -> bool:
        """Changing security needs the owner password when the document already has one."""
        with session.lock:
            if session.document.has_owner_access():
                return True
        if owner_password is None:
            owner_password, ok = QInputDialog.getText(
                self.w,
                "Permissions Password",
                "This document is protected. Enter its permissions (owner) password to change "
                "its security:",
                QLineEdit.EchoMode.Password,
            )
            if not ok:
                return False
        with session.lock:
            unlocked = session.document.unlock_owner(owner_password)
        if not unlocked:
            QMessageBox.warning(self.w, "Security", "That permissions password is not correct.")
        return unlocked

    def _notify(self, message: str) -> None:
        self.last_message = message
        self.w.notify(message)

    def encrypt(
        self, dialog: SecurityDialog | None = None, owner_password: str | None = None
    ) -> bool:
        view = self.w.current_view()
        if view is None:
            return False
        session = view.session
        if not self.owner_access(session, owner_password):
            return False
        if dialog is None:
            with session.lock:
                current = session.document.info().permissions
            dialog = SecurityDialog(current, self.w)
        if not dialog.result() and not dialog.exec():
            return False
        try:
            security_actions.set_security(session, SetSecurity(dialog.settings()))
        except Busy:
            return False
        except Refused as exc:
            QMessageBox.warning(self.w, "Security", str(exc))
            return False
        self._notify("Password security will be applied when you save the document.")
        return True

    def remove_security(self, owner_password: str | None = None) -> bool:
        view = self.w.current_view()
        if view is None:
            return False
        session = view.session
        with session.lock:
            doc = session.document
            encrypted = doc.info().encryption is not EncryptionMethod.NONE
            pending = doc.pending_security()
        if not encrypted and (pending is None or pending.method is EncryptionMethod.NONE):
            QMessageBox.information(self.w, "Remove Security", "This document has no security.")
            return False
        if encrypted and not self.owner_access(session, owner_password):
            return False
        if encrypted and not self.w.confirm(
            "Remove Security",
            f"Remove the passwords and permission restrictions from “{session.display_name}”. "
            "Once saved, anyone can open, print, copy and change it.",
            "Remove Security",
        ):
            return False
        try:
            security_actions.remove_security(session, RemoveSecurity())
        except Busy:
            return False
        except Refused as exc:
            QMessageBox.information(self.w, "Remove Security", str(exc))
            return False
        if not encrypted:  # only a pending change: it was just dropped
            self._notify("The pending password security was removed.")
            return True
        self._notify("Security will be removed when you save the document.")
        return True
