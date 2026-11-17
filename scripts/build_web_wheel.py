"""Build the web package (W2.6): the zip, its manifest, and a package-level size check.

Writes ``dist/web/pdfeditor-web.zip`` and ``dist/web/manifest.json``. The manifest is generated
from the same lists the zip uses, so it cannot drift from the zip. Stdlib only.

The size check is for this package alone. Decision 10 of docs/web/plan.md budgets the whole
first load (the Pyodide runtime, the PyMuPDF wheel and this package) at 40 MB gzip; the full
check comes with W3 and W9, so a pass here does not prove the first load fits.
"""

from __future__ import annotations

import gzip
import json
import sys
import tomllib
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import web_package as wp

OUT_DIR = wp.REPO / "dist" / "web"
ZIP_NAME = "pdfeditor-web.zip"
MANIFEST_NAME = "manifest.json"
GZIP_BUDGET_BYTES = 40 * 1024 * 1024

# Packages the web build does not bundle. Each is imported only when its feature is used, and
# the app has to say so when it is missing (W3 and W4 own that message).
EXPECTED_RUNTIME = {
    "always": [],
    "optional": {
        "fonttools": "editing and font upload",
        "Pillow": "image export, text editing and watermarks",
    },
}


def package_version() -> str:
    with (wp.REPO / "pyproject.toml").open("rb") as handle:
        return str(tomllib.load(handle)["project"]["version"])


def gzip_size(data: bytes) -> int:
    # mtime=0 keeps the size itself reproducible; the gzip header holds no timestamp.
    return len(gzip.compress(data, compresslevel=9, mtime=0))


def check_budget(gzip_bytes: int, budget: int = GZIP_BUDGET_BYTES) -> bool:
    """True when the package's gzip size fits ``budget``. The caller decides what to do."""
    return gzip_bytes <= budget


def excluded_report(package: Path) -> list[dict[str, object]]:
    """Each excluded entry with the number of existing files it covers, so a stale entry (a
    path that no longer exists) shows up as ``matched: false``."""
    files = [str(f) for f in wp.all_files(package)]
    report: list[dict[str, object]] = []
    for entry in wp.EXCLUDED:
        count = sum(1 for f in files if wp.matches(f, entry))
        report.append({"path": entry, "matched": count > 0, "files": count})
    return report


def run(out_dir: Path, package: Path = wp.PACKAGE, budget: int = GZIP_BUDGET_BYTES) -> int:
    """Build into ``out_dir``, write the manifest, print the sizes. Returns the exit code."""
    zip_path = wp.build_zip(out_dir / ZIP_NAME, package)
    data = zip_path.read_bytes()
    with zipfile.ZipFile(zip_path) as zf:
        uncompressed = sum(info.file_size for info in zf.infolist())
    gz = gzip_size(data)
    modules = wp.web_modules(package)
    manifest = {
        "version": package_version(),
        "modules": modules,
        "module_count": len(modules),
        "file_count": len(wp.web_files(package)),
        "excluded": excluded_report(package),
        "zip": {
            "file": ZIP_NAME,
            "uncompressed_bytes": uncompressed,
            "zip_bytes": len(data),
            "gzip_bytes": gz,
        },
        "expected_runtime": EXPECTED_RUNTIME,
    }
    manifest_path = out_dir / MANIFEST_NAME
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    print(f"{zip_path}")
    print(f"  files: {manifest['file_count']}, modules: {len(modules)}")
    print(f"  uncompressed: {uncompressed} bytes, zip: {len(data)} bytes, gzip: {gz} bytes")
    print(f"  manifest: {manifest_path}")
    if not check_budget(gz, budget):
        print(
            f"FAILED: the web package is {gz} bytes gzip, over the budget of {budget} bytes. "
            "The budget covers the whole first load (decision 10), so this check reports only "
            "the package's share."
        )
        return 1
    return 0


def main() -> None:
    sys.exit(run(OUT_DIR))


if __name__ == "__main__":
    main()
