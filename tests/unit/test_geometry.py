from __future__ import annotations

import pytest

from pdfeditor.model.color import Color
from pdfeditor.model.geometry import Matrix, Point, Quad, Rect


def test_rect_basics() -> None:
    r = Rect(10, 20, 110, 70)
    assert (r.width, r.height) == (100, 50)
    assert r.contains(Point(50, 50)) and not r.contains(Point(0, 0))
    assert r.intersects(Rect(100, 60, 200, 200))
    assert not r.intersects(Rect(110, 0, 200, 10))
    assert r.union(Rect(0, 0, 5, 5)) == Rect(0, 0, 110, 70)
    assert Rect(5, 5, 1, 1).normalized() == Rect(1, 1, 5, 5)
    assert Rect(0, 0, 0, 10).is_empty


def test_matrix_rotate_90_is_exact() -> None:
    m = Matrix.rotate(90)
    assert m.as_tuple() == (0.0, 1.0, -1.0, 0.0, 0.0, 0.0)
    assert Point(1, 0).transform(m) == Point(0, 1)


def test_matrix_concat_order() -> None:
    # scale then translate: (1,1) -> (2,2) -> (12,2)
    m = Matrix.scale(2) @ Matrix.translate(10, 0)
    assert Point(1, 1).transform(m) == Point(12, 2)


def test_quad_rect() -> None:
    q = Quad.from_rect(Rect(1, 2, 3, 4))
    assert q.rect == Rect(1, 2, 3, 4)
    assert q.transform(Matrix.translate(1, 1)).rect == Rect(2, 3, 4, 5)


def test_color_parsing() -> None:
    assert Color.from_hex("#f00") == Color(1, 0, 0)
    assert Color.from_hex("00ff0080").a == pytest.approx(128 / 255)
    assert Color.from_int(0x0000FF) == Color(0, 0, 1)
    assert Color.from_components([0.5]) == Color(0.5, 0.5, 0.5)
    assert Color.from_components([0, 0, 0, 1]) == Color(0, 0, 0)
    assert Color(2, -1, 0.5).rgb() == (1.0, 0.0, 0.5)
    assert Color(1, 0.5, 0).to_hex() == "#ff8000"
    with pytest.raises(ValueError):
        Color.from_hex("#12")
