"""InlineRunner runs a job to completion on the calling thread (no Qt)."""

from __future__ import annotations

import threading
from typing import Any

import pytest

from pdfeditor.core.inline_jobs import InlineJob, InlineRunner
from pdfeditor.core.jobs import Cancelled, JobContext


class Recorder:
    def __init__(self) -> None:
        self.done: list[Any] = []
        self.failed: list[str] = []
        self.cancelled = 0

    def kwargs(self) -> dict[str, Any]:
        return {
            "on_done": self.done.append,
            "on_failed": self.failed.append,
            "on_cancelled": self._on_cancelled,
        }

    def _on_cancelled(self) -> None:
        self.cancelled += 1

    def terminal_calls(self) -> int:
        return len(self.done) + len(self.failed) + self.cancelled


def test_done_receives_the_return_value() -> None:
    rec = Recorder()
    InlineRunner().start(lambda job: 42, **rec.kwargs())
    assert rec.done == [42]
    assert rec.failed == []
    assert rec.cancelled == 0


def test_failed_receives_the_message_and_no_done() -> None:
    rec = Recorder()

    def boom(job: JobContext) -> None:
        raise ValueError("boom")

    InlineRunner().start(boom, **rec.kwargs())
    assert rec.failed == ["boom"]
    assert rec.done == []
    assert rec.cancelled == 0


def test_cancelled_raised_inside_the_work_calls_on_cancelled_once() -> None:
    rec = Recorder()

    def work(job: JobContext) -> None:
        raise Cancelled()

    InlineRunner().start(work, **rec.kwargs())
    assert rec.cancelled == 1
    assert rec.done == []
    assert rec.failed == []


def test_cancel_in_progress_observer_stops_the_work_at_the_next_check() -> None:
    rec = Recorder()
    reached: list[int] = []
    handles: list[InlineJob] = []

    def on_progress(done: int, total: int) -> None:
        if done == 2:
            handles[0].cancel()

    def work(job: JobContext) -> str:
        assert isinstance(job, InlineJob)
        handles.append(job)
        for step in range(5):
            job.token.check()
            reached.append(step)
            job.progress(step + 1, 5)
        return "finished"

    handle = InlineRunner(on_progress=on_progress).start(work, **rec.kwargs())
    assert isinstance(handle, InlineJob)
    assert reached == [0, 1]
    assert rec.cancelled == 1
    assert rec.done == []


def test_cancel_after_last_check_with_commit_delivers_the_result() -> None:
    rec = Recorder()
    handles: list[InlineJob] = []

    def work(job: JobContext) -> str:
        assert isinstance(job, InlineJob)
        handles.append(job)
        job.commit()
        job.token.cancel()
        return "written"

    InlineRunner().start(work, **rec.kwargs())
    assert rec.done == ["written"]
    assert rec.cancelled == 0


def test_cancel_after_last_check_without_commit_discards_the_result() -> None:
    rec = Recorder()

    def work(job: JobContext) -> str:
        job.token.cancel()
        return "discarded"

    InlineRunner().start(work, **rec.kwargs())
    assert rec.cancelled == 1
    assert rec.done == []


def test_progress_status_and_report_reach_their_observers_in_order() -> None:
    progress: list[tuple[int, int]] = []
    statuses: list[str] = []
    reports: list[object] = []

    def work(job: JobContext) -> None:
        job.status("page 1 of 2")
        job.progress(1, 2)
        job.report("partial-1")
        job.status("page 2 of 2")
        job.progress(2, 2)
        job.report("partial-2")

    runner = InlineRunner(
        on_progress=lambda done, total: progress.append((done, total)),
        on_status=statuses.append,
        on_report=reports.append,
    )
    rec = Recorder()
    runner.start(work, label="ocr", total=2, **rec.kwargs())
    assert progress == [(1, 2), (2, 2)]
    assert statuses == ["page 1 of 2", "page 2 of 2"]
    assert reports == ["partial-1", "partial-2"]
    assert rec.done == [None]


def test_job_context_carries_label_and_total() -> None:
    seen: list[tuple[str, int]] = []

    def work(job: JobContext) -> None:
        seen.append((job.label, job.total))

    InlineRunner().start(work, label="compare", total=7, **Recorder().kwargs())
    assert seen == [("compare", 7)]


def test_hold_acquires_the_lock_during_the_body_and_releases_it_after() -> None:
    lock = threading.Lock()
    inside: list[bool] = []

    def work(job: JobContext) -> None:
        with job.hold(lock):
            inside.append(lock.locked())

    InlineRunner().start(work, **Recorder().kwargs())
    assert inside == [True]
    assert not lock.locked()


def test_hold_releases_the_lock_when_the_body_raises() -> None:
    lock = threading.Lock()
    rec = Recorder()

    def work(job: JobContext) -> None:
        with job.hold(lock):
            raise ValueError("inside hold")

    InlineRunner().start(work, **rec.kwargs())
    assert not lock.locked()
    assert rec.failed == ["inside hold"]


@pytest.mark.parametrize("mode", ["returns", "raises", "cancel_then_raise", "cancel_then_return"])
def test_exactly_one_terminal_callback_per_start(mode: str) -> None:
    rec = Recorder()

    def work(job: JobContext) -> str:
        if mode == "returns":
            return "ok"
        if mode == "raises":
            raise ValueError("bad")
        job.token.cancel()
        if mode == "cancel_then_raise":
            raise ValueError("bad after cancel")
        return "late"

    InlineRunner().start(work, **rec.kwargs())
    assert rec.terminal_calls() == 1
