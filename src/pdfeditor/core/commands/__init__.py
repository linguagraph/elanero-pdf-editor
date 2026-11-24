"""Undoable edits: every document mutation goes through a Command on the session's stack."""

from pdfeditor.core.commands.annotation_cmds import (
    AddAnnotationCommand,
    DeleteAnnotationsCommand,
    ReorderAnnotationCommand,
    UpdateAnnotationCommand,
)
from pdfeditor.core.commands.base import Change, ChangeKind, Command, MacroCommand, UndoStack
from pdfeditor.core.commands.document_cmds import (
    AddAttachmentCommand,
    ReorderStructCommand,
    SetAccessibilityCommand,
    SetMetadataCommand,
    SetOutlineCommand,
    SetPageLabelsCommand,
    SetSecurityCommand,
    SetStructElementCommand,
)
from pdfeditor.core.commands.snapshot import SnapshotCommand, SnapshotStore

__all__ = [
    "AddAnnotationCommand",
    "AddAttachmentCommand",
    "Change",
    "ChangeKind",
    "Command",
    "DeleteAnnotationsCommand",
    "MacroCommand",
    "ReorderAnnotationCommand",
    "ReorderStructCommand",
    "SetAccessibilityCommand",
    "SetMetadataCommand",
    "SetOutlineCommand",
    "SetPageLabelsCommand",
    "SetSecurityCommand",
    "SetStructElementCommand",
    "SnapshotCommand",
    "SnapshotStore",
    "UndoStack",
    "UpdateAnnotationCommand",
]
