"""The Pyodide run's stand-ins for pikepdf and pypdfium2 (web/test/pyodide/host_stubs.py).

The stub factory is loaded from its file, so this desktop test never installs the stubs into
sys.modules. The stubs must derive from Exception: a test names them in ``except`` and in
``pytest.raises``, and an ``except`` clause raises TypeError for a class that is not a
BaseException subclass.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

import pytest

_STUBS = Path(__file__).resolve().parents[2] / "web" / "test" / "pyodide" / "host_stubs.py"


@pytest.fixture(scope="module")
def stubs() -> ModuleType:
    spec = importlib.util.spec_from_file_location("pyodide_host_stubs_under_test", _STUBS)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(
    "name",
    [
        "pikepdf.PasswordError",
        "pikepdf.PdfError",
        "pikepdf.ForeignObjectError",
        "pypdfium2.PdfiumError",
        "pikepdf.Stream",  # not an exception, but the same factory: every stand-in is one
        "pypdfium2.PdfDocument",
    ],
)
def test_every_stand_in_is_an_exception_subclass(stubs: ModuleType, name: str) -> None:
    cls = stubs.host_class(name)
    assert issubclass(cls, Exception)
    assert issubclass(cls, BaseException)


def test_module_attributes_are_exception_stand_ins(stubs: ModuleType) -> None:
    module = stubs._make_host_module("pikepdf")
    assert issubclass(module.PasswordError, Exception)
    assert issubclass(module.open, Exception)  # any attribute, lazily


def test_except_clause_with_a_stand_in_is_valid(stubs: ModuleType) -> None:
    """``except`` with a stand-in must not raise TypeError when another exception passes by."""
    stand_in = stubs.host_class("pikepdf.PasswordError")
    caught = False
    try:
        try:
            raise RuntimeError("from the engine")
        except stand_in:
            pytest.fail("a RuntimeError must not match the stand-in")
    except RuntimeError:
        caught = True
    assert caught


def test_calling_a_stand_in_still_skips(stubs: ModuleType) -> None:
    """The first host call still skips the test, as before the fix."""
    stand_in = stubs.host_class("pikepdf.PasswordError")
    with pytest.raises(pytest.skip.Exception, match="needs host-side verification"):
        stand_in()


def test_stand_in_identity_and_caching(stubs: ModuleType) -> None:
    assert stubs.host_class("pikepdf.Pdf") is stubs.host_class("pikepdf.Pdf")
    assert stubs.host_class("pikepdf.Pdf") is not stubs.host_class("pypdfium2.Pdf")
