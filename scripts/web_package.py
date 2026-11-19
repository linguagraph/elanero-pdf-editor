"""What of ``src/pdfeditor`` the web version ships, as one list (W2.6).

Shared by the web build (``scripts/build_web_wheel.py``), the W0.2 size measurements and the
W0.4 import audit (``web/spike``), so all of them look at the same package. The excluded set is
decision 9 of docs/web/plan.md. Any module or data file not listed in ``EXCLUDED`` ships, so a
new package (``webapi``, say) is included as soon as its directory exists. Stdlib only.
"""

from __future__ import annotations

import zipfile
from pathlib import Path, PurePosixPath

REPO = Path(__file__).resolve().parents[1]
PACKAGE = REPO / "src" / "pdfeditor"

# Paths relative to src/pdfeditor, POSIX style. A folder entry ends with "/".
EXCLUDED: tuple[str, ...] = (
    "ui/",
    "services/signing/",
    "services/ocr.py",
    "services/pdfa.py",
    # The system font catalog reads the desktop's font folders; the browser has none, and only
    # the UI and the self-test use it. It imports fontTools at module level, which the web lacks.
    "services/fonts.py",
    "services/store_updates.py",
    "services/file_association.py",
    "services/export/office.py",
    "engine/mupdf/ocr_worker.py",
    "selftest.py",
    "app.py",
    "__main__.py",
    "data/tessdata/",
    # The branding pack, the icons and the self-test PDF are read only by excluded modules (W0.4,
    # and the W2.6 grep: `grep -rn "data_path(" src/pdfeditor`). LICENSE and THIRD_PARTY_NOTICES
    # are not under src/pdfeditor at all; W4.1 decides how the web build shows them.
    "data/branding/",
    "data/icons/",
    "data/sRGB.icc",
    "data/selftest.pdf",
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


def matches(relative: str, entry: str) -> bool:
    """Whether ``relative`` (a path under src/pdfeditor, POSIX style) is covered by ``entry``."""
    if entry.endswith("/"):
        return (relative + "/").startswith(entry)
    return relative == entry


def is_excluded(relative: str) -> bool:
    """``relative`` is a path under src/pdfeditor, POSIX style."""
    return any(matches(relative, entry) for entry in EXCLUDED)


def all_files(package: Path = PACKAGE) -> list[PurePosixPath]:
    """Every file under ``package``, sorted, relative to it. Build output never counts: no
    ``__pycache__`` folder, no ``.pyc`` file and no hidden file or folder."""
    files = []
    for path in package.rglob("*"):
        if not path.is_file():
            continue
        relative = PurePosixPath(path.relative_to(package).as_posix())
        if path.suffix == ".pyc" or any(
            part == "__pycache__" or part.startswith(".") for part in relative.parts
        ):
            continue
        files.append(relative)
    return sorted(files)


def web_files(package: Path = PACKAGE) -> list[PurePosixPath]:
    """Every file the web package ships, sorted, relative to ``package``."""
    return [f for f in all_files(package) if not is_excluded(str(f))]


def web_modules(package: Path = PACKAGE) -> list[str]:
    """Dotted names of every module in the web set (``pdfeditor.x.y``)."""
    names = []
    for relative in web_files(package):
        if relative.suffix != ".py":
            continue
        parts = ("pdfeditor", *relative.with_suffix("").parts)
        if parts[-1] == "__init__":
            parts = parts[:-1]
        names.append(".".join(parts))
    return names


def build_zip(out: Path, package: Path = PACKAGE) -> Path:
    """Write the web package as a deterministic zip (sorted entries, fixed timestamps), with
    ``pdfeditor/`` at the root so the zip can go straight on ``sys.path``."""
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for relative in web_files(package):
            info = zipfile.ZipInfo(f"pdfeditor/{relative}", date_time=_FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, (package / relative).read_bytes())
    return out
