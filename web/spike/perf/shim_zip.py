"""Append the W0.2 shims to the web package zip (spike only; see shims/).

Usage: python perf/shim_zip.py <zip>. Adds a file only when the zip does not already hold it.
"""

from __future__ import annotations

import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SHIMS = {"pdfeditor/engine/mupdf/ocr_worker.py": HERE / "shims" / "ocr_worker.py"}
_FIXED_TIME = (2026, 1, 1, 0, 0, 0)  # the same timestamp web_package.py uses: deterministic


def add_shims(zip_path: Path) -> list[str]:
    added = []
    with zipfile.ZipFile(zip_path, "a", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        names = set(zf.namelist())
        for arcname, source in SHIMS.items():
            if arcname in names:
                continue
            info = zipfile.ZipInfo(arcname, date_time=_FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, source.read_bytes())
            added.append(arcname)
    return added


if __name__ == "__main__":
    print("added:", add_shims(Path(sys.argv[1])) or "nothing")
