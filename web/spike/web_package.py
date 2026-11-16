"""What of ``src/pdfeditor`` the web version ships, as one list (spike stand-in for W2.6).

Shared by the W0.2 size measurements and the W0.4 import audit, so both look at the same
package. The excluded set is decision 9 of docs/web/plan.md; W0.4 may move modules in or out,
with the reason in its report. Stdlib only.
"""

from __future__ import annotations

import sys
import zipfile
from pathlib import Path, PurePosixPath

REPO = Path(__file__).resolve().parents[2]
PACKAGE = REPO / "src" / "pdfeditor"

# Paths relative to src/pdfeditor, POSIX style. A folder entry ends with "/".
EXCLUDED: tuple[str, ...] = (
    "ui/",
    "services/signing/",
    "services/ocr.py",
    "services/pdfa.py",
    "services/store_updates.py",
    "services/file_association.py",
    "services/export/office.py",
    "engine/mupdf/ocr_worker.py",
    "selftest.py",
    "app.py",
    "__main__.py",
    "data/tessdata/",
    # A build-time check of the branding assets, run from a checkout. Not app code: the web
    # set is the packages of decision 9 plus three top-level files (95 modules, W0.4).
    "data/branding/elanero/VERIFY_ASSETS.py",
)

# Packages that don't exist or aren't wanted on the web. numpy exists in Pyodide, but the app
# doesn't use it (only tests do), so importing it from the web set is a finding.
BLOCKED: tuple[str, ...] = (
    "PySide6",
    "shiboken6",
    "pikepdf",
    "pyhanko",
    "pkcs11",
    "winrt",
    "asn1crypto",
    "cryptography",
    "numpy",
)

_FIXED_TIME = (2026, 1, 1, 0, 0, 0)


def is_excluded(relative: str) -> bool:
    """``relative`` is a path under src/pdfeditor, POSIX style."""
    for entry in EXCLUDED:
        if entry.endswith("/") and (relative + "/").startswith(entry):
            return True
        if relative == entry:
            return True
    return False


def web_files() -> list[PurePosixPath]:
    """Every file the web package ships, sorted, relative to src/pdfeditor."""
    files = []
    for path in PACKAGE.rglob("*"):
        if not path.is_file() or "__pycache__" in path.parts or path.suffix == ".pyc":
            continue
        relative = PurePosixPath(path.relative_to(PACKAGE).as_posix())
        if not is_excluded(str(relative)):
            files.append(relative)
    return sorted(files)


def web_modules() -> list[str]:
    """Dotted names of every module in the web set (``pdfeditor.x.y``)."""
    names = []
    for relative in web_files():
        if relative.suffix != ".py":
            continue
        parts = ("pdfeditor", *relative.with_suffix("").parts)
        if parts[-1] == "__init__":
            parts = parts[:-1]
        names.append(".".join(parts))
    return names


def build_zip(out: Path) -> Path:
    """Write the web package as a deterministic zip (sorted entries, fixed timestamps), with
    ``pdfeditor/`` at the root so the zip can go straight on ``sys.path``."""
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for relative in web_files():
            info = zipfile.ZipInfo(f"pdfeditor/{relative}", date_time=_FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, (PACKAGE / relative).read_bytes())
    return out


if __name__ == "__main__":
    target = (
        Path(sys.argv[1])
        if len(sys.argv) > 1
        else REPO / "web" / "spike" / "out" / "pdfeditor-web.zip"
    )
    built = build_zip(target)
    print(f"{built} ({built.stat().st_size} bytes, {len(web_files())} files)")
