"""Frozen DTOs for the web calls, and the one converter between them and JSON (W1.2 section 6).

The converter is driven by the type hints of the dataclasses, so a call's params and result are
checked the same way everywhere. ``from_json`` is strict: unknown keys, missing fields, wrong
types and out-of-range numbers are ``INVALID_ARGS`` with ``details.path`` naming the field. Bytes
never travel inside the JSON; each one is a ``{"$bin": i}`` marker that refers to the message's
buffer list, and a buffer may be referenced only once.
"""

from __future__ import annotations

import dataclasses
import math
import types
import typing
from datetime import datetime
from enum import Enum, IntFlag
from typing import Any, NoReturn, Union, get_args, get_origin

from pdfeditor.services.assembly import SplitMode
from pdfeditor.webapi.errors import INVALID_ARGS, RpcFailure

# W1.2 section 3: bumped on any change that is not purely additive to an existing message.
PROTOCOL_VERSION = 1

MAX_SAFE_INT = 2**53 - 1
_NONE_TYPE = type(None)


@dataclasses.dataclass(frozen=True, slots=True)
class Empty:
    """Params of a call that takes none."""


@dataclasses.dataclass(frozen=True, slots=True)
class HelloResult:
    protocol: int  # PROTOCOL_VERSION; the client compares it with its own build
    engine: str  # the engine behind the calls
    platform: str  # "web" in the browser, "desktop" on the host


@dataclasses.dataclass(frozen=True, slots=True)
class OpenParams:
    name: str  # the file name, shown in messages; never used to read the file
    data: bytes  # the whole file
    password: str | None  # null when the file has none; used once, then kept while open


@dataclasses.dataclass(frozen=True, slots=True)
class DocInfo:
    encrypted: bool
    has_signatures: bool
    page_count: int
    title: str
    # The other Info fields the properties dialog shows (W7.6). Dates are raw PDF date strings.
    author: str
    subject: str
    keywords: str
    creator: str
    producer: str
    creation_date: str
    mod_date: str


@dataclasses.dataclass(frozen=True, slots=True)
class OpenResult:
    handle: str  # opaque; every later call on the document names it
    info: DocInfo
    pages: int
    warning: str | None  # set above the warning size (W1.1 section 7)
    state: DocStateDto  # the document state at open (W1.2 section 4): clean, nothing to undo


@dataclasses.dataclass(frozen=True, slots=True)
class HandleParams:
    handle: str


@dataclasses.dataclass(frozen=True, slots=True)
class PageSize:
    width: float  # points, visible space (after /Rotate and the CropBox)
    height: float
    rotation: int  # the page's /Rotate, in degrees


@dataclasses.dataclass(frozen=True, slots=True)
class FlattenableResult:
    count: int  # the comments Flatten would burn in (services.comments.flattenable)
    pages: int  # the pages those comments are on


@dataclasses.dataclass(frozen=True, slots=True)
class PagesResult:
    pages: tuple[PageSize, ...]
    # The page labels, one per page; empty when the document has none, and "" for a page with
    # no label (its rule yields nothing).
    labels: tuple[str, ...]


@dataclasses.dataclass(frozen=True, slots=True)
class OutlineEntry:
    # One bookmark, in depth-first order. The tree is implied by ``level``: an entry's children
    # are the following entries of a greater level, up to the next entry at its own level or
    # above. ``page`` is the zero-based destination page, or None for an entry without one (a
    # web link, or a destination the file does not resolve).
    title: str
    level: int  # 1 for a top-level bookmark
    page: int | None
    is_open: bool  # the file's own "open" flag for the entry (its initial expansion)


@dataclasses.dataclass(frozen=True, slots=True)
class OutlineResult:
    entries: tuple[OutlineEntry, ...]


@dataclasses.dataclass(frozen=True, slots=True)
class PlatformFlags:
    # The fields of model.platform.PlatformCapabilities; a test keeps the two in step.
    linearize: bool
    ocr: bool
    signing: bool
    system_fonts: bool
    office_import: bool
    threads: bool
    pdfa: bool
    tiff_compression: str


@dataclasses.dataclass(frozen=True, slots=True)
class CapabilitiesResult:
    engine: dict[str, bool]  # engine.base.Capabilities, one flag per name
    platform: PlatformFlags


@dataclasses.dataclass(frozen=True, slots=True)
class UnlockParams:
    handle: str
    password: str  # an owner password; never echoed


@dataclasses.dataclass(frozen=True, slots=True)
class UnlockResult:
    unlocked: bool


@dataclasses.dataclass(frozen=True, slots=True)
class PageParams:
    handle: str
    page: int  # 0-based


@dataclasses.dataclass(frozen=True, slots=True)
class RectDto:
    x0: float  # points, visible page space, origin top-left
    y0: float
    x1: float
    y1: float


@dataclasses.dataclass(frozen=True, slots=True)
class TextLayerResult:
    revision: int  # the page revision the layer was built from
    text: str  # LINE_SEP between lines, so offsets map 1:1 to the char boxes
    line_rects: tuple[RectDto, ...]
    char_boxes: bytes  # Float32 x 4 per char (x0, y0, x1, y1); zeros for line separators
    line_numbers: bytes  # Uint32 per char: the line it belongs to


@dataclasses.dataclass(frozen=True, slots=True)
class TextPosition:
    page: int
    index: int  # caret index before this char on the page (W1.4 section 10)


@dataclasses.dataclass(frozen=True, slots=True)
class ExtractParams:
    handle: str
    start: TextPosition
    end: TextPosition  # either order; the lower one is the start
    cursor: str | None  # null for the first slice
    budget_ms: int


@dataclasses.dataclass(frozen=True, slots=True)
class ExtractResult:
    text: str  # this slice's text; pages are joined with a line separator (empty if no text)
    cursor: str | None  # null when finished
    pages_done: int
    total: int  # pages in the selection
    done: bool


@dataclasses.dataclass(frozen=True, slots=True)
class SearchOptionsDto:
    case_sensitive: bool
    whole_word: bool
    regex: bool


@dataclasses.dataclass(frozen=True, slots=True)
class SearchParams:
    handle: str
    query: str  # non-empty; at most limits.MAX_QUERY_CHARS
    options: SearchOptionsDto
    start_page: int  # the search wraps around from here; ignored once a cursor is given
    cursor: str | None
    budget_ms: int


@dataclasses.dataclass(frozen=True, slots=True)
class PointDto:
    x: float
    y: float


@dataclasses.dataclass(frozen=True, slots=True)
class QuadDto:
    ul: PointDto
    ur: PointDto
    ll: PointDto
    lr: PointDto


@dataclasses.dataclass(frozen=True, slots=True)
class SearchHitDto:
    page: int
    text: str  # the matched text
    context: str  # a little text either side, with the match in brackets
    quads: tuple[QuadDto, ...]  # one per line the match covers


@dataclasses.dataclass(frozen=True, slots=True)
class SearchResult:
    hits: tuple[SearchHitDto, ...]  # in page order, then reading order within a page
    cursor: str | None  # null when finished
    pages_done: int
    total: int  # pages in the document
    done: bool


@dataclasses.dataclass(frozen=True, slots=True)
class RenderPageParams:
    handle: str
    page: int  # 0-based, in visible page order
    revision: int  # the page revision the caller expects (W1.4 section 5)
    scale_milli: int  # device scale in thousandths: zoom x 96/72 x devicePixelRatio
    rotation: int  # view rotation: 0, 90, 180 or 270
    annotations: bool  # draw comments into the image (W1.4 section 4)


@dataclasses.dataclass(frozen=True, slots=True)
class RenderTileParams:
    """``render.tile`` (W1.4 section 13): the ``render.page`` fields plus one grid tile."""

    handle: str
    page: int
    revision: int
    scale_milli: int
    rotation: int
    annotations: bool
    tile_x: int  # 0-based column of the tile in the page's device-pixel grid
    tile_y: int  # 0-based row
    tile_px: int  # tile edge in device pixels; W1.4 section 4 fixes it at 1024


class SaveMode(Enum):
    """W1.1 section 4: ``in_place`` keeps signatures (incremental when signed); ``copy`` is a full
    rewrite, as Save As."""

    IN_PLACE = "in_place"
    COPY = "copy"


@dataclasses.dataclass(frozen=True, slots=True)
class SaveParams:
    handle: str
    mode: SaveMode


@dataclasses.dataclass(frozen=True, slots=True)
class SaveResult:
    data: bytes  # the saved file; a $bin buffer, so it is transferred and not copied
    size: int  # len(data), for the caller's progress and download
    incremental: bool  # True when the signed document was written as an incremental update
    verified: bool  # always True in a reply: the bytes were reopened and checked before return
    name: str  # the file name the document would be saved under (its display name)


@dataclasses.dataclass(frozen=True, slots=True)
class PageImage:
    width: int  # pixels; 0 when the revision changed
    height: int
    revision: int  # the page's current revision; differs from the request when it changed
    format: str  # "rgba": four bytes per pixel, tightly packed rows, top row first
    pixels: bytes  # empty when the revision changed


class JsonObject:
    """Marker type for a JSON object that the handler converts itself, once it knows which
    dataclass it is (the arguments of ``actions.run``, selected by the action name). The
    converter only checks that it is an object; the handler then runs ``from_json`` on it with
    the same buffer table, so ``$bin`` markers inside it are still checked."""


@dataclasses.dataclass(frozen=True, slots=True)
class RunParams:
    handle: str
    name: str  # a stable action name (W1.3 "Names")
    args: JsonObject  # the action's arguments, converted by the action's args dataclass


@dataclasses.dataclass(frozen=True, slots=True)
class ChangeDto:
    kind: str  # "content", "structure", "metadata", "outline" or "annotations" (W1.2 section 7)
    pages: tuple[int, ...]  # 0-based page indices, sorted


@dataclasses.dataclass(frozen=True, slots=True)
class ChangedDto:
    changes: tuple[ChangeDto, ...]
    revisions: dict[str, int]  # the new Page.revision of each changed page, keyed by index


@dataclasses.dataclass(frozen=True, slots=True)
class DocStateDto:
    page_count: int
    structure_version: int  # bumped on every structure change (W1.2 section 7)
    dirty: bool
    busy: str  # the background task that makes the document read-only, or ""
    can_undo: bool
    can_redo: bool
    undo_label: str
    redo_label: str
    require_full_save: bool


@dataclasses.dataclass(frozen=True, slots=True)
class MarkSavedResult:
    """``save.mark_saved`` (W1.2 section 12): ``saved`` is True when this call cleared the dirty
    flag, and False when the document was already clean (a no-op, with no ``saved`` event)."""

    saved: bool
    state: DocStateDto


@dataclasses.dataclass(frozen=True, slots=True)
class RunResult:
    label: str  # the undo label of the step (W1.3 ActionResult.label)
    executed: bool  # False when the action found nothing to do
    value: object  # the action's own result (None for most), converted as in section 6
    changed: ChangedDto | None  # None when no content changed
    state: DocStateDto


@dataclasses.dataclass(frozen=True, slots=True)
class HistoryResult:
    done: bool  # whether anything was undone or redone
    label: str  # the label of the step that was undone or redone; "" when nothing was
    changed: ChangedDto | None
    state: DocStateDto


@dataclasses.dataclass(frozen=True, slots=True)
class AvailableResult:
    names: tuple[str, ...]  # the actions whose capabilities hold on this document and platform


@dataclasses.dataclass(frozen=True, slots=True)
class JobPrepareParams:
    handle: str
    job: str  # a job type name (W1.2 section 13), such as "action" or "reduce_size"
    args: JsonObject  # the job's arguments, converted by the job type


@dataclasses.dataclass(frozen=True, slots=True)
class JobPrepareResult:
    token: str  # the job id: single-use, given back to jobs.apply or jobs.abort
    label: str  # the task label of a mutating job (its busy label); the job type name otherwise
    mutating: bool  # True when the document is read-only until the job is applied or aborted
    document: bytes  # a copy of the document, for the job worker; decrypted when the source is
    # The document state after the busy flag changed (a mutating job began its task); None for a
    # read-only job, whose prepare leaves the flag alone (W3.5).
    state: DocStateDto | None


@dataclasses.dataclass(frozen=True, slots=True)
class JobApplyParams:
    handle: str
    token: str
    document: bytes | None  # the job's result document; required for a mutating job
    label: str  # the undo label of the step (the job's result label)
    require_full_save: bool  # a flag the job reports; ORed into the session, never cleared


@dataclasses.dataclass(frozen=True, slots=True)
class JobApplyResult:
    applied: bool  # False for a read-only job, whose result never touches the session
    changed: ChangedDto | None
    state: DocStateDto


@dataclasses.dataclass(frozen=True, slots=True)
class JobAbortParams:
    handle: str
    token: str


@dataclasses.dataclass(frozen=True, slots=True)
class JobAbortResult:
    # The document state after a mutating job's task ended; None when the flag did not change
    # (a read-only job, or a repeated abort), so no state event is sent (W3.5).
    state: DocStateDto | None


@dataclasses.dataclass(frozen=True, slots=True)
class JobRunParams:
    job: str
    args: JsonObject
    # The copy from jobs.prepare (always readable without a password). None for a job that takes
    # no document: merge has no handle, its sources are in args.
    document: bytes | None = None


@dataclasses.dataclass(frozen=True, slots=True)
class FileDto:
    name: str
    mime: str
    data: bytes


@dataclasses.dataclass(frozen=True, slots=True)
class JobRunResult:
    # "document" (a mutating job, applied with jobs.apply), "files" (read-only outputs),
    # "new_document" (merge, opened as a new tab) or "report" (audit and compare: the value only)
    kind: str
    label: str  # the undo label of the step; "" for a read-only job
    require_full_save: bool
    document: bytes | None  # the result document of a mutating job or a new_document
    files: tuple[FileDto, ...]  # the outputs of a read-only job
    value: object  # the job's own result, converted as in section 6
    name: str  # the file name of a new_document; "" otherwise


@dataclasses.dataclass(frozen=True, slots=True)
class ActionJobArgs:
    name: str  # a long-running action (W1.3 "long"); its arguments are converted by its dataclass
    args: JsonObject


@dataclasses.dataclass(frozen=True, slots=True)
class ReduceSizeArgs:
    preset: str  # a key of the size presets: "screen", "ebook", "print" or "lossless"


@dataclasses.dataclass(frozen=True, slots=True)
class ReduceSizeValue:
    before: int
    after: int
    notes: tuple[str, ...]


@dataclasses.dataclass(frozen=True, slots=True)
class AuditArgs:
    """The space audit takes no options: it reads the whole document."""


@dataclasses.dataclass(frozen=True, slots=True)
class SpaceCategoryDto:
    name: str  # a category of the space audit, such as "images" or "fonts"
    size: int  # its stored (compressed) bytes


@dataclasses.dataclass(frozen=True, slots=True)
class AuditValue:
    total: int  # the stored bytes of the whole document
    categories: tuple[SpaceCategoryDto, ...]


@dataclasses.dataclass(frozen=True, slots=True)
class ExportArgs:
    format: str  # text: "txt", "md", "html" or "docx"; images: "png", "jpeg" or "tiff"
    pages: tuple[int, ...] | None = None  # 0-based; None: every page
    dpi: int = 150  # images only: 150 (default) or 300 (W1.4 section 11)
    annotations: bool = True  # images only: draw the comments too


@dataclasses.dataclass(frozen=True, slots=True)
class SplitArgs:
    mode: SplitMode  # the split modes of the services, by their value
    pages_per_file: int = 1  # mode "pages"
    ranges: tuple[tuple[int, ...], ...] = ()  # mode "ranges": the 0-based pages of each part
    max_bytes: int = 0  # mode "size": the largest part, in bytes


@dataclasses.dataclass(frozen=True, slots=True)
class MergeSourceArgs:
    name: str  # the file name with its extension: the extension decides PDF or image
    data: bytes
    pages: tuple[int, ...] | None = None  # 0-based; None: every page (PDF sources only)


@dataclasses.dataclass(frozen=True, slots=True)
class MergeArgs:
    sources: tuple[MergeSourceArgs, ...]
    bookmarks: bool = True  # each source gets a top-level bookmark, as in Combine


@dataclasses.dataclass(frozen=True, slots=True)
class CompareArgs:
    other: bytes  # the newer document; the job's document is the older one
    text: bool = True
    visual: bool = True  # pixel differences where the text is the same


@dataclasses.dataclass(frozen=True, slots=True)
class CompareChangeDto:
    kind: str  # the services' change kind, such as "inserted", "deleted" or "visual"
    page_a: int | None  # 0-based page of the older document; None: only in the newer one
    page_b: int | None  # 0-based page of the newer document; None: only in the older one
    summary: str


@dataclasses.dataclass(frozen=True, slots=True)
class CompareValue:
    identical: bool
    pairs: tuple[tuple[int | None, int | None], ...]  # aligned pages (older, newer)
    changes: tuple[CompareChangeDto, ...]


@dataclasses.dataclass(frozen=True, slots=True)
class PrintArgs:
    pages: tuple[int, ...] | None = None  # 0-based; None: every page
    dpi: int = 150  # 150 (default) or 300 (W1.4 section 11)
    annotations: bool = True  # include the comments


class BufferTable:
    """The buffers of one message. Each ``$bin`` marker takes one buffer, once."""

    def __init__(self, buffers: list[bytes]) -> None:
        self._buffers = buffers
        self._used: set[int] = set()

    def take(self, data: object, path: str) -> bytes:
        index = _marker_index(data)
        if index is None:
            _invalid(path, "expected a binary value")
        if index >= len(self._buffers):
            _invalid(path, "binary value refers to a missing buffer")
        if index in self._used:
            _invalid(path, "binary buffer referenced more than once")
        self._used.add(index)
        return self._buffers[index]

    def check_all_used(self) -> None:
        for index in range(len(self._buffers)):
            if index not in self._used:
                _invalid(f"buffers[{index}]", "buffer not referenced by the message")


def to_json(value: object, out: list[bytes]) -> object:
    """The JSON value of a DTO. Bytes are appended to ``out`` and replaced by their marker."""
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, IntFlag):
        return _safe_int(int(value))
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, int):
        return _safe_int(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("non-finite number has no JSON form")
        return value
    if isinstance(value, str):
        return value
    if isinstance(value, bytes):
        out.append(value)
        return {"$bin": len(out) - 1}
    if isinstance(value, datetime):
        return value.isoformat()
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {f.name: to_json(getattr(value, f.name), out) for f in dataclasses.fields(value)}
    if isinstance(value, dict):
        return {_json_key(key): to_json(item, out) for key, item in value.items()}
    if isinstance(value, frozenset):
        # Sorted so that equal replies are byte-identical.
        return [to_json(item, out) for item in sorted(value, key=_sort_key)]
    if isinstance(value, tuple | list):
        return [to_json(item, out) for item in value]
    raise TypeError(f"no JSON form for {type(value).__name__}")


def from_json(tp: object, data: object, buffers: BufferTable, path: str) -> Any:
    """The value of type ``tp`` for JSON ``data``. ``path`` names ``data`` in error details."""
    origin = get_origin(tp)
    if origin is Union or origin is types.UnionType:
        args = get_args(tp)
        others = [arg for arg in args if arg is not _NONE_TYPE]
        if len(args) != 2 or len(others) != 1:
            raise TypeError(f"only X | None is supported, not {tp!r}")
        if data is None:
            return None
        return from_json(others[0], data, buffers, path)
    if tp is bool:
        if not isinstance(data, bool):
            _invalid(path, "expected true or false")
        return data
    if tp is int:
        if not _is_int(data):
            _invalid(path, "expected an integer")
        if abs(typing.cast(int, data)) > MAX_SAFE_INT:
            _invalid(path, "integer is out of range")
        return data
    if tp is float:
        if isinstance(data, bool) or not isinstance(data, int | float):
            _invalid(path, "expected a number")
        if not math.isfinite(data):
            _invalid(path, "number must be finite")
        return float(data)
    if tp is str:
        if not isinstance(data, str):
            _invalid(path, "expected a string")
        return data
    if tp is bytes:
        return buffers.take(data, path)
    if tp is JsonObject:
        if not isinstance(data, dict):
            _invalid(path, "expected an object")
        return data
    if tp is datetime:
        if not isinstance(data, str):
            _invalid(path, "expected an ISO 8601 string")
        try:
            value = datetime.fromisoformat(data)
        except ValueError:
            _invalid(path, "expected an ISO 8601 string")
        if value.tzinfo is None:
            _invalid(path, "expected an offset in the date")
        return value
    if isinstance(tp, type) and issubclass(tp, Enum):
        try:
            return tp(data)
        except ValueError:
            _invalid(path, "not one of the allowed values")
    if isinstance(tp, type) and dataclasses.is_dataclass(tp):
        return _dataclass(tp, data, buffers, path)
    if origin is tuple:
        return _tuple(get_args(tp), data, buffers, path)
    if origin is frozenset:
        (item_tp,) = get_args(tp)
        items = _list(data, path)
        return frozenset(
            from_json(item_tp, item, buffers, f"{path}[{i}]") for i, item in enumerate(items)
        )
    if origin is dict:
        return _dict(get_args(tp), data, buffers, path)
    raise TypeError(f"no JSON mapping for {tp!r}")


def _dataclass(tp: type, data: object, buffers: BufferTable, path: str) -> Any:
    if not isinstance(data, dict):
        _invalid(path, "expected an object")
    fields = dataclasses.fields(tp)
    names = {f.name for f in fields}
    for key in data:
        if key not in names:
            _invalid(f"{path}.{key}", "unknown field")
    hints = typing.get_type_hints(tp)
    kwargs: dict[str, object] = {}
    for f in fields:
        field_path = f"{path}.{f.name}"
        if f.name not in data:
            if f.default is dataclasses.MISSING and f.default_factory is dataclasses.MISSING:
                _invalid(field_path, "missing field")
            continue
        kwargs[f.name] = from_json(hints[f.name], data[f.name], buffers, field_path)
    return tp(**kwargs)


def _tuple(
    args: tuple[object, ...], data: object, buffers: BufferTable, path: str
) -> tuple[Any, ...]:
    items = _list(data, path)
    if len(args) == 2 and args[1] is Ellipsis:
        return tuple(
            from_json(args[0], item, buffers, f"{path}[{i}]") for i, item in enumerate(items)
        )
    if len(items) != len(args):
        _invalid(path, f"expected {len(args)} items")
    return tuple(
        from_json(tp, item, buffers, f"{path}[{i}]")
        for i, (tp, item) in enumerate(zip(args, items, strict=True))
    )


def _dict(
    args: tuple[object, ...], data: object, buffers: BufferTable, path: str
) -> dict[Any, Any]:
    key_tp, value_tp = args
    if key_tp is not str and not (isinstance(key_tp, type) and issubclass(key_tp, Enum)):
        raise TypeError(f"dict keys must be str or a str enum, not {key_tp!r}")
    if not isinstance(data, dict):
        _invalid(path, "expected an object")
    result: dict[Any, Any] = {}
    for key, item in data.items():
        try:
            typed_key = key if key_tp is str else key_tp(key)
        except ValueError:
            _invalid(f"{path}.{key}", "unknown key")
        result[typed_key] = from_json(value_tp, item, buffers, f"{path}.{key}")
    return result


def _list(data: object, path: str) -> list[object]:
    if not isinstance(data, list):
        _invalid(path, "expected an array")
    return list(data)


def _marker_index(data: object) -> int | None:
    if isinstance(data, dict) and set(data) == {"$bin"}:
        index = data["$bin"]
        if type(index) is int and index >= 0:
            return index
    return None


def _is_int(data: object) -> bool:
    return type(data) is int


def _safe_int(value: int) -> int:
    if abs(value) > MAX_SAFE_INT:
        raise ValueError("integer is outside the JSON safe range")
    return value


def _json_key(key: object) -> str:
    if isinstance(key, Enum):
        key = key.value
    if not isinstance(key, str):
        raise TypeError("dict keys must be str or a str enum")
    return key


def _sort_key(value: object) -> str:
    return str(value.value if isinstance(value, Enum) else value)


def _invalid(path: str, reason: str) -> NoReturn:
    # The message names the field and the rule, never the value: values can be passwords.
    raise RpcFailure(INVALID_ARGS, f"{path}: {reason}", {"path": path})
