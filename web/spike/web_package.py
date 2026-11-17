"""Spike shim for the web package list (W2.6 moved the list to ``scripts/web_package.py``).

Loaded by path so ``web/spike/audit/scan.py`` and the spike's zip step keep their
``import web_package`` and get the same names. Stdlib only.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_SHARED = Path(__file__).resolve().parents[2] / "scripts" / "web_package.py"
_spec = importlib.util.spec_from_file_location("pdfeditor_web_package", _SHARED)
assert _spec is not None and _spec.loader is not None
_shared = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_shared)

REPO = _shared.REPO
PACKAGE = _shared.PACKAGE
EXCLUDED = _shared.EXCLUDED
BLOCKED = _shared.BLOCKED
is_excluded = _shared.is_excluded
web_files = _shared.web_files
web_modules = _shared.web_modules
build_zip = _shared.build_zip

if __name__ == "__main__":
    target = (
        Path(sys.argv[1])
        if len(sys.argv) > 1
        else REPO / "web" / "spike" / "out" / "pdfeditor-web.zip"
    )
    built = build_zip(target)
    print(f"{built} ({built.stat().st_size} bytes, {len(web_files())} files)")
