"""Live smoke tests against the real translation services. Opt-in and never run by default.

Run them with ELANERO_LIVE_TRANSLATION=1. Each service also needs its own setting:
ELANERO_DEEPL_KEY (DeepL), ELANERO_AZURE_KEY with an optional ELANERO_AZURE_REGION (Azure),
ELANERO_LIBRETRANSLATE_URL with an optional ELANERO_LIBRETRANSLATE_KEY (LibreTranslate).
MyMemory needs nothing. These tests send a short English sentence; nothing else.
"""

from __future__ import annotations

import os

import pytest

from pdfeditor.services import translation as tr
from pdfeditor.services.translation.base import Translation

pytestmark = pytest.mark.network

LIVE = os.environ.get("ELANERO_LIVE_TRANSLATION") == "1"
TEXT = "Hello world"


def _check(result: Translation) -> None:
    assert result.text.strip(), "the service returned an empty translation"
    assert result.text.strip() != TEXT, "the service returned the input unchanged"


@pytest.mark.skipif(not LIVE, reason="set ELANERO_LIVE_TRANSLATION=1 to call real services")
def test_live_mymemory_translates_hello_world() -> None:
    translator = tr.make_translator("mymemory", tr.TranslationConfig())
    _check(translator.translate(TEXT, "en", "de"))


@pytest.mark.skipif(not LIVE, reason="set ELANERO_LIVE_TRANSLATION=1 to call real services")
@pytest.mark.skipif(not os.environ.get("ELANERO_DEEPL_KEY"), reason="needs ELANERO_DEEPL_KEY")
def test_live_deepl_translates_hello_world() -> None:
    config = tr.TranslationConfig(deepl_key=os.environ["ELANERO_DEEPL_KEY"])
    _check(tr.make_translator("deepl", config).translate(TEXT, "en", "de"))


@pytest.mark.skipif(not LIVE, reason="set ELANERO_LIVE_TRANSLATION=1 to call real services")
@pytest.mark.skipif(not os.environ.get("ELANERO_AZURE_KEY"), reason="needs ELANERO_AZURE_KEY")
def test_live_azure_translates_hello_world() -> None:
    config = tr.TranslationConfig(
        azure_key=os.environ["ELANERO_AZURE_KEY"],
        azure_region=os.environ.get("ELANERO_AZURE_REGION", ""),
    )
    _check(tr.make_translator("azure", config).translate(TEXT, "en", "de"))


@pytest.mark.skipif(not LIVE, reason="set ELANERO_LIVE_TRANSLATION=1 to call real services")
@pytest.mark.skipif(
    not os.environ.get("ELANERO_LIBRETRANSLATE_URL"), reason="needs ELANERO_LIBRETRANSLATE_URL"
)
def test_live_libretranslate_translates_hello_world() -> None:
    config = tr.TranslationConfig(
        libretranslate_url=os.environ["ELANERO_LIBRETRANSLATE_URL"],
        libretranslate_key=os.environ.get("ELANERO_LIBRETRANSLATE_KEY", ""),
    )
    _check(tr.make_translator("libretranslate", config).translate(TEXT, "en", "de"))
