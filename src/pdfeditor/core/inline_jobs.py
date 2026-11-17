"""Runs a job to completion on the calling thread (Qt-free, no threads).

The web's job worker is a Pyodide worker that runs one job at a time. Pyodide has no threads
(docs/web/spikes/W0.4-results.md, C6), so there is no pool to hand a job to:
:meth:`InlineRunner.start` runs the work on the caller and returns only when the job has ended.
That blocking is the point, and it is safe only because the caller is a dedicated worker that
does nothing else meanwhile.
The desktop never uses this; it runs jobs on a thread pool (``pdfeditor.ui.jobs``).
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from typing import Any

from pdfeditor.core.jobs import Cancelled, CancelToken, JobContext, JobHandle

log = logging.getLogger(__name__)

ProgressObserver = Callable[[int, int], None]  # (done, total)
StatusObserver = Callable[[str], None]
ReportObserver = Callable[[object], None]


def _ignore_progress(_done: int, _total: int) -> None:
    pass


def _ignore_status(_text: str) -> None:
    pass


def _ignore_report(_value: object) -> None:
    pass


class InlineJob:
    """The :class:`~pdfeditor.core.jobs.JobContext` a work function gets from
    :class:`InlineRunner`.

    ``cancel()`` is the job's handle (see ``JobHandle``). During a synchronous run it takes
    effect at the next ``token.check()``, and it can only be reached from a callback that runs on
    the same thread, such as an ``on_progress`` observer.
    """

    def __init__(
        self,
        *,
        label: str = "",
        total: int = 0,
        on_progress: ProgressObserver = _ignore_progress,
        on_status: StatusObserver = _ignore_status,
        on_report: ReportObserver = _ignore_report,
    ) -> None:
        self.token = CancelToken()
        self.label = label
        self.total = total
        self.committed = False
        self._on_progress = on_progress
        self._on_status = on_status
        self._on_report = on_report

    def progress(self, done: int, total: int) -> None:
        self._on_progress(done, total)

    def status(self, text: str) -> None:
        self._on_status(text)

    def report(self, value: object) -> None:
        self._on_report(value)

    def commit(self) -> None:
        self.committed = True

    @contextmanager
    def hold(self, lock: AbstractContextManager[object]) -> Iterator[None]:
        """Hold ``lock`` for the body. Unlike the desktop's ``Job.hold`` this never yields at
        :meth:`progress`: no other thread can be waiting for the lock, so there is nothing to
        yield to."""
        with lock:
            yield

    def cancel(self) -> None:
        self.token.cancel()


class InlineRunner:
    """Runs each job on the calling thread, once, and reports how it ended through the
    callbacks given to :meth:`start`. Exactly one of ``on_done``, ``on_failed`` or
    ``on_cancelled`` is called per start."""

    def __init__(
        self,
        *,
        on_progress: ProgressObserver = _ignore_progress,
        on_status: StatusObserver = _ignore_status,
        on_report: ReportObserver = _ignore_report,
    ) -> None:
        self._on_progress = on_progress
        self._on_status = on_status
        self._on_report = on_report

    def start(
        self,
        work: Callable[[JobContext], Any],
        *,
        label: str = "",
        total: int = 0,
        on_done: Callable[[Any], None],
        on_failed: Callable[[str], None],
        on_cancelled: Callable[[], None],
    ) -> JobHandle:
        job = InlineJob(
            label=label,
            total=total,
            on_progress=self._on_progress,
            on_status=self._on_status,
            on_report=self._on_report,
        )
        # The callbacks run outside the try blocks, so a failing on_done is not reported twice.
        if job.token.cancelled:
            on_cancelled()
            return job
        try:
            result = work(job)
        except Cancelled:
            on_cancelled()
            return job
        except Exception as exc:
            log.exception("background job failed")
            on_failed(str(exc))
            return job
        # Same rule as ui.jobs.Job.run: a cancel after the job committed to its change comes
        # too late, so the result is delivered.
        if job.token.cancelled and not job.committed:
            on_cancelled()
        else:
            on_done(result)
        return job
