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

import io
import math
import secrets
import tempfile
import zipfile
from collections import deque
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from pdfeditor import actions as layer
from pdfeditor.core.commands.snapshot import SNAPSHOT_OPTIONS, SnapshotCommand
from pdfeditor.core.engine_lock import ENGINE_LOCK
from pdfeditor.core.jobs import JobContext
from pdfeditor.core.session import DocumentSession
from pdfeditor.engine.base import Document, PasswordRequired
from pdfeditor.engine.registry import DEFAULT_ENGINE, get_engine
from pdfeditor.model.metadata import EncryptionMethod
from pdfeditor.services.assembly import (
    SUPPORTED_SUFFIXES,
    MergeSource,
    SplitMode,
    merge,
    plan_split,
    safe_name,
    subset_size,
    write_split,
)
from pdfeditor.services.comments import comment_threads, page_labels, summary_csv, summary_pdf
from pdfeditor.services.compare import CompareOptions
from pdfeditor.services.compare import compare as compare_documents
from pdfeditor.services.export import TextFormat, export_document
from pdfeditor.services.export.images import ImageFormat, PageImageOptions, export_pages
from pdfeditor.services.optimize import PRESETS, ReduceOptions, preset, reduce_size
from pdfeditor.services.optimize import audit as space_audit
from pdfeditor.services.xfdf import export_xfdf
from pdfeditor.webapi import dto, limits
from pdfeditor.webapi.actions import _Events
from pdfeditor.webapi.dto import BufferTable, from_json
from pdfeditor.webapi.errors import (
    BUSY,
    FILE_TOO_LARGE,
    INVALID_ARGS,
    REFUSED,
    RENDER_TOO_LARGE,
    STALE_JOB,
    STALE_OBJECT,
    RpcFailure,
)
from pdfeditor.webapi.events import changed_of, state_of
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
    kind: str = ""  # the result kind (W1.2 section 13); "" takes the default of the job type
    name: str = ""  # the file name of a new_document result


ConvertFn = Callable[[object, BufferTable], Any]
# The session is the job worker's copy of the document; None for a job type that takes none.
RunFn = Callable[[DocumentSession | None, Any, JobContext], JobOutput]


@dataclass(frozen=True, slots=True)
class JobType:
    name: str
    mutating: bool
    # Validates the JSON arguments and returns the typed ones; raises INVALID_ARGS with the path.
    convert: ConvertFn
    # Does the work on the job worker's copy of the document, under the copy's lock.
    run: RunFn
    # False for a job that takes no document (merge has no handle: its sources are in args).
    takes_document: bool = True


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


def _session(session: DocumentSession | None) -> DocumentSession:
    # run_job opens the document for every job type that takes one (JobType.takes_document).
    assert session is not None
    return session


def _run_action(session: DocumentSession | None, job: ActionJob, ctx: JobContext) -> JobOutput:
    owner = _session(session)
    ctx.token.check()  # a cancel that came before the step ends the job here
    with owner.lock:
        outcome = layer.run(owner, job.name, job.args)
        ctx.token.check()
        document = owner.document.to_bytes(SNAPSHOT_OPTIONS)
        flag = owner.require_full_save
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


def _run_reduce(
    session: DocumentSession | None, args: dto.ReduceSizeArgs, ctx: JobContext
) -> JobOutput:
    owner = _session(session)
    options: ReduceOptions = preset(args.preset).options
    with owner.lock:
        result = reduce_size(owner.document, options, token=ctx.token, progress=ctx.progress)
    return JobOutput(
        files=(dto.FileDto(name="reduced.pdf", mime="application/pdf", data=result.data),),
        value=dto.ReduceSizeValue(
            before=result.before, after=result.after, notes=tuple(result.notes)
        ),
    )


# -- the read-only job types of W3.7 --------------------------------------------------------------

_MIME = {
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".html": "text/html",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".tif": "image/tiff",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xfdf": "application/vnd.adobe.xfdf",
    ".csv": "text/csv",
}
TEXT_FORMATS = {
    "txt": TextFormat.TEXT,
    "md": TextFormat.MARKDOWN,
    "html": TextFormat.HTML,
    "docx": TextFormat.WORD,  # written in pure Python (zipfile); no LibreOffice involved
}
IMAGE_FORMATS = {"png": ImageFormat.PNG, "jpeg": ImageFormat.JPEG, "tiff": ImageFormat.TIFF}
# W1.4 section 11: print renders at 150 dpi, with 300 dpi as the option. Export and print share it.
IMAGE_DPI = (150, 300)


def _mime_of(name: str) -> str:
    return _MIME.get(Path(name).suffix.lower(), "application/octet-stream")


def _collect(folder: Path) -> tuple[dto.FileDto, ...]:
    """Every file written under the folder, named by its path relative to it (the download name)."""
    return tuple(
        dto.FileDto(
            name=path.relative_to(folder).as_posix(),
            mime=_mime_of(path.name),
            data=path.read_bytes(),
        )
        for path in sorted(folder.rglob("*"))
        if path.is_file()
    )


def _as_archive(files: tuple[dto.FileDto, ...]) -> tuple[dto.FileDto, ...]:
    """Several files come back as one ZIP, since a reply carries one buffer to the page (the engine
    channel's limit). One file is returned as it is."""
    if len(files) < 2:
        return files
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for item in files:
            archive.writestr(item.name, item.data)
    return (dto.FileDto(name="export.zip", mime="application/zip", data=buffer.getvalue()),)


def _check_pages(pages: Sequence[int], count: int, path: str) -> None:
    for index in pages:
        if not 0 <= index < count:
            raise RpcFailure(INVALID_ARGS, f"{path}: no such page", {"path": path})


def _pages_arg(pages: tuple[int, ...] | None, count: int, path: str) -> list[int]:
    """The 0-based pages a job works on. None means every page."""
    if pages is None:
        return list(range(count))
    if not pages:
        raise RpcFailure(INVALID_ARGS, f"{path}: no pages", {"path": path})
    _check_pages(pages, count, path)
    return list(pages)


def _check_render_size(document: Document, pages: Sequence[int], dpi: int) -> None:
    """Refuses a page that would render above the pixel ceiling, as render.page does."""
    for index in pages:
        rect = document.page(index).rect
        pixels = math.ceil(rect.width * dpi / 72) * math.ceil(rect.height * dpi / 72)
        if pixels > limits.MAX_RENDER_PIXELS:
            raise RpcFailure(
                RENDER_TOO_LARGE,
                "a page is too large to render at this resolution",
                {"max_pixels": limits.MAX_RENDER_PIXELS, "pixels": pixels},
            )


def _convert_audit(data: object, buffers: BufferTable) -> dto.AuditArgs:
    args: dto.AuditArgs = from_json(dto.AuditArgs, data, buffers, "args")
    return args


def _run_audit(session: DocumentSession | None, args: dto.AuditArgs, ctx: JobContext) -> JobOutput:
    owner = _session(session)
    ctx.token.check()
    with owner.lock:
        usage = space_audit(owner.document)
    ctx.token.check()
    value = dto.AuditValue(
        total=usage.total,
        categories=tuple(
            dto.SpaceCategoryDto(name=name, size=size) for name, size in usage.categories.items()
        ),
    )
    return JobOutput(kind="report", value=value)


def _convert_export(data: object, buffers: BufferTable) -> dto.ExportArgs:
    args: dto.ExportArgs = from_json(dto.ExportArgs, data, buffers, "args")
    if args.format not in TEXT_FORMATS and args.format not in IMAGE_FORMATS:
        raise RpcFailure(INVALID_ARGS, "args.format: no such format", {"path": "args.format"})
    if args.format in IMAGE_FORMATS and args.dpi not in IMAGE_DPI:
        raise RpcFailure(INVALID_ARGS, "args.dpi: must be 150 or 300", {"path": "args.dpi"})
    return args


def _run_export(
    session: DocumentSession | None, args: dto.ExportArgs, ctx: JobContext
) -> JobOutput:
    owner = _session(session)
    with owner.lock, tempfile.TemporaryDirectory() as folder:
        doc = owner.document
        pages = _pages_arg(args.pages, doc.page_count, "args.pages")
        target = Path(folder, "export")
        if args.format in TEXT_FORMATS:
            export_document(
                doc,
                pages,
                target,
                TEXT_FORMATS[args.format],
                token=ctx.token,
                progress=ctx.progress,
            )
        else:
            _check_render_size(doc, pages, args.dpi)
            options = PageImageOptions(
                format=IMAGE_FORMATS[args.format], dpi=args.dpi, annotations=args.annotations
            )
            export_pages(doc, pages, target, options, token=ctx.token, progress=ctx.progress)
        files = _as_archive(_collect(Path(folder)))
    return JobOutput(files=files)


def _convert_split(data: object, buffers: BufferTable) -> dto.SplitArgs:
    args: dto.SplitArgs = from_json(dto.SplitArgs, data, buffers, "args")
    if args.pages_per_file < 1:
        raise RpcFailure(
            INVALID_ARGS,
            "args.pages_per_file: must be 1 or more",
            {"path": "args.pages_per_file"},
        )
    if args.mode is SplitMode.MAX_SIZE and args.max_bytes <= 0:
        raise RpcFailure(
            INVALID_ARGS, "args.max_bytes: must be more than 0", {"path": "args.max_bytes"}
        )
    return args


def _run_split(session: DocumentSession | None, args: dto.SplitArgs, ctx: JobContext) -> JobOutput:
    owner = _session(session)
    with owner.lock, tempfile.TemporaryDirectory() as folder:
        doc = owner.document
        if args.mode is SplitMode.RANGES:
            for part in args.ranges:
                _check_pages(part, doc.page_count, "args.ranges")

        def size_of(pages: list[int]) -> int:
            return subset_size(owner.engine, doc, pages)

        plan = plan_split(doc, args.mode, args.pages_per_file, args.ranges, args.max_bytes, size_of)
        # The parts are written into the folder and read back: write_split is the desktop's code.
        write_split(owner.engine, doc, plan, Path(folder), "split", ctx.token, ctx.progress)
        files = _collect(Path(folder))
    return JobOutput(files=files)


def _convert_merge(data: object, buffers: BufferTable) -> dto.MergeArgs:
    args: dto.MergeArgs = from_json(dto.MergeArgs, data, buffers, "args")
    if not args.sources:
        raise RpcFailure(INVALID_ARGS, "args.sources: no sources", {"path": "args.sources"})
    total = 0
    for index, source in enumerate(args.sources):
        if Path(source.name).suffix.lower() not in SUPPORTED_SUFFIXES:
            path = f"args.sources[{index}].name"
            raise RpcFailure(INVALID_ARGS, f"{path}: not a PDF or image file", {"path": path})
        total += len(source.data)
    if total > limits.MAX_JOB_BYTES:
        raise RpcFailure(
            FILE_TOO_LARGE,
            "the sources are too large for a job",
            {"max_bytes": limits.MAX_JOB_BYTES, "size": total},
        )
    return args


def _run_merge(session: DocumentSession | None, args: dto.MergeArgs, ctx: JobContext) -> JobOutput:
    # No document: the sources are written to a folder and merged by the desktop's merge service.
    # The result is a new document (W1.2 section 13), never a change to an open one.
    ctx.token.check()
    engine = get_engine(DEFAULT_ENGINE)
    with ENGINE_LOCK, tempfile.TemporaryDirectory() as folder:
        sources: list[MergeSource] = []
        for index, item in enumerate(args.sources):
            suffix = Path(item.name).suffix.lower()
            path = Path(folder, str(index), safe_name(Path(item.name).stem) + suffix)
            path.parent.mkdir(parents=True)
            path.write_bytes(item.data)
            pages = None if item.pages is None else list(item.pages)
            sources.append(MergeSource(path, pages))
        try:
            merged = merge(engine, sources, args.bookmarks, ctx.token, ctx.progress)
        except PasswordRequired as exc:
            raise RpcFailure(
                REFUSED, "a source is encrypted", {"reason": "encrypted_source"}
            ) from exc
        try:
            data = merged.to_bytes()
        finally:
            merged.close()
    return JobOutput(kind="new_document", document=data, name="merged.pdf")


def _convert_compare(data: object, buffers: BufferTable) -> dto.CompareArgs:
    args: dto.CompareArgs = from_json(dto.CompareArgs, data, buffers, "args")
    return args


def _run_compare(
    session: DocumentSession | None, args: dto.CompareArgs, ctx: JobContext
) -> JobOutput:
    owner = _session(session)
    ctx.token.check()
    with owner.lock:
        try:
            newer = owner.engine.open(args.other, None)
        except PasswordRequired as exc:
            raise RpcFailure(
                REFUSED, "the newer document is encrypted", {"reason": "encrypted_source"}
            ) from exc
        try:
            result = compare_documents(
                owner.document,
                newer,
                CompareOptions(text=args.text, visual=args.visual),
                token=ctx.token,
                progress=ctx.progress,
            )
        finally:
            newer.close()
    value = dto.CompareValue(
        identical=result.identical,
        pairs=tuple((a, b) for a, b in result.pairs),
        changes=tuple(
            dto.CompareChangeDto(
                kind=change.kind.value,
                page_a=change.page_a,
                page_b=change.page_b,
                summary=change.summary,
            )
            for change in result.changes
        ),
    )
    return JobOutput(kind="report", value=value)


COMMENTS_EXPORT_FORMATS = ("xfdf", "csv", "pdf")


def _convert_comments_export(data: object, buffers: BufferTable) -> dto.CommentsExportArgs:
    args: dto.CommentsExportArgs = from_json(dto.CommentsExportArgs, data, buffers, "args")
    if args.format not in COMMENTS_EXPORT_FORMATS:
        raise RpcFailure(INVALID_ARGS, "args.format: no such format", {"path": "args.format"})
    return args


def _run_comments_export(
    session: DocumentSession | None, args: dto.CommentsExportArgs, ctx: JobContext
) -> JobOutput:
    # The desktop Comments panel's three exports, written from the job's copy: nothing here
    # changes the document, so there is no undo step.
    owner = _session(session)
    # safe_name never returns "" (it falls back to "part"), so an empty stem is caught first.
    raw_stem = Path(args.name).stem.strip()
    stem = safe_name(raw_stem) if raw_stem else "document"
    ctx.token.check()
    with owner.lock:
        doc = owner.document
        if args.format == "xfdf":
            file_name = f"{stem}.xfdf"
            data = export_xfdf(doc, args.name).encode("utf-8")
        else:
            threads = comment_threads(doc)
            labels = page_labels(doc)
            if args.format == "csv":
                file_name = f"{stem}-comments.csv"
                # The BOM is what the desktop writes, so Excel opens the file as UTF-8.
                data = summary_csv(threads, labels).encode("utf-8-sig")
            else:
                file_name = f"{stem}-comments.pdf"
                data = summary_pdf(owner.engine, threads, args.name, labels)
        ctx.token.check()
    return JobOutput(files=(dto.FileDto(name=file_name, mime=_mime_of(file_name), data=data),))


def _convert_print(data: object, buffers: BufferTable) -> dto.PrintArgs:
    args: dto.PrintArgs = from_json(dto.PrintArgs, data, buffers, "args")
    if args.dpi not in IMAGE_DPI:
        raise RpcFailure(INVALID_ARGS, "args.dpi: must be 150 or 300", {"path": "args.dpi"})
    return args


def _run_print(session: DocumentSession | None, args: dto.PrintArgs, ctx: JobContext) -> JobOutput:
    owner = _session(session)
    files: list[dto.FileDto] = []
    with owner.lock, tempfile.TemporaryDirectory() as folder:
        doc = owner.document
        pages = _pages_arg(args.pages, doc.page_count, "args.pages")
        _check_render_size(doc, pages, args.dpi)
        width = len(str(max(pages) + 1)) if pages else 1
        target = Path(folder, "page.png")
        options = PageImageOptions(
            format=ImageFormat.PNG, dpi=args.dpi, annotations=args.annotations
        )
        for n, index in enumerate(pages):
            ctx.token.check()
            export_pages(doc, [index], target, options, token=ctx.token)
            files.append(
                dto.FileDto(
                    name=f"page-{index + 1:0{width}d}.png",
                    mime="image/png",
                    data=target.read_bytes(),
                )
            )
            ctx.progress(n + 1, len(pages))
    return JobOutput(files=tuple(files))


JOB_TYPES: dict[str, JobType] = {
    "action": JobType("action", True, _convert_action, _run_action),
    "reduce_size": JobType("reduce_size", False, _convert_reduce, _run_reduce),
    "audit": JobType("audit", False, _convert_audit, _run_audit),
    "export": JobType("export", False, _convert_export, _run_export),
    "split": JobType("split", False, _convert_split, _run_split),
    "merge": JobType("merge", False, _convert_merge, _run_merge, takes_document=False),
    "compare": JobType("compare", False, _convert_compare, _run_compare),
    "print_pages": JobType("print_pages", False, _convert_print, _run_print),
    "comments_export": JobType(
        "comments_export", False, _convert_comments_export, _run_comments_export
    ),
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
    fingerprint: tuple[object, ...]  # the document's state at prepare (see document_fingerprint)


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


def document_fingerprint(session: DocumentSession) -> tuple[object, ...]:
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
    if not kind.takes_document:
        raise RpcFailure(
            INVALID_ARGS,
            "params.job: this job takes no document; run it with job.run",
            {"path": "params.job"},
        )
    typed = kind.convert(params.args, buffers)
    label = typed.name if isinstance(typed, ActionJob) else kind.name
    _forget_unusable()
    pending = list(PREPARED.pending())
    if len(pending) >= limits.MAX_PREPARED_JOBS:
        # One job at a time per engine worker (W1.1 section 1): the pending one names the task.
        raise RpcFailure(BUSY, "a job is already prepared", {"task": pending[0][1].label})
    state: dto.DocStateDto | None = None
    with session.lock:
        if kind.mutating and session.busy:
            raise RpcFailure(BUSY, "a task is working on the document", {"task": session.busy})
        encrypted = session.document.info().encryption is not EncryptionMethod.NONE
        if kind.mutating and encrypted:
            # A result can't be written back encrypted: the web session never holds the source's
            # owner password, so a re-encrypted file would get a weaker one. Refused until the
            # owner-password question is decided (PLAN.md, W3.7).
            raise RpcFailure(
                REFUSED,
                "a job that changes an encrypted document is not available in the browser",
                {"reason": "encrypted_mutating_job"},
            )
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
        fingerprint = document_fingerprint(session)
        if kind.mutating:
            session.begin_task(label)
            state = state_of(session)  # the busy flag changed: the front end must hear of it
    token = PREPARED.new_token()
    PREPARED.add(
        token,
        _Prepared(
            params.handle,
            label,
            kind.mutating,
            fingerprint,
        ),
    )
    return dto.JobPrepareResult(
        token=token, label=label, mutating=kind.mutating, document=data, state=state
    )


def apply(params: dto.JobApplyParams) -> dto.JobApplyResult:
    entry = PREPARED.lookup(params.token, params.handle)
    if entry.mutating and params.document is None:
        raise RpcFailure(
            INVALID_ARGS,
            "params.document is required for a mutating job",
            {"path": "params.document"},
        )
    if params.document is not None and len(params.document) > limits.MAX_JOB_BYTES:
        # Refused before the token is spent or the task ends: the job stays prepared, and the
        # caller ends it with jobs.abort (which also ends the task), as for any failed apply.
        raise RpcFailure(
            FILE_TOO_LARGE,
            "the job's result is too large for the browser",
            {"max_bytes": limits.MAX_JOB_BYTES, "size": len(params.document)},
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
            if document_fingerprint(session) != entry.fingerprint:
                raise RpcFailure(
                    STALE_OBJECT,
                    "the document changed since the job was prepared",
                    {"reason": "document changed"},
                )
            applied = False
            if entry.mutating:
                document = params.document
                assert document is not None  # checked above
                data = document
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
            changed = changed_of(session, events.changes)
            state = state_of(session)
    finally:
        unsubscribe()
    return dto.JobApplyResult(applied=applied, changed=changed, state=state)


def abort(params: dto.JobAbortParams) -> dto.JobAbortResult:
    entry = PREPARED.find(params.token, params.handle)
    if entry is None:
        if PREPARED.was_ended(params.token):
            return dto.JobAbortResult(state=None)  # already ended: a repeated abort does nothing
        raise RpcFailure(STALE_JOB, "no prepared job has this token")
    PREPARED.end(params.token)
    state: dto.DocStateDto | None = None
    if entry.mutating and params.handle in REGISTRY:
        session = REGISTRY.get(params.handle)
        with session.lock:
            session.end_task(entry.label)
            state = state_of(session)
    return dto.JobAbortResult(state=state)
