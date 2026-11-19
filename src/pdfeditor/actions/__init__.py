"""The actions layer: every document change a front end can request (W1.3).

The desktop calls the action functions directly with typed arguments. The web looks them up by
name through :data:`REGISTRY`. Nothing here imports Qt, so ``tests/actions`` runs headless.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Callable
from typing import Any, TypeVar

from pdfeditor.actions.base import ActionResult, ActionSpec, NotSupported
from pdfeditor.core.session import DocumentSession
from pdfeditor.model import platform

F = TypeVar("F", bound=Callable[..., Any])

REGISTRY: dict[str, ActionSpec] = {}


def action(
    name: str, args: type, *, requires: tuple[str, ...] = (), long: bool = False
) -> Callable[[F], F]:
    """Register the function under ``name``; ``requires`` lists capability flags it needs."""

    def register(fn: F) -> F:
        if name in REGISTRY:
            raise ValueError(f"action {name!r} is already registered")
        REGISTRY[name] = ActionSpec(name=name, args=args, fn=fn, requires=requires, long=long)
        return fn

    return register


_PLATFORM_FLAGS = frozenset(f.name for f in dataclasses.fields(platform.PlatformCapabilities))


def _requirement_holds(session: DocumentSession, name: str) -> bool:
    """Whether a capability an action needs is on: an engine flag, or a platform flag (W2.2)
    when the name is one of those. The web platform turns off some of them (OCR, signing)."""
    if name in _PLATFORM_FLAGS:
        return bool(getattr(platform.current(), name))
    return bool(getattr(session.engine.capabilities, name))


def run(session: DocumentSession, name: str, args: object) -> ActionResult[Any]:
    spec = REGISTRY.get(name)
    if spec is None:
        raise KeyError(f"unknown action {name!r}")
    if not isinstance(args, spec.args):
        raise TypeError(f"{name} takes {spec.args.__name__}, not {type(args).__name__}")
    missing = [r for r in spec.requires if not _requirement_holds(session, r)]
    if missing:
        raise NotSupported(f"{name} needs {', '.join(missing)}")
    return spec.fn(session, args)


def available(session: DocumentSession) -> list[str]:
    """Sorted names of the actions whose requirements hold for this session."""
    return sorted(
        name
        for name, spec in REGISTRY.items()
        if all(_requirement_holds(session, r) for r in spec.requires)
    )


# Registration happens on import. The group modules import ``action`` from this package, so
# they must come after it is defined.
from pdfeditor.actions import (  # noqa: E402,F401
    comment_tools,
    comments,
    content,
    document,
    marks,
    pages,
    redaction,
    security,
)
