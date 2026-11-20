"""Pages to images (PNG / JPEG / TIFF) and extraction of embedded images and fonts."""

from __future__ import annotations

import io
import re
from collections.abc import Sequence
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

from PIL import Image

from pdfeditor.core.jobs import CancelToken, ProgressFn, no_progress
from pdfeditor.engine.base import ColorMode, Document, RenderRequest
from pdfeditor.model.fonts import licence_refusal
from pdfeditor.model.geometry import Matrix
from pdfeditor.model.metadata import ImageInfo
from pdfeditor.model.platform import current
from pdfeditor.services.export.fonts import program_fs_type


class ImageFormat(Enum):
    PNG = "png"
    JPEG = "jpeg"
    TIFF = "tiff"

    @property
    def suffix(self) -> str:
        return {"png": ".png", "jpeg": ".jpg", "tiff": ".tif"}[self.value]


@dataclass(frozen=True)
class PageImageOptions:
    format: ImageFormat = ImageFormat.PNG
    dpi: int = 150
    grayscale: bool = False
    jpeg_quality: int = 90
    annotations: bool = True
    multipage_tiff: bool = True  # TIFF: all pages in one file


def render_page(doc: Document, index: int, options: PageImageOptions) -> Image.Image:
    color = ColorMode.GRAY if options.grayscale else ColorMode.RGB
    shot = doc.page(index).render(
        RenderRequest(
            matrix=Matrix.scale(options.dpi / 72), color=color, annotations=options.annotations
        )
    )
    mode = "L" if options.grayscale else "RGB"
    img = Image.frombytes(mode, (shot.width, shot.height), shot.samples, "raw", mode, shot.stride)
    img.info["dpi"] = (options.dpi, options.dpi)
    return img


def tiff_compression() -> str:
    """The TIFF writer's compression for this platform.

    A failed deflate write aborts the Pyodide runtime (W0.4), so the web build takes LZW through
    its platform flag and must never reach the deflate branch.
    """
    return current().tiff_compression


def _save(img: Image.Image, target: Path, options: PageImageOptions) -> None:
    kwargs: dict[str, object] = {"dpi": (options.dpi, options.dpi)}
    if options.format is ImageFormat.JPEG:
        kwargs.update(quality=options.jpeg_quality, optimize=True)
    elif options.format is ImageFormat.TIFF:
        kwargs["compression"] = tiff_compression()
    img.save(target, format=options.format.value.upper(), **kwargs)


def export_pages(
    doc: Document,
    pages: Sequence[int],
    target: Path,
    options: PageImageOptions,
    token: CancelToken | None = None,
    progress: ProgressFn = no_progress,
) -> list[Path]:
    """Write ``target`` itself for a single image (one page, or a multi-page TIFF); otherwise
    ``<stem>-<page number>.<ext>`` next to it."""
    target = target.with_suffix(options.format.suffix)
    target.parent.mkdir(parents=True, exist_ok=True)
    single_file = options.format is ImageFormat.TIFF and options.multipage_tiff
    width = len(str(max(pages) + 1)) if pages else 1
    written: list[Path] = []
    frames: list[Image.Image] = []
    for n, index in enumerate(pages):
        if token is not None:
            token.check()
        img = render_page(doc, index, options)
        if single_file:
            frames.append(img)
        else:
            path = (
                target
                if len(pages) == 1
                else target.with_name(f"{target.stem}-{index + 1:0{width}d}{target.suffix}")
            )
            _save(img, path, options)
            written.append(path)
        progress(n + 1, len(pages))
    if single_file and frames:
        frames[0].save(
            target,
            format="TIFF",
            save_all=True,
            append_images=frames[1:],
            compression=tiff_compression(),
            dpi=(options.dpi, options.dpi),
        )
        written.append(target)
    return written


def _unique(folder: Path, name: str) -> Path:
    path = folder / name
    k = 2
    while path.exists():
        path = folder / f"{Path(name).stem}-{k}{Path(name).suffix}"
        k += 1
    return path


def _selected_images(doc: Document, pages: Sequence[int] | None, min_size: int) -> list[ImageInfo]:
    wanted = set(pages) if pages is not None else None
    return [
        i
        for i in doc.images()
        if (wanted is None or wanted.intersection(i.pages))
        and i.width >= min_size
        and i.height >= min_size
    ]


def oversized_images(
    doc: Document, pages: Sequence[int] | None, max_pixels: int, min_size: int = 16
) -> int:
    """How many of the images ``extract_images`` would take are above ``max_pixels``."""
    return sum(1 for i in _selected_images(doc, pages, min_size) if i.width * i.height > max_pixels)


def extract_images(
    doc: Document,
    folder: Path,
    pages: Sequence[int] | None = None,
    min_size: int = 16,
    token: CancelToken | None = None,
    progress: ProgressFn = no_progress,
    max_pixels: int | None = None,
) -> list[Path]:
    """Save each distinct image (shown on ``pages``, default all) in its own format.

    ``max_pixels`` skips larger images. The web build sets it, since decoding a huge image in wasm
    memory can exhaust the heap; the desktop passes None and takes them all.
    """
    folder.mkdir(parents=True, exist_ok=True)
    infos = [
        i
        for i in _selected_images(doc, pages, min_size)
        if max_pixels is None or i.width * i.height <= max_pixels
    ]
    written: list[Path] = []
    for n, info in enumerate(infos):
        if token is not None:
            token.check()
        data, ext = doc.extract_image(info.ref)
        if ext == "jpx":  # JPEG 2000 is poorly supported by viewers
            buf = io.BytesIO()
            Image.open(io.BytesIO(data)).save(buf, format="PNG")
            data, ext = buf.getvalue(), "png"
        name = f"page{info.pages[0] + 1}-image{n + 1}.{'jpg' if ext == 'jpeg' else ext}"
        path = _unique(folder, name)
        path.write_bytes(data)
        written.append(path)
        progress(n + 1, len(infos))
    return written


@dataclass(frozen=True)
class FontExtraction:
    """What ``extract_fonts`` did: the files written, and the fonts it did not save."""

    written: list[Path]
    not_embedded: list[str]  # no program in the document (base-14 or Type3, or unextractable)
    refused: list[tuple[str, str]]  # (font name, reason): "restricted", "bitmap_only", "unreadable"


_UNSAFE_NAME_CHARS = re.compile(r"[^A-Za-z0-9 ._+-]")
_RESERVED_NAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{i}" for i in range(1, 10)}
    | {f"LPT{i}" for i in range(1, 10)}
)


def _safe_file_name(name: str, fallback: str = "font") -> str:
    """A file name with no path parts. A PDF name can hold "/" or a leading "..", so the
    characters are replaced first, then the leading dots and spaces are dropped."""
    cleaned = re.sub(r"\.{2,}", "_", _UNSAFE_NAME_CHARS.sub("_", name)).lstrip(". ")
    # Windows maps CON, NUL, COM1... to devices even with an extension, so "CON.ttf" would
    # write nowhere; the underscore makes it an ordinary file name on every platform
    if cleaned.split(".", 1)[0].upper() in _RESERVED_NAMES:
        cleaned = "_" + cleaned
    stem, dot, ext = cleaned.rpartition(".")
    if not dot:
        stem, ext = cleaned, ""
    stem = stem.rstrip(" ")[:100] or fallback
    ext = re.sub(r"[^A-Za-z0-9]", "", ext)
    return f"{stem}.{ext}" if ext else stem


def _licence_refusal(program: bytes) -> str | None:
    """Why the program's licence forbids saving it, or None. An unreadable OS/2 table is refused
    too: the safe side of the licence rule, since its fsType cannot be checked."""
    try:
        return licence_refusal(program_fs_type(program))
    except ValueError:
        return "unreadable"


def extract_fonts(
    doc: Document,
    folder: Path,
    token: CancelToken | None = None,
    progress: ProgressFn = no_progress,
) -> FontExtraction:
    """Save every embedded font program whose licence allows it.

    A font whose embedding flags forbid saving (restricted, or bitmap only) is reported in
    ``refused`` and not written, so the same fonts are refused as in embedding and .docx export.
    """
    folder.mkdir(parents=True, exist_ok=True)
    fonts = doc.fonts()
    written: list[Path] = []
    not_embedded: list[str] = []
    refused: list[tuple[str, str]] = []
    for n, font in enumerate(fonts):
        if token is not None:
            token.check()
        if not font.embedded:
            not_embedded.append(font.name)
        else:
            try:
                name, data = doc.extract_font(font.ref)
            except ValueError:
                not_embedded.append(font.name)
            else:
                reason = _licence_refusal(data)
                if reason is None:
                    path = _unique(folder, _safe_file_name(name))
                    path.write_bytes(data)
                    written.append(path)
                else:
                    refused.append((font.name, reason))
        progress(n + 1, len(fonts))
    return FontExtraction(written, not_embedded, refused)
