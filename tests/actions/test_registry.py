"""Registry contracts of ``pdfeditor.actions``: argument types, requirements, dispatch.

These tests run without Qt: the actions layer must not import PySide6.
"""

from __future__ import annotations

import dataclasses
import enum
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
from pdfeditor.actions.base import NotSupported
from pdfeditor.actions.pages import DeletePages, RotatePages
from pdfeditor.core.session import DocumentSession
from pdfeditor.engine.base import Capabilities
from pdfeditor.engine.registry import get_engine

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


def field_violations(tp: Any, where: str, seen: set[type]) -> list[str]:
    """Why a field type breaks W1.3 §3 rule 1; an empty list when it is allowed.

    Allowed: bool, int, float, str, bytes, Enum subclasses, ``tuple[X, ...]``, ``X | None``, and
    dataclasses from pdfeditor.model or pdfeditor.services built from the same types.
    """
    if tp in {bool, int, float, str, bytes}:
        return []
    if isinstance(tp, type) and issubclass(tp, enum.Enum):
        return []
    origin = typing.get_origin(tp)
    args = typing.get_args(tp)
    if origin is tuple and len(args) == 2 and args[1] is Ellipsis:
        return field_violations(args[0], where, seen)
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
        hints = typing.get_type_hints(tp)
        out: list[str] = []
        for f in dataclasses.fields(tp):
            out += field_violations(hints[f.name], f"{where}.{f.name}", seen)
        return out
    return [f"{where}: {tp!r} is not allowed"]


def args_violations(cls: type) -> list[str]:
    seen: set[type] = set()
    hints = typing.get_type_hints(cls)
    out: list[str] = []
    for f in dataclasses.fields(cls):
        out += field_violations(hints[f.name], f"{cls.__qualname__}.{f.name}", seen)
    return out


@dataclass(frozen=True)
class _Good:
    count: int
    names: tuple[str, ...] = ()
    label: str | None = None


@dataclass(frozen=True)
class _Bad:
    names: list[str]
    where: Path
    when: datetime
    callback: Any


def test_walker_accepts_allowed_types() -> None:
    assert args_violations(_Good) == []


def test_walker_rejects_forbidden_types() -> None:
    problems = args_violations(_Bad)
    assert len(problems) == 4
    assert any("names" in p for p in problems) and any("where" in p for p in problems)
    assert any("when" in p for p in problems) and any("callback" in p for p in problems)


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
    assert available(session) == sorted(PAGE_ACTIONS)


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
