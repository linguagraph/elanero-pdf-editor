"""The Edit tool's shared geometry (W6.7a S2): hit tests, handles, resize and reselection.

These pin the answers the desktop has always given, so the shared module can move without
changing them. The vectors file the web tests against is checked here too (no drift).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from pdfeditor.actions import edit_geometry as eg
from pdfeditor.model.geometry import Point, Rect
from pdfeditor.model.objects import ObjectType, PageObject

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import make_edit_vectors  # noqa: E402

VECTORS = ROOT / "web" / "src" / "tools" / "vectors" / "edit-geometry.json"
BOX = Rect(0.0, 0.0, 100.0, 50.0)


def _obj(key: str, box: Rect, kind: ObjectType = ObjectType.TEXT) -> PageObject:
    return PageObject(kind, key, box)


# -- hit testing ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("point", "expected"),
    [
        (Point(0.0, 0.0), 0),  # corner: handle 0 wins
        (Point(50.0, 25.0), None),  # inside, away from handles
        (Point(100.0, 25.0), 4),  # right edge midpoint, on the handle
        (Point(-7.0, 25.0), None),  # outside, beyond the tolerance
        (Point(100.0, 50.0), 7),  # bottom-right corner
    ],
)
def test_handle_at_inside_edge_and_outside(point: Point, expected: int | None) -> None:
    assert eg.handle_at(BOX, point, eg.HANDLE_PX) == expected


def test_handle_at_zero_tolerance_needs_exact_hit() -> None:
    assert eg.handle_at(BOX, Point(0.5, 0.0), 0.0) is None
    assert eg.handle_at(BOX, Point(0.0, 0.0), 0.0) == 0


def test_object_at_inside_edge_and_outside() -> None:
    obj = _obj("a", BOX)
    assert eg.object_at([obj], Point(50.0, 25.0), 0.0) is obj
    assert eg.object_at([obj], Point(100.0, 25.0), 0.0) is obj  # on the edge counts
    assert eg.object_at([obj], Point(100.5, 25.0), 0.0) is None
    assert eg.object_at([obj], Point(100.5, 25.0), 2.0) is obj  # tolerance grows the outline


def test_object_at_smallest_wins_and_ties_keep_first() -> None:
    big = _obj("big", Rect(0.0, 0.0, 200.0, 200.0))
    image = _obj("image", Rect(50.0, 50.0, 80.0, 70.0), ObjectType.IMAGE)
    twin = _obj("twin", Rect(50.0, 50.0, 80.0, 70.0), ObjectType.IMAGE)
    assert eg.object_at([big, image], Point(60.0, 60.0), 0.0) is image
    assert eg.object_at([big, image, twin], Point(60.0, 60.0), 0.0) is image
    assert eg.object_at([twin, image], Point(60.0, 60.0), 0.0) is twin


def test_object_at_zero_size_and_empty() -> None:
    spot = _obj("spot", Rect(120.0, 120.0, 120.0, 120.0))
    assert eg.object_at([spot], Point(120.0, 120.0), 0.0) is spot
    assert eg.object_at([spot], Point(125.0, 120.0), 2.0) is None
    assert eg.object_at([], Point(0.0, 0.0), 2.0) is None


def test_objects_in_selects_by_intersection() -> None:
    a = _obj("a", Rect(0.0, 0.0, 10.0, 10.0))
    b = _obj("b", Rect(40.0, 40.0, 50.0, 50.0))
    band = Rect(9.0, 9.0, 41.0, 41.0)
    assert [o.key for o in eg.objects_in([a, b], band)] == ["a", "b"]
    assert eg.objects_in([a, b], Rect(20.0, 20.0, 30.0, 30.0)) == []


def test_is_click_threshold_is_inclusive_on_both_axes() -> None:
    origin = Point(0.0, 0.0)
    assert eg.is_click(origin, Point(3.0, 3.0))
    assert not eg.is_click(origin, Point(3.1, 0.0))
    assert not eg.is_click(origin, Point(0.0, -3.5))


# -- handles and resize ---------------------------------------------------------------------


def test_handle_points_order_matches_desktop_indices() -> None:
    pts = eg.handle_points(BOX)
    assert [(p.x, p.y) for p in pts] == [
        (0.0, 0.0),
        (50.0, 0.0),
        (100.0, 0.0),
        (0.0, 25.0),
        (100.0, 25.0),
        (0.0, 50.0),
        (50.0, 50.0),
        (100.0, 50.0),
    ]


@pytest.mark.parametrize(
    ("handle", "point", "expected"),
    [
        (0, Point(-10.0, -10.0), Rect(-10.0, -10.0, 100.0, 50.0)),  # top-left grows out
        (2, Point(120.0, -5.0), Rect(0.0, -5.0, 120.0, 50.0)),  # top-right
        (3, Point(20.0, 0.0), Rect(20.0, 0.0, 100.0, 50.0)),  # left edge only
        (4, Point(60.0, 99.0), Rect(0.0, 0.0, 60.0, 50.0)),  # right edge only
        (6, Point(0.0, 80.0), Rect(0.0, 0.0, 100.0, 80.0)),  # bottom edge only
        (7, Point(200.0, 200.0), Rect(0.0, 0.0, 200.0, 200.0)),  # bottom-right
        (1, Point(999.0, -5.0), Rect(0.0, -5.0, 100.0, 50.0)),  # top edge ignores x
    ],
)
def test_resize_box_each_handle(handle: int, point: Point, expected: Rect) -> None:
    assert eg.resize_box(BOX, handle, point) == expected


def test_resize_box_floor_pins_at_min_size() -> None:
    # Dragging the left edge past the right edge stops MIN_SIZE short of it.
    assert eg.resize_box(BOX, 3, Point(150.0, 25.0)) == Rect(96.0, 0.0, 100.0, 50.0)
    # Dragging the bottom-right corner past the top-left stops at MIN_SIZE from the origin.
    assert eg.resize_box(BOX, 7, Point(-50.0, -50.0)) == Rect(0.0, 0.0, 4.0, 4.0)


def test_resize_box_very_small_and_zero_size_boxes() -> None:
    tiny = Rect(0.0, 0.0, 0.5, 0.5)
    assert eg.resize_box(tiny, 7, Point(0.5, 0.5)) == Rect(0.0, 0.0, 4.0, 4.0)
    zero = Rect(5.0, 5.0, 5.0, 5.0)
    assert eg.resize_box(zero, 0, Point(5.0, 5.0)) == Rect(1.0, 1.0, 5.0, 5.0)
    assert eg.handle_points(zero) == [Point(5.0, 5.0)] * 8


def test_fit_matrix_maps_old_onto_new() -> None:
    old = Rect(10.0, 20.0, 30.0, 60.0)
    new = Rect(0.0, 0.0, 60.0, 40.0)
    m = eg.fit_matrix(old, new)
    assert m.as_tuple() == pytest.approx((3.0, 0.0, 0.0, 1.0, -30.0, -20.0))
    assert old.transform(m) == new


def test_fit_matrix_zero_width_keeps_scale_on_that_axis() -> None:
    old = Rect(7.0, 1.0, 7.0, 40.0)
    m = eg.fit_matrix(old, Rect(0.0, 0.0, 9.0, 80.0))
    assert m.a == 1.0
    assert m.d == pytest.approx(80.0 / 39.0)


def test_fit_matrix_identity_for_same_box() -> None:
    assert eg.fit_matrix(BOX, BOX).as_tuple() == pytest.approx((1.0, 0.0, 0.0, 1.0, 0.0, 0.0))


# -- reselection and vectors ----------------------------------------------------------------


def test_reselect_picks_nearest_corner_per_box() -> None:
    objs = [_obj("a", Rect(0.0, 0.0, 10.0, 10.0)), _obj("b", Rect(100.0, 100.0, 110.0, 110.0))]
    assert eg.reselect(objs, [Rect(99.0, 101.0, 109.0, 111.0)]) == ["b"]
    assert eg.reselect(objs, []) == []
    assert eg.reselect([], [BOX]) == []


def test_vectors_file_matches_the_module() -> None:
    assert make_edit_vectors.main(["--check"]) == 0
    data = json.loads(VECTORS.read_text(encoding="utf-8"))
    assert data["constants"]["HANDLE_PX"] == eg.HANDLE_PX
    assert len(data["resize_box"]) > 0
