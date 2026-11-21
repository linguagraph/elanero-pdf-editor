"""The web package build (W2.6): what the zip ships, that it imports without the desktop-only
packages, that it is byte-for-byte reproducible, and that the size check trips above budget.

No GUI, no real budget run: the size checks use a small fake package in a temp folder."""

from __future__ import annotations

import filecmp
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

from tests.unit.test_web_imports import GUARD

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import build_web_wheel as bww  # noqa: E402
import web_package as wp  # noqa: E402

# The web set must not import these. Every excluded path also counts as blocked, so a stray
# import of an excluded module (say pdfeditor.services.ocr) fails the same way.
_EXCLUDED_MODULES = [
    "pdfeditor." + entry.removesuffix("/").removesuffix(".py").replace("/", ".")
    for entry in wp.EXCLUDED
]
BLOCKED = tuple(dict.fromkeys([*wp.BLOCKED, *_EXCLUDED_MODULES]))

RUNNER = """
import importlib
import json
import sys

sys.path[:0] = {extra!r}
failures = {{}}
for name in {modules!r}:
    try:
        importlib.import_module(name)
    except Exception as exc:  # the report names each module that failed
        failures[name] = f"{{type(exc).__name__}}: {{exc}}"
print("RESULT " + json.dumps(failures))
"""


def _import_failures(
    modules: list[str], extra_path: tuple[str, ...] = (), blocked: tuple[str, ...] = BLOCKED
) -> dict[str, str]:
    """Import ``modules`` in one interpreter whose import hook refuses ``blocked``. Returns the
    modules that failed, with the error. One interpreter keeps this to a single startup; a
    module that fails is dropped from ``sys.modules`` by Python, so it can't leak into later
    imports."""
    # The trailing comma keeps a one-name list a tuple: ('PIL',), not the string ('PIL').
    code = GUARD.format(blocked="".join(f"{b!r}, " for b in blocked)) + RUNNER.format(
        extra=list(extra_path), modules=modules
    )
    result = subprocess.run(
        [sys.executable, "-c", code], check=False, capture_output=True, text=True, timeout=300
    )
    assert result.returncode == 0, result.stderr
    line = next(ln for ln in result.stdout.splitlines() if ln.startswith("RESULT "))
    failures: dict[str, str] = json.loads(line.removeprefix("RESULT "))
    return failures


def _fake_package(root: Path) -> Path:
    """A few-KB stand-in for src/pdfeditor, for the size and manifest checks."""
    package = root / "pdfeditor"
    (package / "data").mkdir(parents=True)
    (package / "__init__.py").write_text('"""fake"""\n', encoding="utf-8")
    (package / "a.py").write_text("x = 'lorem ipsum dolor sit amet'\n" * 120, encoding="utf-8")
    (package / "data" / "blob.bin").write_bytes(bytes(range(256)) * 16)
    return package


# Decision 9 of docs/web/plan.md: what the engine's open path needs from the runtime. Each key is
# a package blocked on its own; each value is the set of modules that must then fail to import.
# PIL is imported at module level on the open path, so blocking it must break the engine. fontTools
# is needed only by font loading and services/export, so blocking it must leave the engine alone.
# If one of these changes, the manifest's expected_runtime (scripts/build_web_wheel.py) must too.
EXPECTED_IMPORT_FAILURES_WITHOUT: dict[str, frozenset[str]] = {
    "PIL": frozenset({"pdfeditor.engine.mupdf"}),
    "fontTools": frozenset(),
}


@pytest.mark.skipif(sys.platform == "emscripten", reason="no subprocesses in Pyodide")
def test_web_modules_import_without_desktop_packages() -> None:
    modules = list(dict.fromkeys([*wp.web_modules(), "pdfeditor.engine.mupdf"]))
    failures = _import_failures(modules)
    assert failures == {}, failures


@pytest.mark.skipif(sys.platform == "emscripten", reason="no subprocesses in Pyodide")
def test_engine_open_path_needs_pillow() -> None:
    failures = _import_failures(["pdfeditor.engine.mupdf"], blocked=("PIL",))
    assert set(failures) == EXPECTED_IMPORT_FAILURES_WITHOUT["PIL"], failures
    assert "blocked for the web build: PIL" in failures["pdfeditor.engine.mupdf"]


@pytest.mark.skipif(sys.platform == "emscripten", reason="no subprocesses in Pyodide")
def test_engine_open_path_does_not_need_fonttools() -> None:
    failures = _import_failures(["pdfeditor.engine.mupdf"], blocked=("fontTools",))
    assert set(failures) == EXPECTED_IMPORT_FAILURES_WITHOUT["fontTools"], failures


@pytest.mark.skipif(sys.platform == "emscripten", reason="no subprocesses in Pyodide")
def test_web_modules_import_without_fonttools() -> None:
    # The web set includes services/export (Word export, webapi/jobs); fontTools is read only
    # inside the functions that use it, so the set imports without it.
    modules = list(dict.fromkeys([*wp.web_modules(), "pdfeditor.engine.mupdf"]))
    failures = _import_failures(modules, blocked=(*BLOCKED, "fontTools"))
    assert failures == {}, failures


@pytest.mark.skipif(sys.platform == "emscripten", reason="no subprocesses in Pyodide")
def test_guard_catches_a_module_that_imports_pikepdf(tmp_path: Path) -> None:
    # Negative control: the same check must fail on a leaky module and pass on a clean one.
    fake = tmp_path / "fakepkg"
    fake.mkdir()
    (fake / "__init__.py").write_text("", encoding="utf-8")
    (fake / "leaky.py").write_text("import pikepdf\n", encoding="utf-8")
    (fake / "clean.py").write_text("X = 1\n", encoding="utf-8")

    failures = _import_failures(["fakepkg.leaky", "fakepkg.clean"], (str(tmp_path),))

    assert set(failures) == {"fakepkg.leaky"}
    assert "blocked for the web build: pikepdf" in failures["fakepkg.leaky"]


# Excluded data that is git-ignored and fetched on demand (scripts/fetch_tessdata.py), so a CI
# checkout doesn't have it. These entries are exempt from the must-exist check below, but still
# have to be excluded and git-ignored.
GENERATED_EXCLUDED = ("data/tessdata/",)


def test_excluded_entries_exist_in_the_tree() -> None:
    report = bww.excluded_report(wp.PACKAGE)
    missing = [
        row["path"]
        for row in report
        if not row["matched"] and row["path"] not in GENERATED_EXCLUDED
    ]
    assert missing == []


def test_generated_excluded_entries_are_listed_and_git_ignored() -> None:
    ignored = {line.strip() for line in (ROOT / ".gitignore").read_text().splitlines()}
    for entry in GENERATED_EXCLUDED:
        assert entry in wp.EXCLUDED, entry
        assert f"src/pdfeditor/{entry}" in ignored, entry


def test_zip_has_no_excluded_path_and_no_build_output(tmp_path: Path) -> None:
    zip_path = wp.build_zip(tmp_path / "web.zip")
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()

    assert names == sorted(names)
    assert "pdfeditor/__init__.py" in names
    assert all(name.startswith("pdfeditor/") for name in names)
    for name in names:
        relative = name.removeprefix("pdfeditor/")
        assert not wp.is_excluded(relative), name
        assert "__pycache__" not in name and not name.endswith(".pyc"), name
        assert not any(part.startswith(".") for part in relative.split("/")), name


def test_zip_is_byte_identical_across_builds(tmp_path: Path) -> None:
    first = wp.build_zip(tmp_path / "a" / "web.zip")
    second = wp.build_zip(tmp_path / "b" / "web.zip")
    assert filecmp.cmp(first, second, shallow=False)


def test_stray_build_output_in_a_copy_of_the_tree_is_left_out(tmp_path: Path) -> None:
    copy = tmp_path / "pdfeditor"
    shutil.copytree(wp.PACKAGE, copy, ignore=shutil.ignore_patterns("__pycache__"))
    (copy / "__pycache__").mkdir()
    (copy / "__pycache__" / "stray.cpython-311.pyc").write_bytes(b"\0")
    (copy / "stray.pyc").write_bytes(b"\0")
    (copy / ".hidden.py").write_text("X = 1\n", encoding="utf-8")
    (copy / ".cache").mkdir()
    (copy / ".cache" / "note.py").write_text("X = 1\n", encoding="utf-8")

    assert wp.web_files(copy) == wp.web_files(wp.PACKAGE)
    assert wp.web_modules(copy) == wp.web_modules(wp.PACKAGE)


def test_budget_check_trips_above_the_budget(tmp_path: Path) -> None:
    package = _fake_package(tmp_path)
    zip_path = wp.build_zip(tmp_path / "fake.zip", package)
    size = bww.gzip_size(zip_path.read_bytes())

    assert bww.check_budget(size, budget=size) is True
    assert bww.check_budget(size, budget=size - 1) is False
    assert bww.check_budget(bww.GZIP_BUDGET_BYTES) is True
    assert bww.check_budget(bww.GZIP_BUDGET_BYTES + 1) is False


def test_run_writes_manifest_and_exits_1_over_budget(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    package = _fake_package(tmp_path / "src")
    out = tmp_path / "out"

    assert bww.run(out, package=package, budget=1) == 1
    printed = capsys.readouterr().out
    assert "FAILED" in printed and "budget of 1 bytes" in printed and "decision 10" in printed

    assert bww.run(out, package=package) == 0
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["modules"] == ["pdfeditor", "pdfeditor.a"]
    assert manifest["module_count"] == 2
    assert manifest["expected_runtime"] == bww.EXPECTED_RUNTIME
    assert manifest["version"] == bww.package_version()
    assert {row["path"] for row in manifest["excluded"]} == set(wp.EXCLUDED)
    zip_info = manifest["zip"]
    assert zip_info["gzip_bytes"] == bww.gzip_size((out / bww.ZIP_NAME).read_bytes())
    on_disk = sum(p.stat().st_size for p in package.rglob("*") if p.is_file())
    assert zip_info["uncompressed_bytes"] == on_disk


@pytest.mark.skipif(sys.platform == "emscripten", reason="no subprocesses in Pyodide")
def test_font_preview_ships_and_imports_without_fonttools() -> None:
    # The text editor's preview copy (W6.8a) runs in the web worker, so the module must ship, and
    # it must import with fontTools blocked: fontTools is imported only inside the function.
    assert "pdfeditor.services.font_preview" in wp.web_modules()
    assert "services/font_preview.py" in [str(f) for f in wp.web_files()]
    failures = _import_failures(["pdfeditor.services.font_preview"], blocked=("fontTools",))
    assert failures == {}, failures


@pytest.mark.skipif(sys.platform == "emscripten", reason="no subprocesses in Pyodide")
def test_font_check_ships_and_imports_without_fonttools() -> None:
    # The uploaded-font check (W6.9) runs in the web worker, so its module ships; fontTools is
    # imported only inside its functions, so the module loads before the worker installs it.
    assert "services/fonts.py" in [str(f) for f in wp.web_files()]
    modules = ["pdfeditor.services.fonts", "pdfeditor.webapi.fonts"]
    failures = _import_failures(modules, blocked=(*BLOCKED, "fontTools"))
    assert failures == {}, failures


def test_private_copy_refuses_when_fonttools_is_absent(monkeypatch: pytest.MonkeyPatch) -> None:
    # A missing fontTools is the web worker before its install: the copy is refused, not raised.
    from pdfeditor.services.font_preview import private_copy

    monkeypatch.setitem(sys.modules, "fontTools", None)
    monkeypatch.setitem(sys.modules, "fontTools.ttLib", None)
    assert private_copy(b"not a font", "PDF Font test") == b""
