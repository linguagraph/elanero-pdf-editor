"""The image checks the actions share (content edits, custom stamps): is this picture one the
platform adds, within its limits (W7.3b section 5).

Each refusal carries a stable reason, which the web words from its own catalogue (rpc/errors.ts
REFUSED_REASON); the English message is what the desktop shows.
"""

from __future__ import annotations

from pdfeditor.actions.base import Refused
from pdfeditor.model import platform
from pdfeditor.services.image_input import ImageTooManyPixels, probe_image


def check_image(data: bytes) -> None:
    """Refuse bytes that are not an image this platform adds (the flags in model.platform). The
    web sends untrusted input, so the size is checked before Pillow reads the header, and the
    header before the engine is asked to insert anything. Desktop limits are None, so the desktop
    only gets the readable check."""
    caps = platform.current()
    if not data:
        raise Refused("This file is not an image the editor can read.", reason="image_unreadable")
    if caps.max_image_bytes is not None and len(data) > caps.max_image_bytes:
        raise Refused(
            f"This image is larger than {caps.max_image_bytes // 1024**2} MB.",
            reason="image_too_large",
        )
    try:
        probe = probe_image(data)
    except ImageTooManyPixels:
        raise Refused(
            too_many_pixels(caps.max_image_pixels), reason="image_too_many_pixels"
        ) from None
    if probe is None:
        raise Refused("This file is not an image the editor can read.", reason="image_unreadable")
    if caps.image_formats is not None and probe.format not in caps.image_formats:
        raise Refused("Only PNG and JPEG images can be added here.", reason="image_format")
    if caps.max_image_pixels is not None and probe.width * probe.height > caps.max_image_pixels:
        raise Refused(too_many_pixels(caps.max_image_pixels), reason="image_too_many_pixels")


def too_many_pixels(limit: int | None) -> str:
    if limit is None:
        return "This image has too many pixels for the editor."
    return (
        f"This image has more than {limit // 1_000_000} million pixels, the most the editor adds."
    )
