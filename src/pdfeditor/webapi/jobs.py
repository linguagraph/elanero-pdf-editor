"""The jobs calls of W3.7 (W1.2 section 13): ``jobs.prepare``, ``jobs.apply`` and ``jobs.abort``,
plus the job types both workers share.

A job runs on a copy of the document in the job worker (:mod:`pdfeditor.webapi.jobworker`).
The engine side here only checks the spec, makes the copy, and holds the job's single-use token:

- a **mutating** job (``action`` of a long-running W1.3 action) begins a task on the session, so
  edits are refused while it runs (W1.1 section 4); ``jobs.apply`` ends the task and applies the
  result as one :class:`SnapshotCommand` whose operation is ``load_state``;
- a **read-only** job (``reduce_size``) doesn't block edits; its result never touches the session.

The job types are the services' and the actions' own work, so the desktop and the web run the
same code. Nothing here imports PyMuPDF.
"""

from __future__ import annotations

import secrets
from collections import deque
from collections.abc import Callable, Iterator
from dataclasses import dataclass, replace
from typing import Any

from pdfeditor import actions as layer
from pdfeditor.core.commands.snapshot import SNAPSHOT_OPTIONS, SnapshotCommand
from pdfeditor.core.jobs import JobContext
from pdfeditor.core.session import DocumentSession
from pdfeditor.engine.base import EngineError
from pdfeditor.model.metadata import EncryptionMethod, Permissions, SecuritySettings
from pdfeditor.services.optimize import PRESETS, ReduceOptions, preset, reduce_size
from pdfeditor.webapi import dto, limits
from pdfeditor.webapi.actions import _changed, _Events, _state
from pdfeditor.webapi.dto import BufferTable, from_json
from pdfeditor.webapi.errors import (
    BUSY,
    FILE_TOO_LARGE,
    INVALID_ARGS,
    SAVE_FAILED,
    STALE_JOB,
    STALE_OBJECT,
    RpcFailure,
)
from pdfeditor.webapi.registry import REGISTRY

# How many ended tokens are remembered, so that a repeated jobs.abort is a no-op (idempotent)
# while an unknown token still gets STALE_JOB (W1.2 section 4).
_ENDED_TOKENS_KEPT = 64


@dataclass(frozen=True, slots=True)
class ActionJob:
    """The converted spec of an ``action`` job: a long action and its typed arguments."""

    name: str
    args: object


@dataclass(frozen=True, slots=True)
class JobOutput:
    """What a job type's work returns. The job worker turns it into the reply."""

    label: str = ""  # the undo label of a mutating job's step
    document: bytes | None = None  # a mutating job's result document
    require_full_save: bool = False
    value: object = None  # the job's own result, for the report
    files: tuple[dto.FileDto, ...] = ()


ConvertFn = Callable[[object, BufferTable], Any]
RunFn = Callable[[DocumentSession, Any, JobContext], JobOutput]


@dataclass(frozen=True, slots=True)
class JobType:
    name: str
    mutating: bool
    # Validates the JSON arguments and returns the typed ones; raises INVALID_ARGS with the path.
    convert: ConvertFn
    # Does the work on the job worker's copy of the document, under the copy's lock.
    run: RunFn


# -- the job types of the first slice --------------------------------------------------------


def _convert_action(data: object, buffers: BufferTable) -> ActionJob:
    spec = from_json(dto.ActionJobArgs, data, buffers, "args")
    action = layer.REGISTRY.get(spec.name)
    if action is None:
        raise RpcFailure(INVALID_ARGS, "args.name: no such action", {"path": "args.name"})
    if not action.long:
        # Only the long-running actions are jobs; the others are run directly (actions.run).
        raise RpcFailure(
            INVALID_ARGS,
            "args.name: this action is not a long-running job",
            {"path": "args.name"},
        )
    typed = from_json(action.args, spec.args, buffers, "args.args")
    return ActionJob(action.name, typed)


def _run_action(session: DocumentSession, job: ActionJob, ctx: JobContext) -> JobOutput:
    ctx.token.check()  # a cancel that came before the step ends the job here
    with session.lock:
        outcome = layer.run(session, job.name, job.args)
        ctx.token.check()
        document = session.document.to_bytes(SNAPSHOT_OPTIONS)
        flag = session.require_full_save
    return JobOutput(
        label=outcome.label,
        document=document,
        require_full_save=flag,
        value=outcome.value,
    )


def _convert_reduce(data: object, buffers: BufferTable) -> dto.ReduceSizeArgs:
    args: dto.ReduceSizeArgs = from_json(dto.ReduceSizeArgs, data, buffers, "args")
    if not any(item.key == args.preset for item in PRESETS):
        raise RpcFailure(INVALID_ARGS, "args.preset: no such preset", {"path": "args.preset"})
    return args


def _run_reduce(session: DocumentSession, args: dto.ReduceSizeArgs, ctx: JobContext) -> JobOutput:
    options: ReduceOptions = preset(args.preset).options
    with session.lock:
        result = reduce_size(session.document, options, token=ctx.token, progress=ctx.progress)
    return JobOutput(
        files=(dto.FileDto(name="reduced.pdf", mime="application/pdf", data=result.data),),
        value=dto.ReduceSizeValue(
            before=result.before, after=result.after, notes=tuple(result.notes)
        ),
    )


JOB_TYPES: dict[str, JobType] = {
    "action": JobType("action", True, _convert_action, _run_action),
    "reduce_size": JobType("reduce_size", False, _convert_reduce, _run_reduce),
}


def job_type(name: str) -> JobType:
    found = JOB_TYPES.get(name)
    if found is None:
        raise RpcFailure(INVALID_ARGS, "params.job: no such job type", {"path": "params.job"})
    return found


# -- the engine's prepared jobs ----------------------------------------------------------------


# A job's copy: the snapshot options, but written without encryption. The source stays encrypted
# and untouched; the job worker never sees a password (W1.2 section 16, question 1).
DECRYPTED_COPY_OPTIONS = replace(SNAPSHOT_OPTIONS, decrypt=True)


@dataclass(slots=True)
class _Prepared:
    handle: str
    label: str  # the task label begun for a mutating job
    mutating: bool
    fingerprint: tuple[object, ...]  # the document's state at prepare (see _fingerprint)
    encryption: EncryptionMethod  # the source's method; a result is encrypted with it again
    permissions: Permissions  # the source's permissions, kept by the re-encryption


class PreparedJobs:
    """The engine worker's prepared jobs, by token. A token is single-use: once it is ended
    (applied, aborted or forgotten) it is only remembered, so a repeated abort is a no-op."""

    def __init__(self) -> None:
        self._jobs: dict[str, _Prepared] = {}
        self._ended: deque[str] = deque(maxlen=_ENDED_TOKENS_KEPT)

    def __len__(self) -> int:
        return len(self._jobs)

    def new_token(self) -> str:
        token = secrets.token_hex(16)
        while token in self._jobs or token in self._ended:
            token = secrets.token_hex(16)
        return token

    def add(self, token: str, entry: _Prepared) -> None:
        self._jobs[token] = entry

    def lookup(self, token: str, handle: str) -> _Prepared:
        """The pending job of ``token`` on ``handle``; STALE_JOB when there is none."""
        entry = self._jobs.get(token)
        if entry is None or entry.handle != handle:
            raise RpcFailure(STALE_JOB, "no prepared job has this token")
        return entry

    def find(self, token: str, handle: str) -> _Prepared | None:
        entry = self._jobs.get(token)
        return entry if entry is not None and entry.handle == handle else None

    def was_ended(self, token: str) -> bool:
        return token in self._ended

    def end(self, token: str) -> None:
        self._jobs.pop(token, None)
        self._ended.append(token)

    def pending(self) -> Iterator[tuple[str, _Prepared]]:
        yield from list(self._jobs.items())

    def clear(self) -> None:
        self._jobs.clear()


PREPARED = PreparedJobs()


def _fingerprint(session: DocumentSession) -> tuple[object, ...]:
    """What a job's copy was made from: the structure version and each page's revision. Any
    edit, undo or redo changes it. The caller holds the session lock."""
    document = session.document
    revisions = tuple(document.page(i).revision for i in range(document.page_count))
    return (session.structure_version, revisions)


def _forget_unusable() -> None:
    """Forget the prepared jobs whose document is closed, and the read-only ones: a later
    prepare forgets them (W1.2 section 13)."""
    for token, entry in list(PREPARED.pending()):
        if entry.handle not in REGISTRY or not entry.mutating:
            PREPARED.end(token)


# -- the calls ----------------------------------------------------------------------------------


def prepare(params: dto.JobPrepareParams, buffers: BufferTable) -> dto.JobPrepareResult:
    session = REGISTRY.get(params.handle)
    kind = job_type(params.job)
    typed = kind.convert(params.args, buffers)
    label = typed.name if isinstance(typed, ActionJob) else kind.name
    _forget_unusable()
    pending = list(PREPARED.pending())
    if len(pending) >= limits.MAX_PREPARED_JOBS:
        # One job at a time per engine worker (W1.1 section 1): the pending one names the task.
        raise RpcFailure(BUSY, "a job is already prepared", {"task": pending[0][1].label})
    with session.lock:
        if kind.mutating and session.busy:
            raise RpcFailure(BUSY, "a task is working on the document", {"task": session.busy})
        info = session.document.info()
        encrypted = info.encryption is not EncryptionMethod.NONE
        if encrypted:
            # Written from a scratch copy: writing without encryption changes the open document's
            # encryption state, which would then leak into the source's own saves.
            scratch = session.document.copy()
            try:
                data = scratch.to_bytes(DECRYPTED_COPY_OPTIONS)
            finally:
                scratch.close()
        else:
            data = session.document.to_bytes(SNAPSHOT_OPTIONS)
        if len(data) > limits.MAX_JOB_BYTES:
            raise RpcFailure(
                FILE_TOO_LARGE,
                "the document is too large for a job",
                {"max_bytes": limits.MAX_JOB_BYTES, "size": len(data)},
            )
        fingerprint = _fingerprint(session)
        if kind.mutating:
            session.begin_task(label)
    token = PREPARED.new_token()
    PREPARED.add(
        token,
        _Prepared(
            params.handle,
            label,
            kind.mutating,
            fingerprint,
            info.encryption,
            info.permissions,
        ),
    )
    return dto.JobPrepareResult(token=token, label=label, mutating=kind.mutating, document=data)


def _encrypt_like(session: DocumentSession, entry: _Prepared, plain: bytes, password: str) -> bytes:
    """The job's plaintext result, encrypted as the source was, and checked by reopening it.

    The open password is the user password of the source, and it is also used as the owner
    password: the web session never holds the source's owner password, so the owner password
    cannot be kept. The method and the permissions are kept. Raises SAVE_FAILED, with nothing
    changed, when the result can't be written and reopened encrypted.
    """
    if entry.encryption is EncryptionMethod.NONE:
        return plain
    try:
        scratch = session.engine.open(plain, None)
        try:
            pages = scratch.page_count
            scratch.set_pending_security(
                SecuritySettings(
                    method=entry.encryption,
                    user_password=password,
                    owner_password=password,
                    permissions=entry.permissions,
                )
            )
            data = bytes(scratch.to_bytes(SNAPSHOT_OPTIONS))
        finally:
            scratch.close()
        reopened = session.engine.open(data, password)
        try:
            same_pages = reopened.page_count == pages
            same_method = reopened.info().encryption is entry.encryption
        finally:
            reopened.close()
    except EngineError as exc:
        raise RpcFailure(
            SAVE_FAILED,
            "the job's result could not be encrypted again",
            {"reason": str(exc)},
        ) from exc
    if not (same_pages and same_method):
        raise RpcFailure(SAVE_FAILED, "the job's result could not be encrypted again")
    return data


def apply(params: dto.JobApplyParams) -> dto.JobApplyResult:
    entry = PREPARED.lookup(params.token, params.handle)
    if entry.mutating and params.document is None:
        raise RpcFailure(
            INVALID_ARGS,
            "params.document is required for a mutating job",
            {"path": "params.document"},
        )
    session = REGISTRY.get(params.handle)
    PREPARED.end(params.token)  # single-use: the token is spent whatever happens next
    events = _Events()
    unsubscribe = session.subscribe(events)
    try:
        with session.lock:
            if entry.mutating:
                # Ended first: execute refuses while a task runs, and the task must end even
                # when the document turns out to have changed.
                session.end_task(entry.label)
            if _fingerprint(session) != entry.fingerprint:
                raise RpcFailure(
                    STALE_OBJECT,
                    "the document changed since the job was prepared",
                    {"reason": "document changed"},
                )
            applied = False
            if entry.mutating:
                document = params.document
                assert document is not None  # checked above
                # Encrypted again before anything changes: a refusal leaves the document as it was.
                data = _encrypt_like(
                    session, entry, document, REGISTRY.password(params.handle) or ""
                )
                command = SnapshotCommand(
                    params.label, lambda doc: doc.load_state(data), session.snapshots
                )
                if not session.execute(command):
                    raise RpcFailure(
                        BUSY, "a task is working on the document", {"task": session.busy}
                    )
                if params.require_full_save:
                    session.require_full_save = True  # ORed in, never cleared (W1.3 section 2)
                applied = True
            changed = _changed(session, events.changes)
            state = _state(session)
    finally:
        unsubscribe()
    return dto.JobApplyResult(applied=applied, changed=changed, state=state)


def abort(params: dto.JobAbortParams) -> dto.Empty:
    entry = PREPARED.find(params.token, params.handle)
    if entry is None:
        if PREPARED.was_ended(params.token):
            return dto.Empty()  # already ended: a repeated abort does nothing
        raise RpcFailure(STALE_JOB, "no prepared job has this token")
    PREPARED.end(params.token)
    if entry.mutating and params.handle in REGISTRY:
        session = REGISTRY.get(params.handle)
        with session.lock:
            session.end_task(entry.label)
    return dto.Empty()
