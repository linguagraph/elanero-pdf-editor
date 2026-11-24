"""What the running platform can do. Desktop defaults: everything the desktop app has.

The web build (docs/web/plan.md, decision 4) calls :func:`configure` once with its own values,
before any engine is used. Nothing else reads ``sys.platform`` for these questions, so a feature
is hidden or skipped by its flag, not by an OS check. This lives in ``model`` (the bottom layer)
because the engine must read it, and the engine may not import ``core``.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class PlatformCapabilities:
    linearize: bool = True  # needs pikepdf (desktop wheel only)
    ocr: bool = True  # Tesseract in a helper process
    signing: bool = True  # pyHanko / PKCS#11
    system_fonts: bool = True  # scan OS font folders
    office_import: bool = True  # LibreOffice (external program)
    threads: bool = True  # may start threads or processes
    pdfa: bool = True  # PDF/A conversion (needs pikepdf)
    # Pillow's name for the TIFF writer's compression. The web build must not use deflate: a
    # failed deflate write aborts the Pyodide runtime (docs/web/spikes/W0.4-results.md).
    tiff_compression: str = "tiff_deflate"
    # The image formats an added image may have (Pillow's names), or None for whatever the engine
    # reads. The size caps, in bytes and in pixels, are None for no cap.
    image_formats: frozenset[str] | None = None
    max_image_bytes: int | None = None
    max_image_pixels: int | None = None
    # The largest file an attachment may embed, in bytes; None for no cap (W7.9 A1).
    max_attachment_bytes: int | None = None


_current = PlatformCapabilities()


def current() -> PlatformCapabilities:
    """The capabilities in force now. Read at the point of use, never cached by callers."""
    return _current


def configure(caps: PlatformCapabilities) -> None:
    """Replace the current capabilities. Called once at startup by a platform build, or by tests."""
    global _current
    _current = caps
