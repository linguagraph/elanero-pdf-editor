"""Shared pieces of the actions layer: results, errors and the undo helpers.

Actions return data and raise typed errors; each front end words its own messages. The errors
carry a stable ``code`` that the web maps to a message (W1.3 §2).
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Generic, TypeVar

from pdfeditor.core.commands import Command, MacroCommand, SnapshotCommand
from pdfeditor.core.session import DocumentSession
from pdfeditor.engine.base import Document

T = TypeVar("T")
R = TypeVar("R")


@dataclass(frozen=True, slots=True)
class ActionResult(Generic[T]):
    label: str  # the undo label, as the desktop has always shown it
    value: T  # the action's own result (new indices, a count, ...) or None
    executed: bool = True  # False when there was nothing to do


@dataclass(frozen=True, slots=True)
class ActionSpec:
    name: str
    args: type
    fn: Callable[[DocumentSession, Any], ActionResult[Any]]
    requires: tuple[str, ...] = ()
    long: bool = False


class ActionError(Exception):
    code = "ACTION_ERROR"


class Refused(ActionError):
    code = "REFUSED"


class Busy(ActionError):
    code = "BUSY"


class NotSupported(ActionError):
    code = "NOT_SUPPORTED"


class StaleObject(ActionError):
    code = "STALE_OBJECT"


def ensure_idle(session: DocumentSession) -> None:
    """Raise :class:`Busy` while a background task makes the document read-only.

    ``DocumentSession.execute`` would refuse silently; an action must not report success then.
    ``refuse_while_busy`` still emits the BLOCKED event, so the desktop views show the notice.
    """
    if session.refuse_while_busy():
        raise Busy(session.busy)


def execute_all(session: DocumentSession, commands: Sequence[Command], label: str) -> bool:
    """Run ``commands`` as one undo step: the command itself, a MacroCommand, or nothing."""
    if not commands:
        return False
    if len(commands) == 1:
        session.execute(commands[0])
    else:
        session.execute(MacroCommand(label, list(commands)))
    return True


def snapshot(session: DocumentSession, label: str, op: Callable[[Document], R]) -> R:
    """Run ``op`` as one disk-backed snapshot step and return what it returned."""
    # Checked here as well as in each action: a refused execute would leave ``results`` empty.
    ensure_idle(session)
    results: list[R] = []

    def wrapped(doc: Document) -> None:
        results.append(op(doc))

    session.execute(SnapshotCommand(label, wrapped, session.snapshots))
    if not results:  # a task started between the check and the execute: nothing ran
        raise Busy(session.busy)
    return results[-1]


def plural(n: int, word: str = "Page") -> str:
    """The count and noun for an undo label: "3 Pages", or "Page" alone for one."""
    return f"{n} {word}s" if n != 1 else f"{word}"
