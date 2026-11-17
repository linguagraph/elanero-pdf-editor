"""Cancellation and progress primitives for long-running work (Qt-free).

Services take a :class:`CancelToken` and an optional progress callback; the UI runs them on a
worker thread (see ``pdfeditor.ui.jobs``).
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from contextlib import AbstractContextManager
from typing import Any, Protocol, runtime_checkable

ProgressFn = Callable[[int, int], None]  # (done, total)


class Cancelled(Exception):
    """Raised inside a job when its token was cancelled."""


class CancelToken:
    def __init__(self) -> None:
        self._event = threading.Event()

    def cancel(self) -> None:
        self._event.set()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def check(self) -> None:
        if self._event.is_set():
            raise Cancelled()


def no_progress(_done: int, _total: int) -> None:
    pass


@runtime_checkable
class JobContext(Protocol):
    """What a job's work function receives. ``ui.jobs.Job`` and ``core.inline_jobs.InlineJob``
    both satisfy it; services never need to know which one they got."""

    token: CancelToken
    label: str
    total: int

    def progress(self, done: int, total: int) -> None: ...

    def status(self, text: str) -> None: ...

    def report(self, value: object) -> None: ...

    def commit(self) -> None: ...

    def hold(self, lock: AbstractContextManager[object]) -> AbstractContextManager[None]: ...


class JobHandle(Protocol):
    def cancel(self) -> None: ...


class JobRunner(Protocol):
    """Runs one work function. The desktop's runner queues it on a thread pool (ui/jobs.py);
    the web's runs it to completion on the calling thread (core/inline_jobs.py)."""

    def start(
        self,
        work: Callable[[JobContext], Any],
        *,
        label: str = "",
        total: int = 0,
        on_done: Callable[[Any], None],
        on_failed: Callable[[str], None],
        on_cancelled: Callable[[], None],
    ) -> JobHandle: ...
