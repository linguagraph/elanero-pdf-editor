"""Platform capability flags: desktop defaults, configure(), and the gates that read them."""

from __future__ import annotations

import dataclasses
from dataclasses import replace

import pytest

from pdfeditor.engine.registry import get_engine
from pdfeditor.model.platform import PlatformCapabilities, configure, current
from pdfeditor.services.fonts import system_font_dirs


@pytest.fixture
def set_platform():
    """Change the platform for one test; the previous value is restored afterwards."""
    saved = current()

    def apply(**changes: object) -> None:
        configure(replace(saved, **changes))

    yield apply
    configure(saved)


def test_defaults_are_desktop_values() -> None:
    caps = PlatformCapabilities()
    assert caps.linearize and caps.ocr and caps.signing and caps.system_fonts
    assert caps.office_import and caps.threads and caps.pdfa
    assert caps.tiff_compression == "tiff_deflate"
    assert current() == caps


def test_capabilities_are_frozen() -> None:
    caps = PlatformCapabilities()
    with pytest.raises(dataclasses.FrozenInstanceError):
        caps.ocr = False  # type: ignore[misc]


def test_configure_changes_what_current_returns(set_platform) -> None:
    set_platform(ocr=False, tiff_compression="tiff_lzw")
    assert current().ocr is False
    assert current().tiff_compression == "tiff_lzw"
    assert current().signing is True  # the other flags keep their values


def test_system_font_dirs_empty_without_system_fonts(set_platform) -> None:
    set_platform(system_fonts=False)
    assert system_font_dirs() == []


def test_system_font_dirs_unchanged_with_system_fonts(set_platform) -> None:
    expected = system_font_dirs()
    set_platform(system_fonts=True)
    assert system_font_dirs() == expected


def test_mupdf_ocr_capability_follows_platform(set_platform) -> None:
    engine = get_engine()
    assert engine.capabilities.ocr is True
    set_platform(ocr=False)
    assert engine.capabilities.ocr is False
    assert engine.capabilities.redact is True  # other flags are not touched
