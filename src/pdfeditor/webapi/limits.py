"""Resource limits of the web build (W1.1 section 7). Starting values, tuned by W3.9 and W8.3.

The session calls read these names at call time, so a test can monkeypatch them to small values.
"""

from __future__ import annotations

FILE_WARN_BYTES = 200 * 1024 * 1024  # above this, the open reply carries a warning
FILE_REFUSE_BYTES = 1024**3  # above this, the open fails with FILE_TOO_LARGE
MAX_PAGES = 5000  # more pages than this, the open fails with TOO_MANY_PAGES
# Render limits (W1.1 section 7 and W1.4 section 4). Both are checked before MuPDF draws anything.
MAX_RENDER_PIXELS = 64_000_000  # per page image: 64 MP, the W1.1 print and export ceiling
MAX_RENDER_SCALE_MILLI = 256_000  # device scale 256: zoom 64 (W1.4 MAX_ZOOM) x 96/72 x DPR 3
