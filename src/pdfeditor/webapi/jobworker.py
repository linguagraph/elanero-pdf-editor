"""The job worker's entry point (W1.1 section 1, W1.2 sections 8 and 13): ``job.run``.

The job worker is a separate, disposable Pyodide worker. It has no document registry: it opens
the copy that ``jobs.prepare`` made, runs one job type from :mod:`pdfeditor.webapi.jobs` on it,
and replies with the result bytes. The engine worker then applies or drops the result
(``jobs.apply`` / ``jobs.abort``).

A job runs to completion on the calling thread (:class:`InlineRunner`), so the worker can't
hear a cancel while it works: the JS side terminates it instead. The ``cancel`` token exists for
callers that can set it while the job runs (tests, and any future cooperative host); Python just
stops at the next check. Progress is posted as ``progress`` notices (W1.2 section 8), at most one
per 100 ms, the first and the final one always.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from typing import Any

from pdfeditor.core.inline_jobs import InlineRunner
from pdfeditor.core.jobs import CancelToken, JobContext
from pdfeditor.core.session import DocumentSession
from pdfeditor.webapi import Method, _hello, dto, jobs, limits
from pdfeditor.webapi import dispatch as dispatch_envelope
from pdfeditor.webapi.dto import PROTOCOL_VERSION, BufferTable
from pdfeditor.webapi.errors import (
    CANCELLED,
    FILE_TOO_LARGE,
    INVALID_ARGS,
    RpcFailure,
    failure_for,
)
from pdfeditor.webapi.platform import WEB_SNAPSHOT_BUDGET

PROGRESS_INTERVAL_S = 0.1  # W1.2 section 8: at most one notice per 100 ms per job

Notify = Callable[[dict[str, object]], None]


def dispatch(
    request_json: str,
    buffers: list[bytes],
    notify: Notify | None = None,
    cancel: CancelToken | None = None,
) -> tuple[str, list[bytes]]:
    """Handle one ``job.run`` request. The envelope rules are the engine's (W1.2 section 2), and
    the failures come back the same way. ``notify`` receives each progress notice as a dict."""
    request_id = _request_id(request_json)

    def handler(params: dto.JobRunParams, buffers: BufferTable) -> dto.JobRunResult:
        return run_job(params, buffers, request_id, notify, cancel)

    # The job worker's own table: the hello the loader checks at start-up, and job.run.
    methods = {
        "hello": Method(dto.Empty, _hello),
        "job.run": Method(dto.JobRunParams, handler, takes_buffers=True),
    }
    return dispatch_envelope(request_json, buffers, methods)


def run_job(
    params: dto.JobRunParams,
    buffers: BufferTable,
    request_id: object,
    notify: Notify | None,
    cancel: CancelToken | None,
) -> dto.JobRunResult:
    job_type = jobs.job_type(params.job)
    typed = job_type.convert(params.args, buffers)
    if job_type.takes_document:
        if params.document is None:
            raise RpcFailure(
                INVALID_ARGS,
                "params.document is required for this job",
                {"path": "params.document"},
            )
        if len(params.document) > limits.MAX_JOB_BYTES:
            raise RpcFailure(
                FILE_TOO_LARGE,
                "the document is too large for a job",
                {"max_bytes": limits.MAX_JOB_BYTES, "size": len(params.document)},
            )
        # The copy is opened here and closed at the end: nothing of it outlives the job.
        # The copy is decrypted by jobs.prepare, so the job worker never holds a password
        # (W1.2 16.1).
        session = DocumentSession.open(params.document, None, snapshot_budget=WEB_SNAPSHOT_BUDGET)
        try:
            output = _execute(session, job_type, typed, request_id, notify, cancel)
        finally:
            session.close()
    else:
        if params.document is not None:
            raise RpcFailure(
                INVALID_ARGS,
                "params.document: this job takes no document",
                {"path": "params.document"},
            )
        output = _execute(None, job_type, typed, request_id, notify, cancel)
    size = len(output.document or b"") + sum(len(item.data) for item in output.files)
    if size > limits.MAX_JOB_BYTES:
        raise RpcFailure(
            FILE_TOO_LARGE,
            "the job's result is too large for the browser",
            {"max_bytes": limits.MAX_JOB_BYTES, "size": size},
        )
    kind = output.kind or ("document" if job_type.mutating else "files")
    return dto.JobRunResult(
        kind=kind,
        label=output.label,
        require_full_save=output.require_full_save,
        document=output.document,
        files=output.files,
        value=output.value,
        name=output.name,
    )


def _execute(
    session: DocumentSession | None,
    job_type: jobs.JobType,
    typed: Any,
    request_id: object,
    notify: Notify | None,
    cancel: CancelToken | None,
) -> jobs.JobOutput:
    progress = _Progress(request_id, notify)
    failures: list[BaseException] = []
    done: list[jobs.JobOutput] = []
    cancelled: list[bool] = []

    def work(ctx: JobContext) -> jobs.JobOutput:
        if cancel is not None:
            ctx.token = cancel  # the caller's token, so a cancel set by the host is seen
        try:
            return job_type.run(session, typed, ctx)
        except BaseException as exc:
            failures.append(exc)
            raise

    runner = InlineRunner(on_progress=progress, on_status=progress.set_status)
    runner.start(
        work,
        label=job_type.name,
        on_done=done.append,
        on_failed=lambda _message: None,  # the exception itself is in ``failures``
        on_cancelled=lambda: cancelled.append(True),
    )
    if cancelled:
        raise RpcFailure(CANCELLED, "the job was cancelled")
    if failures:
        raise failure_for(failures[0])
    return done[0]


class _Progress:
    """The progress observer of one job: throttled, and shaped as the W1.2 notice."""

    def __init__(self, request_id: object, notify: Notify | None) -> None:
        self._request_id = request_id
        self._notify = notify
        self._status = ""
        self._last: float | None = None

    def set_status(self, text: str) -> None:
        self._status = text

    def __call__(self, done: int, total: int) -> None:
        if self._notify is None:
            return
        now = time.monotonic()
        final = total > 0 and done >= total
        if self._last is not None and now - self._last < PROGRESS_INTERVAL_S and not final:
            return
        self._last = now
        self._notify(
            {
                "v": PROTOCOL_VERSION,
                "notice": "progress",
                "id": self._request_id,
                "data": {"done": done, "total": total, "status": self._status},
            }
        )


def _request_id(request_json: str) -> object:
    try:
        data = json.loads(request_json)
    except ValueError:
        return None
    return data.get("id") if isinstance(data, dict) else None
