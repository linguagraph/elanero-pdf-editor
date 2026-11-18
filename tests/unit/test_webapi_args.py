"""The strict JSON mapping of the web DTOs (W1.2 section 6): unknown, missing and mistyped fields
are INVALID_ARGS with the path of the field, and types the mapping can't express are refused."""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta, timezone
from enum import StrEnum
from typing import Any

import pytest

from pdfeditor.webapi.dto import BufferTable, from_json, to_json
from pdfeditor.webapi.errors import INVALID_ARGS, RpcFailure


class Colour(StrEnum):
    RED = "red"
    BLUE = "blue"


@dataclass(frozen=True, slots=True)
class Sample:
    name: str
    count: int
    ratio: float
    flag: bool
    password: str | None
    colour: Colour
    sizes: tuple[int, ...]
    corners: tuple[float, float]
    labels: dict[str, int]
    when: datetime
    data: bytes


SAMPLE_JSON: dict[str, Any] = {
    "name": "a.pdf",
    "count": 3,
    "ratio": 0.5,
    "flag": True,
    "password": None,
    "colour": "red",
    "sizes": [1, 2],
    "corners": [0, 1.5],
    "labels": {"x": 1},
    "when": "2026-11-18T10:00:00+00:00",
    "data": {"$bin": 0},
}


def _parse(data: object, buffers: list[bytes] | None = None) -> Sample:
    table = BufferTable(buffers if buffers is not None else [b"%PDF"])
    value = from_json(Sample, data, table, "params")
    table.check_all_used()
    return value


def _failure(data: object, buffers: list[bytes] | None = None) -> RpcFailure:
    with pytest.raises(RpcFailure) as caught:
        _parse(data, buffers)
    assert caught.value.code == INVALID_ARGS
    return caught.value


def test_valid_object_maps_every_kind_of_field() -> None:
    value = _parse(dict(SAMPLE_JSON))
    assert value.name == "a.pdf"
    assert value.count == 3 and value.flag is True
    assert value.password is None
    assert value.colour is Colour.RED
    assert value.sizes == (1, 2)
    assert value.corners == (0.0, 1.5)
    assert value.labels == {"x": 1}
    assert value.when == datetime(2026, 11, 18, 10, tzinfo=UTC)
    assert value.data == b"%PDF"


def test_password_may_be_null_or_a_string() -> None:
    assert _parse({**SAMPLE_JSON, "password": None}).password is None
    assert _parse({**SAMPLE_JSON, "password": "secret"}).password == "secret"


def test_unknown_field_is_invalid_args_with_its_path() -> None:
    failure = _failure({**SAMPLE_JSON, "extra": 1})
    assert failure.details == {"path": "params.extra"}


def test_missing_field_is_invalid_args_with_its_path() -> None:
    data = dict(SAMPLE_JSON)
    del data["password"]  # no default, so it must be sent (as null when there is none)
    failure = _failure(data)
    assert failure.details == {"path": "params.password"}


@pytest.mark.parametrize(
    ("field", "bad", "path"),
    [
        ("name", 1, "params.name"),
        ("count", True, "params.count"),  # a bool is not an integer
        ("count", 2.0, "params.count"),  # nor is a float
        ("count", 2**60, "params.count"),  # outside the JSON safe range
        ("ratio", True, "params.ratio"),
        ("ratio", "0.5", "params.ratio"),
        ("flag", 1, "params.flag"),  # nor is an integer a bool
        ("colour", "green", "params.colour"),
        ("sizes", [1, "2"], "params.sizes[1]"),
        ("corners", [0, 1, 2], "params.corners"),
        ("labels", {"x": "1"}, "params.labels.x"),
        ("when", "2026-11-18T10:00:00", "params.when"),  # no offset
        ("when", 5, "params.when"),
        ("data", "not a marker", "params.data"),
        ("data", {"$bin": True}, "params.data"),
    ],
)
def test_mistyped_field_is_invalid_args_with_its_path(field: str, bad: object, path: str) -> None:
    failure = _failure({**SAMPLE_JSON, field: bad})
    assert failure.details == {"path": path}


def test_message_never_echoes_the_value() -> None:
    failure = _failure({**SAMPLE_JSON, "count": "hunter2"})
    assert "hunter2" not in failure.message


def test_non_finite_numbers_are_rejected() -> None:
    with pytest.raises(RpcFailure):
        _parse({**SAMPLE_JSON, "ratio": math.nan})


def test_datetime_round_trips_with_its_offset() -> None:
    when = datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone(timedelta(hours=2)))
    out: list[bytes] = []
    assert to_json(when, out) == "2026-01-02T03:04:05+02:00"


def test_to_json_replaces_bytes_by_markers_in_order() -> None:
    out: list[bytes] = []
    value = to_json({"a": b"one", "b": [b"two"]}, out)
    assert value == {"a": {"$bin": 0}, "b": [{"$bin": 1}]}
    assert out == [b"one", b"two"]


def test_frozenset_is_sorted_on_output() -> None:
    out: list[bytes] = []
    assert to_json(frozenset({"b", "a", "c"}), out) == ["a", "b", "c"]


def test_to_json_refuses_non_finite_floats() -> None:
    with pytest.raises(ValueError):
        to_json(math.inf, [])


@pytest.mark.parametrize("tp", [list[int], Any, object, int | str])
def test_types_the_mapping_refuses(tp: object) -> None:
    table = BufferTable([])
    with pytest.raises(TypeError):
        from_json(tp, [1], table, "params")
