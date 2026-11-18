"""Resource limits of the web build (W1.1 section 7). Starting values, tuned by W3.9 and W8.3.

The session calls read these names at call time, so a test can monkeypatch them to small values.
"""

from __future__ import annotations

FILE_WARN_BYTES = 200 * 1024 * 1024  # above this, the open reply carries a warning
FILE_REFUSE_BYTES = 1024**3  # above this, the open fails with FILE_TOO_LARGE
MAX_PAGES = 5000  # more pages than this, the open fails with TOO_MANY_PAGES
MAX_SAVE_BYTES = FILE_REFUSE_BYTES  # a saved file above this fails with FILE_TOO_LARGE (W1.1 §7)

# Text calls (W1.4 section 13, W1.2 section 9). W1.4 gives the page count of a slice but no size
# for the query or the reply; those two are documented caps chosen here.
TEXT_PAGES_PER_SLICE = 50  # a chunked text or search slice stops after this many pages
MAX_QUERY_CHARS = 512  # a longer search string is refused with INVALID_ARGS
MAX_HITS_PER_REPLY = 1000  # a slice stops after the page that reaches this many hits
MIN_BUDGET_MS = 20  # budget_ms of a chunked call (W1.2 section 9)
MAX_BUDGET_MS = 1000

# Render limits (W1.1 section 7 and W1.4 section 4). Both are checked before MuPDF draws anything.
MAX_RENDER_PIXELS = 64_000_000  # per page image: 64 MP, the W1.1 print and export ceiling
MAX_RENDER_SCALE_MILLI = 256_000  # device scale 256: zoom 64 (W1.4 MAX_ZOOM) x 96/72 x DPR 3
MAX_TILE_PIXELS = 16_000_000  # per tile of render.tile: the W1.1 section 7 per-tile ceiling

# Jobs (W1.1 section 7, W1.2 section 13). A job gets a copy of the document, so its bytes are
# held to the same size as an open file; the worker runs one job at a time.
MAX_JOB_BYTES = FILE_REFUSE_BYTES  # a document copy or a job result above this is refused
MAX_PREPARED_JOBS = 1  # prepared jobs (begun or waiting for their run) per engine worker

# Undo snapshots live in the worker's memory file system (W1.1 section 7). Past this budget the
# oldest snapshots are dropped and the undo history shortens (W2.3); nothing is refused.
SNAPSHOT_BUDGET_BYTES = 512 * 1024 * 1024
