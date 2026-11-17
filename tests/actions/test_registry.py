"""Registry contracts of ``pdfeditor.actions``: argument types, requirements, dispatch.

These tests run without Qt: the actions layer must not import PySide6.
"""

from __future__ import annotations

import dataclasses
import enum
import importlib
import os
import subprocess
import sys
import types
import typing
from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest

from pdfeditor.actions import REGISTRY, available, run
from pdfeditor.actions.base import Busy, NotSupported
from pdfeditor.actions.pages import DeletePages, RotatePages
from pdfeditor.core.session import DocumentSession, EventKind
from pdfeditor.engine.base import Capabilities
from pdfeditor.engine.registry import get_engine
from pdfeditor.model.annotations import AnnotationModel
from pdfeditor.model.outline import OutlineItem
from tests.actions.conftest import Opener

PAGE_ACTIONS = {
    "pages.delete",
    "pages.move",
    "pages.duplicate",
    "pages.rotate",
    "pages.insert_blank",
    "pages.insert_file",
    "pages.insert_image",
    "pages.replace",
    "pages.crop_margins",
    "pages.crop_rect",
    "pages.trim_white_margins",
    "pages.set_labels",
}


def _is_string_key(tp: Any) -> bool:
    """JSON object keys are strings: ``str`` or an Enum whose members all have str values."""
    if tp is str:
        return True
    return (
        isinstance(tp, type)
        and issubclass(tp, enum.Enum)
        and bool(tp.__members__)  # an Enum with no members has no keys to speak of: refuse it
        and all(isinstance(m.value, str) for m in tp)
    )


def _is_optional_datetime(tp: Any) -> bool:
    return tp is datetime or set(typing.get_args(tp)) == {datetime, type(None)}


def field_violations(tp: Any, where: str, seen: set[type]) -> list[str]:
    """Why a field type breaks W1.3 §3 rule 1; an empty list when it is allowed.

    Allowed: bool, int, float, str, bytes, Enum subclasses, ``tuple[X, ...]`` and fixed-length
    ``tuple[X, Y, ...]``, ``dict[K, X]`` with a string key ``K``, ``X | None``, and dataclasses
    from pdfeditor.model or pdfeditor.services built from the same types. ``datetime`` is
    allowed only as ``AnnotationModel.created``/``modified`` (checked in the dataclass loop).
    """
    if tp in {bool, int, float, str, bytes}:
        return []
    if isinstance(tp, type) and issubclass(tp, enum.Enum):
        return []
    origin = typing.get_origin(tp)
    args = typing.get_args(tp)
    if origin is tuple:
        if len(args) == 2 and args[1] is Ellipsis:
            return field_violations(args[0], where, seen)
        return [v for a in args for v in field_violations(a, where, seen)]
    if origin is dict and len(args) == 2:
        key, value = args
        out = [] if _is_string_key(key) else [f"{where}: dict key {key!r} is not str"]
        return out + field_violations(value, where, seen)
    if origin in (typing.Union, types.UnionType):
        non_none = [a for a in args if a is not type(None)]
        if len(args) == 2 and len(non_none) == 1:
            return field_violations(non_none[0], where, seen)
        return [f"{where}: {tp!r} is not 'X | None'"]
    if isinstance(tp, type) and dataclasses.is_dataclass(tp):
        if not tp.__module__.startswith(("pdfeditor.model", "pdfeditor.services")):
            return [f"{where}: dataclass {tp.__qualname__} is outside pdfeditor.model/services"]
        if tp in seen:
            return []
        seen.add(tp)
        return _fields_violations(tp, where, seen)
    return [f"{where}: {tp!r} is not allowed"]


_DATETIME_FIELDS = {"created", "modified"}

# W1.2's JSON mapping treats a list like a tuple; the model keeps lists here because the bookmarks
# panel edits them in place. Only these (class, field) pairs may be a list; the element type is
# still checked.
MODEL_LIST_FIELDS = {(OutlineItem, "children")}


def _fields_violations(cls: type, where: str, seen: set[type]) -> list[str]:
    hints = typing.get_type_hints(cls)
    out: list[str] = []
    for f in dataclasses.fields(cls):
        ftype = hints[f.name]
        if cls is AnnotationModel and f.name in _DATETIME_FIELDS and _is_optional_datetime(ftype):
            continue  # ISO 8601 on the wire (W1.2 §6)
        if (cls, f.name) in MODEL_LIST_FIELDS and typing.get_origin(ftype) is list:
            ftype = typing.get_args(ftype)[0]
        out += field_violations(ftype, f"{where}.{f.name}", seen)
    return out


def args_violations(cls: type) -> list[str]:
    return _fields_violations(cls, cls.__qualname__, set())


class _StrSlot(enum.StrEnum):
    TOP = "top"


class _IntSlot(enum.Enum):
    ONE = 1


@dataclass(frozen=True)
class _Good:
    count: int
    names: tuple[str, ...] = ()
    label: str | None = None
    pair: tuple[str, str] = ("", "")  # fixed length, like line_endings
    texts: dict[str, str] = dataclasses.field(default_factory=dict)  # like extra
    slots: dict[_StrSlot, str] = dataclasses.field(default_factory=dict)  # like HeaderFooter


class _EmptySlot(enum.StrEnum):
    pass


@dataclass(frozen=True)
class _Bad:
    names: list[str]
    where: Path
    when: datetime
    callback: Any
    by_int: dict[int, str]
    by_int_enum: dict[_IntSlot, str]
    by_empty_enum: dict[_EmptySlot, str]
    created: datetime | None  # the AnnotationModel exemption is for that class only


def test_walker_accepts_allowed_types() -> None:
    assert args_violations(_Good) == []


def test_walker_rejects_forbidden_types() -> None:
    problems = args_violations(_Bad)
    assert len(problems) == 8
    for name in (
        "names",
        "where",
        "when",
        "callback",
        "by_int",
        "by_int_enum",
        "by_empty_enum",
        "created",
    ):
        assert any(p.startswith(f"_Bad.{name}:") for p in problems), name


def test_walker_exempts_only_the_listed_model_list_fields() -> None:
    # SetOutline carries OutlineItem, whose children are a list: allowed by the exception
    assert args_violations(OutlineItem) == []
    # the same list anywhere else is still rejected, and so is a list of a forbidden type
    assert field_violations(list[OutlineItem], "where", set()) != []
    assert any("names" in p for p in args_violations(_Bad))


def test_walker_accepts_annotation_model_with_its_datetimes() -> None:
    # line_endings, extra and created/modified are the W1.2 §6 cases the walker allows; a bare
    # datetime elsewhere is rejected by _Bad.when above
    assert args_violations(AnnotationModel) == []


@pytest.fixture
def session(fixture_pdf, tmp_path: Path):
    path = tmp_path / "text_multipage.pdf"
    path.write_bytes(fixture_pdf("text_multipage").read_bytes())
    opened = DocumentSession.open(path)
    yield opened
    with opened.lock:
        opened.document.close()


@pytest.mark.parametrize("name", sorted(REGISTRY))
def test_args_type_is_a_frozen_dataclass_of_allowed_fields(name: str) -> None:
    spec = REGISTRY[name]
    assert dataclasses.is_dataclass(spec.args), name
    assert spec.args.__dataclass_params__.frozen, name
    assert args_violations(spec.args) == [], name


def test_every_requirement_is_a_capability_flag() -> None:
    flags = {f.name for f in dataclasses.fields(Capabilities)}
    for spec in REGISTRY.values():
        assert set(spec.requires) <= flags, spec.name


def test_page_actions_are_registered_with_the_engine_flag() -> None:
    assert PAGE_ACTIONS.issubset(REGISTRY)
    for name in PAGE_ACTIONS - {"pages.set_labels"}:
        assert REGISTRY[name].requires == ("page_ops",), name
    assert REGISTRY["pages.set_labels"].requires == ()
    assert REGISTRY["pages.trim_white_margins"].long


def test_run_rejects_an_unknown_name(session: DocumentSession) -> None:
    with pytest.raises(KeyError):
        run(session, "pages.nope", DeletePages((0,)))


def test_run_rejects_the_wrong_args_type(session: DocumentSession) -> None:
    with pytest.raises(TypeError):
        run(session, "pages.rotate", DeletePages((0,)))


def test_run_refuses_a_missing_capability(session: DocumentSession) -> None:
    engine_off = replace(get_engine().capabilities, page_ops=False)
    fake = cast(DocumentSession, SimpleNamespace(engine=SimpleNamespace(capabilities=engine_off)))
    with pytest.raises(NotSupported, match="page_ops"):
        run(fake, "pages.rotate", RotatePages((0,), 90))
    assert session.page_count > 0  # the real session is untouched by the fake


def test_available_lists_the_page_actions_for_mupdf(session: DocumentSession) -> None:
    names = available(session)
    assert names == sorted(names)
    assert PAGE_ACTIONS <= set(names) <= set(REGISTRY)


def busy_cases_for(name: str) -> object:
    """The minimal args for ``name``: ``BUSY_CASES`` in the test module of the module that defines
    the action (``pdfeditor.actions.pages`` -> ``tests.actions.test_pages``), so each group adds
    its cases in its own test file."""
    module = REGISTRY[name].fn.__module__.rsplit(".", 1)[1]
    tests = importlib.import_module(f"tests.actions.test_{module}")
    cases: dict[str, object] = getattr(tests, "BUSY_CASES", {})
    assert name in cases, f"add {name!r} to BUSY_CASES in tests/actions/test_{module}.py"
    return cases[name]


@pytest.mark.parametrize("name", sorted(REGISTRY))
def test_actions_refuse_while_a_task_runs(open_copy: Opener, name: str) -> None:
    args = busy_cases_for(name)
    s = open_copy("text_multipage")
    events: list[EventKind] = []
    unsubscribe = s.subscribe(lambda event: events.append(event.kind))
    s.begin_task("OCR")
    try:
        with pytest.raises(Busy, match="OCR"):
            run(s, name, args)
    finally:
        s.end_task("OCR")
        unsubscribe()
    assert EventKind.BLOCKED in events
    assert not s.undo_stack.can_undo


@pytest.mark.skipif(sys.platform == "emscripten", reason="no subprocesses in Pyodide")
def test_importing_the_package_does_not_load_qt() -> None:
    code = (
        "import sys, pdfeditor.actions;"
        "qt = [m for m in sys.modules if m.split('.')[0] in ('PySide6', 'shiboken6')];"
        "sys.exit(1 if qt else 0)"
    )
    env = {**os.environ, "PYTHONPATH": os.pathsep.join(p for p in sys.path if p)}
    proc = subprocess.run(
        [sys.executable, "-c", code], env=env, capture_output=True, text=True, timeout=180
    )
    assert proc.returncode == 0, proc.stderr
