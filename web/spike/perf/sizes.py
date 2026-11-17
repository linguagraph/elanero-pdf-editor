"""M1: first-load bytes for the two asset sets, raw, gzip -9 and brotli -q 11 (spike only).

Run after ``node perf/stage.mjs``. Writes ``out/sizes.json`` and prints the Markdown table.
GitHub Pages serves gzip, so the gzip total is the budget figure (plan decision 10: <= 40 MB).

Brotli needs the ``brotli`` Python package or a ``brotli`` command on PATH; otherwise the column is
marked n/a (no dependency is added for it). Stdlib only otherwise.
"""

from __future__ import annotations

import gzip
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

SPIKE = Path(__file__).resolve().parents[1]  # web/spike
DIST = SPIKE / "dist"
PERF = DIST / "perf"
PACKAGES = DIST / "packages"
CORE = (
    "pyodide.mjs",
    "pyodide.asm.mjs",
    "pyodide.asm.wasm",
    "python_stdlib.zip",
    "pyodide-lock.json",
)
BUDGET_GZIP = 40_000_000  # plan decision 10, decimal megabytes


BROTLI_SOURCE = "n/a"


def _brotli_fn():
    global BROTLI_SOURCE
    try:
        import brotli  # type: ignore[import-not-found]

        BROTLI_SOURCE = "python package"
        return lambda data: brotli.compress(data, quality=11)
    except ImportError:
        pass
    exe = shutil.which("brotli")
    if exe is None:
        return None
    BROTLI_SOURCE = f"command {exe}"

    def run(data: bytes) -> bytes:
        return subprocess.run(
            [exe, "-c", "-q", "11"], input=data, capture_output=True, check=True
        ).stdout

    return run


def _gzip(data: bytes) -> int:
    return len(gzip.compress(data, compresslevel=9, mtime=0))


def _row(name: str, data: bytes, brotli) -> dict[str, object]:
    return {
        "file": name,
        "raw": len(data),
        "gzip": _gzip(data),
        "brotli": len(brotli(data)) if brotli else None,
    }


def _total(rows: list[dict[str, object]], key: str) -> int | None:
    values = [r[key] for r in rows]
    if any(v is None for v in values):
        return None
    return sum(int(v) for v in values)  # type: ignore[arg-type]


def build() -> dict[str, object]:
    brotli = _brotli_fn()
    lock = json.loads((PACKAGES / "pyodide-lock.json").read_text(encoding="utf-8"))
    wheel = json.loads((PERF / "wheel.json").read_text(encoding="utf-8"))
    names = json.loads((PERF / "packages.json").read_text(encoding="utf-8"))
    zip_path = PERF / "pdfeditor-web.zip"

    core_rows = [
        _row(n, (SPIKE / "node_modules" / "pyodide" / n).read_bytes(), brotli) for n in CORE
    ]
    wheel_row = _row(wheel["file"], (PACKAGES / wheel["file"]).read_bytes(), brotli)
    zip_row = _row(zip_path.name, zip_path.read_bytes(), brotli)
    viewer = [*core_rows, wheel_row, zip_row]

    package_rows = [
        _row(
            lock["packages"][n]["file_name"],
            (PACKAGES / lock["packages"][n]["file_name"]).read_bytes(),
            brotli,
        )
        for n in names
    ]
    full = [*viewer, *package_rows]

    data_raw = data_gzip = 0
    data_files = 0
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            if info.filename.startswith("pdfeditor/data/") and not info.is_dir():
                payload = zf.read(info)
                data_raw += len(payload)
                data_gzip += _gzip(payload)
                data_files += 1

    def totals(rows: list[dict[str, object]]) -> dict[str, object]:
        return {
            "raw": _total(rows, "raw"),
            "gzip": _total(rows, "gzip"),
            "brotli": _total(rows, "brotli"),
        }

    return {
        "brotliSource": BROTLI_SOURCE,
        "viewerSet": {"rows": viewer, "totals": totals(viewer)},
        "fullSet": {"rows": full, "totals": totals(full)},
        "packages": names,
        "data": {"files": data_files, "raw": data_raw, "gzip": data_gzip},
        "zipFiles": len(zipfile.ZipFile(zip_path).namelist()),
        "budgetGzip": BUDGET_GZIP,
        "fullSetGzipMet": totals(full)["gzip"] <= BUDGET_GZIP,
    }


def main() -> int:
    result = build()
    out = SPIKE / "out"
    out.mkdir(parents=True, exist_ok=True)
    (out / "sizes.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    full = result["fullSet"]["totals"]
    print(f"full set: {full['raw']} bytes raw, {full['gzip']} bytes gzip -9")
    return 0


if __name__ == "__main__":
    sys.exit(main())
