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
