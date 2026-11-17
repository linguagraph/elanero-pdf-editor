"""Host checks (tests/hostcheck.py): desktop runs inline; Pyodide runs record for the replay."""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

import pytest

from tests import hostcheck
from tests.hostcheck import HOST_CHECKS, host_check, record


@pytest.fixture
def pyodide(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pretend to run under Pyodide, with an empty recorder."""
    monkeypatch.setattr(hostcheck, "in_pyodide", lambda: True)
    hostcheck.clear()
    yield
    hostcheck.clear()


@pytest.fixture
def desktop(monkeypatch: pytest.MonkeyPatch) -> None:
    """Run as CPython even under Pyodide, where sys.platform is emscripten."""
    monkeypatch.setattr(hostcheck, "in_pyodide", lambda: False)


@pytest.fixture
def probe(monkeypatch: pytest.MonkeyPatch) -> str:
    """A check that the test controls: it fails when the data is not b'ok'."""
    name = "unit_probe"

    def check(data: bytes, expect: str = "ok") -> None:
        assert data == expect.encode(), f"got {data!r}"

    monkeypatch.setitem(HOST_CHECKS, name, check)
    return name


@pytest.mark.skipif(sys.platform == "emscripten", reason="desktop mode only")
def test_desktop_runs_the_check_inline(probe: str, desktop: None, tmp_path: Path) -> None:
    path = tmp_path / "saved.bin"
    path.write_bytes(b"ok")
    record(probe, path, expect="ok")  # passes without raising
    record(probe, b"ok", expect="ok")  # bytes work as well as a path
    assert hostcheck.recorded() == []  # nothing is recorded on desktop


def test_desktop_failure_raises_assertion_error(probe: str, desktop: None) -> None:
    with pytest.raises(AssertionError, match="got b'no'"):
        record(probe, b"no", expect="ok")


def test_pyodide_records_instead_of_running(probe: str, pyodide: None, tmp_path: Path) -> None:
    path = tmp_path / "saved.bin"
    path.write_bytes(b"not ok")  # would fail if the check ran
    record(probe, path, expect="ok", pages=[1, 2])
    (entry,) = hostcheck.recorded()
    assert entry["name"] == probe
    assert json.loads(entry["args"]) == {"expect": "ok", "pages": [1, 2]}
    assert base64.b64decode(entry["data_b64"]) == b"not ok"
    assert "test_pyodide_records_instead_of_running" in entry["test"]  # PYTEST_CURRENT_TEST


def test_non_serialisable_argument_raises_type_error(probe: str, pyodide: None) -> None:
    with pytest.raises(TypeError, match="JSON-serialisable"):
        record(probe, b"ok", expect=object())
    assert hostcheck.recorded() == []


def test_non_serialisable_argument_fails_on_desktop_too(probe: str, desktop: None) -> None:
    with pytest.raises(TypeError, match="JSON-serialisable"):
        record(probe, b"ok", expect=object())


@pytest.mark.parametrize("pyodide_mode", [False, True], ids=["desktop", "pyodide"])
def test_unknown_name_raises_key_error(monkeypatch: pytest.MonkeyPatch, pyodide_mode: bool) -> None:
    monkeypatch.setattr(hostcheck, "in_pyodide", lambda: pyodide_mode)
    with pytest.raises(KeyError, match="no_such_check"):
        record("no_such_check", b"x")


def test_duplicate_registration_is_refused() -> None:
    before = dict(HOST_CHECKS)
    with pytest.raises(ValueError, match="duplicate host check: page_count_pikepdf"):
        host_check("page_count_pikepdf")(lambda data, **args: None)
    assert before == HOST_CHECKS  # the refused function was not registered


def test_registry_has_the_migrated_checks() -> None:
    expected = {
        "page_count_pikepdf",
        "page_count_pdfium",
        "opens_pdfium",
        "text_contains_pdfium",
        "duplicate_objects_pikepdf",
        "duplicate_copy_text_pdfium",
        "duplicate_shares_images_pikepdf",
        "render_first_page_pdfium",
        "copied_form_fields_pikepdf",
        "copied_form_page_pdfium",
        "catalog_keys_pikepdf",
    }
    assert expected.issubset(HOST_CHECKS)
