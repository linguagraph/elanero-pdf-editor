"""Redaction and sanitization options."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from pdfeditor.model.geometry import Quad, Rect


class ImageRedaction(Enum):
    NONE = "none"  # leave images alone
    PIXELS = "pixels"  # blank only the covered pixels
    REMOVE = "remove"  # remove any image that touches a mark


class GraphicsRedaction(Enum):
    NONE = "none"
    COVERED = "covered"  # remove vector graphics fully inside a mark
    TOUCHED = "touched"  # remove vector graphics that touch a mark


@dataclass(frozen=True, slots=True)
class RedactOptions:
    images: ImageRedaction = ImageRedaction.PIXELS
    graphics: GraphicsRedaction = GraphicsRedaction.COVERED
    text: bool = True


@dataclass(frozen=True, slots=True)
class SanitizeOptions:
    metadata: bool = True  # Info dictionary
    xmp: bool = True
    javascript: bool = True
    attachments: bool = True  # embedded files and file-attachment annotations
    links: bool = True
    hidden_text: bool = True  # invisible text (render mode 3), e.g. old OCR layers
    comments: bool = True  # every annotation except form fields
    form_data: bool = True  # reset form field values
    thumbnails: bool = True
    hidden_layers: bool = True  # content of optional-content layers that are off by default
    off_page_text: bool = True  # text lying entirely outside the page's crop box


@dataclass(frozen=True, slots=True)
class MarkRef:
    """A redaction mark named by its page and /NM name (never the engine's object id)."""

    page: int
    name: str


@dataclass(frozen=True, slots=True)
class RedactionArea:
    """One redaction mark to add: a box, and optionally the text runs it covers and the text."""

    page: int
    rect: Rect
    quads: tuple[Quad, ...] = ()
    text: str = ""
