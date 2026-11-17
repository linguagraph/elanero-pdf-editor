"""The backend's synthetic annotation names: the prefix followed by ASCII digits."""

from __future__ import annotations

import pytest

from pdfeditor.model.annotations import SYNTHETIC_NAME_PREFIX, is_synthetic_name


@pytest.mark.parametrize("name", ["#0", "#7", "#123456"])
def test_prefix_and_digits_are_synthetic(name: str) -> None:
    assert name.startswith(SYNTHETIC_NAME_PREFIX) and is_synthetic_name(name)


@pytest.mark.parametrize(
    "name",
    [
        "",
        "#",
        "#a1",
        "#7a",
        "# 7",
        "#\u0663",  # Arabic-Indic digit three: not an object number
        "7",
        "pdfeditor-0123abcd",
        "fitz-A0",
        "x#7",
    ],
)
def test_other_names_are_not_synthetic(name: str) -> None:
    assert not is_synthetic_name(name)
