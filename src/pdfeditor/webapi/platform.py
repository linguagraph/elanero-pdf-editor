"""The web platform's flags (W1.1 section 3), set once when the worker starts.

Nothing else decides "this is the web" for these questions: features read the flags in
``model.platform``, so a feature is hidden by its flag and not by an OS check.
"""

from __future__ import annotations

from pdfeditor.model.platform import PlatformCapabilities, configure

# Undo snapshots live in the worker's memory file system (W1.1 section 7).
WEB_SNAPSHOT_BUDGET = 512 * 1024 * 1024

# Pillow's name for the TIFF writer's compression. Deflate aborts the Pyodide runtime on a
# failed write (docs/web/spikes/W0.4-results.md), so the web build uses LZW.
WEB_PLATFORM = PlatformCapabilities(
    linearize=False,
    ocr=False,
    signing=False,
    system_fonts=False,
    office_import=False,
    threads=False,
    pdfa=False,
    tiff_compression="tiff_lzw",
)


def configure_web() -> None:
    """Set the web flags. The worker calls it once at start-up; calling it again sets the same
    values, so it is idempotent."""
    configure(WEB_PLATFORM)
