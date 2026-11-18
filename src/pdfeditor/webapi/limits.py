"""Resource limits of the web build (W1.1 section 7). Starting values, tuned by W3.9 and W8.3.

The session calls read these names at call time, so a test can monkeypatch them to small values.
"""

from __future__ import annotations

FILE_WARN_BYTES = 200 * 1024 * 1024  # above this, the open reply carries a warning
FILE_REFUSE_BYTES = 1024**3  # above this, the open fails with FILE_TOO_LARGE
MAX_PAGES = 5000  # more pages than this, the open fails with TOO_MANY_PAGES
