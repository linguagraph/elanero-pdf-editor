"""Property tests (hypothesis) for the geometry model.

Kept apart from test_geometry.py: hypothesis is not in the Pyodide package set, so this module is
desktop-only and the web run never imports it.
"""

from __future__ import annotations

import pytest
from hypothesis import given
from hypothesis import strategies as st

from pdfeditor.model.geometry import Matrix, Point

pytestmark = pytest.mark.desktop_only

finite = st.floats(min_value=-1e4, max_value=1e4, allow_nan=False)


@given(finite, finite, st.floats(min_value=0.1, max_value=10), st.floats(0, 360))
def test_matrix_inverse_roundtrip(x: float, y: float, s: float, angle: float) -> None:
    m = Matrix.scale(s) @ Matrix.rotate(angle) @ Matrix.translate(3, -7)
    p = Point(x, y).transform(m).transform(m.inverted())
    assert p.x == pytest.approx(x, abs=1e-6)
    assert p.y == pytest.approx(y, abs=1e-6)
