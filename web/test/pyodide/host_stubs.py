"""Stand-in modules for the host-only packages (pikepdf, pypdfium2) in the Pyodide run.

Split out of ``pyodide_conftest.py`` so a CPython unit test can import the stub factory. The plugin
reads ``sys.monitoring`` at import (Python 3.12+), which the desktop interpreter lacks. Importing
this module has no side effects: ``install_host_stubs()`` puts the stubs in place.
"""

from __future__ import annotations

import importlib.abc
import importlib.machinery
import sys
import types
from typing import Any

import pytest

HOST_ONLY_TOP_LEVEL = ("pikepdf", "pypdfium2")
HOST_PREFIX = "needs host-side verification"


def _host_skip(name: str) -> None:
    # allow_module_level: a host call made while a test module is imported skips the module.
    pytest.skip(f"{HOST_PREFIX}: {name}", allow_module_level=True)


class _HostMeta(type):
    """Metaclass of a stand-in class. Attribute access gives another stand-in (lazy); any use
    other than a plain attribute read or an identity check raises the host skip."""

    def __getattr__(cls, attr: str) -> Any:
        # Private names (``_pytestfixturefunction``, ``__wrapped__``) are probed by pytest and
        # tooling on every module attribute; a stand-in must not look like a fixture or a test.
        if attr.startswith("_"):
            raise AttributeError(attr)
        return host_class(f"{cls._host_name}.{attr}")

    def __call__(cls, *args: object, **kwargs: object) -> Any:
        _host_skip(cls._host_name)

    def __getitem__(cls, key: object) -> Any:
        _host_skip(cls._host_name)

    def __iter__(cls) -> Any:
        _host_skip(cls._host_name)

    def __len__(cls) -> int:
        _host_skip(cls._host_name)
        return 0

    def __bool__(cls) -> bool:
        _host_skip(cls._host_name)
        return True

    def __eq__(cls, other: object) -> bool:
        _host_skip(cls._host_name)
        return False

    __hash__ = type.__hash__


_CLASSES: dict[str, type] = {}


def host_class(name: str) -> type:
    """The stand-in for a host-only class, e.g. ``pikepdf.PasswordError``.

    Every stand-in derives from ``Exception``. Tests name these classes in ``except`` and in
    ``pytest.raises``, and an ``except`` clause raises TypeError unless its class derives from
    BaseException. ``Exception`` is also what pikepdf and pypdfium2 raise, so the stand-in matches
    them. Only the metaclass decides what a stand-in does, so it still skips on first use.
    """
    cls = _CLASSES.get(name)
    if cls is None:
        module, _, short = name.rpartition(".")
        cls = _HostMeta(short, (Exception,), {"_host_name": name, "__module__": module or name})
        _CLASSES[name] = cls
    return cls


class _HostModule(types.ModuleType):
    def __getattr__(self, attr: str) -> Any:
        if attr.startswith("_"):
            raise AttributeError(attr)
        return host_class(f"{self.__name__}.{attr}")


def _make_host_module(name: str) -> _HostModule:
    module = _HostModule(name)
    module.__path__ = []  # type: ignore[attr-defined]  # so submodule imports reach the finder
    return module


class _HostFinder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    """Stub submodules (``import pikepdf.foo``) the same way as the top-level modules."""

    def find_spec(
        self,
        fullname: str,
        path: Any,
        target: types.ModuleType | None = None,
    ) -> importlib.machinery.ModuleSpec | None:
        if fullname.partition(".")[0] in HOST_ONLY_TOP_LEVEL:
            return importlib.machinery.ModuleSpec(fullname, self, is_package=True)
        return None

    def create_module(self, spec: importlib.machinery.ModuleSpec) -> _HostModule:
        return _make_host_module(spec.name)

    def exec_module(self, module: types.ModuleType) -> None:
        return None


def install_host_stubs() -> None:
    for name in HOST_ONLY_TOP_LEVEL:
        sys.modules.setdefault(name, _make_host_module(name))
    sys.meta_path.insert(0, _HostFinder())
