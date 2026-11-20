"""Write the Edit tool's shared geometry test vectors (W6.7a S2).

The desktop and the browser must pick the same object, put the same handles and reshape a box
the same way. ``pdfeditor.actions.edit_geometry`` is the reference; this script runs it over a
fixed set of boxes, points and objects and records the answers in
``web/src/tools/vectors/edit-geometry.json``. The web's Vitest specs check their TypeScript
against that file, so the file has to match the Python module exactly.

Boxes are in whatever space the caller uses; the vectors just keep the maths honest. Values are
plain numbers and lists, so the file is easy to read in both languages.

    uv run python scripts/make_edit_vectors.py          # rewrite the vectors file
    uv run python scripts/make_edit_vectors.py --check  # exit 1 when the file is out of date
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from pdfeditor.actions import edit_geometry as eg
from pdfeditor.model.geometry import Point, Rect
from pdfeditor.model.objects import ObjectType, PageObject

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "web" / "src" / "tools" / "vectors" / "edit-geometry.json"

BOXES = [
    Rect(0.0, 0.0, 100.0, 50.0),  # ordinary
    Rect(10.0, 20.0, 30.0, 60.0),  # small
    Rect(-20.0, -10.0, 40.0, 30.0),  # across the origin
    Rect(100.0, 200.0, 101.0, 201.0),  # one point square
    Rect(5.0, 5.0, 5.0, 5.0),  # zero size
    Rect(7.0, 1.0, 7.0, 40.0),  # zero width
    Rect(0.0, 0.0, 0.5, 0.5),  # below the minimum size
    Rect(0.0, 0.0, 1e-6, 1e-6),  # effectively a point
]


def _pt(p: Point) -> list[float]:
    return [p.x, p.y]


def _rect(r: Rect) -> list[float]:
    return [r.x0, r.y0, r.x1, r.y1]


def _probe_points(box: Rect) -> list[Point]:
    """Handles, edges, the centre, a point just outside, and one far away."""
    eps = 0.001
    mx, my = (box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2
    points = list(eg.handle_points(box))
    points += [
        Point(mx, box.y0),
        Point(box.x0, my),
        Point(mx, my),
        Point(box.x0 - eps, my),
        Point(box.x1 + eps, box.y1 + eps),
        Point(box.x0 + 3.0, box.y0 + 4.0),
        Point(1000.0, -1000.0),
    ]
    return points


def _fit_cases() -> list[dict[str, Any]]:
    pairs = [
        (BOXES[0], BOXES[0]),
        (BOXES[0], Rect(10.0, 10.0, 210.0, 60.0)),
        (BOXES[1], Rect(0.0, 0.0, 60.0, 40.0)),
        (BOXES[5], Rect(0.0, 0.0, 9.0, 80.0)),  # zero-width old keeps its x scale at 1
        (BOXES[4], Rect(1.0, 2.0, 3.0, 4.0)),
    ]
    return [
        {"old": _rect(old), "new": _rect(new), "expected": list(eg.fit_matrix(old, new).as_tuple())}
        for old, new in pairs
    ]


def _handle_cases() -> list[dict[str, Any]]:
    return [
        {"box": _rect(box), "expected": [_pt(p) for p in eg.handle_points(box)]} for box in BOXES
    ]


def _handle_at_cases() -> list[dict[str, Any]]:
    cases = []
    for box in BOXES:
        for point in _probe_points(box):
            for tol in (0.0, 2.0, 6.0):
                index = eg.handle_at(box, point, tol)
                cases.append(
                    {"box": _rect(box), "point": _pt(point), "tol": tol, "expected": index}
                )
    return cases


def _resize_cases() -> list[dict[str, Any]]:
    cases = []
    for box in BOXES:
        for handle in range(8):
            far = Point(box.x1 + 50.0, box.y1 + 50.0)
            for point in [*_probe_points(box)[:8], far]:
                out = eg.resize_box(box, handle, point)
                cases.append(
                    {
                        "box": _rect(box),
                        "handle": handle,
                        "point": _pt(point),
                        "expected": _rect(out),
                    }
                )
    return cases


def _click_cases() -> list[dict[str, Any]]:
    origin = Point(10.0, 10.0)
    offsets = [(0.0, 0.0), (2.9, 0.0), (3.0, 0.0), (3.0, 3.0), (3.1, 0.0), (0.0, -3.5)]
    return [
        {
            "a": _pt(origin),
            "b": _pt(Point(origin.x + dx, origin.y + dy)),
            "expected": eg.is_click(origin, Point(origin.x + dx, origin.y + dy)),
        }
        for dx, dy in offsets
    ]


def _objects() -> list[PageObject]:
    """Nested, overlapping and degenerate objects, so ties and the smallest-wins rule show."""
    boxes = {
        "big": Rect(0.0, 0.0, 200.0, 200.0),
        "image": Rect(50.0, 50.0, 80.0, 70.0),
        "twin": Rect(50.0, 50.0, 80.0, 70.0),  # same area as "image": the first one wins
        "line": Rect(0.0, 100.0, 200.0, 100.0),  # zero height
        "spot": Rect(120.0, 120.0, 120.0, 120.0),  # zero size
    }
    kinds = [ObjectType.TEXT, ObjectType.IMAGE, ObjectType.IMAGE, ObjectType.PATH, ObjectType.PATH]
    return [
        PageObject(kind, key, box) for kind, (key, box) in zip(kinds, boxes.items(), strict=True)
    ]


def _object_at_cases(objects: list[PageObject]) -> list[dict[str, Any]]:
    points = [Point(60.0, 60.0), Point(10.0, 10.0), Point(120.0, 120.0), Point(0.0, 100.0)]
    points += [Point(-1.5, 60.0), Point(-2.5, 60.0), Point(300.0, 300.0), Point(120.0, 121.5)]
    cases = []
    for point in points:
        for tol in (0.0, 2.0):
            hit = eg.object_at(objects, point, tol)
            cases.append(
                {
                    "point": _pt(point),
                    "tol": tol,
                    "expected": None if hit is None else hit.key,
                }
            )
    return cases


def _objects_in_cases(objects: list[PageObject]) -> list[dict[str, Any]]:
    bands = [
        Rect(40.0, 40.0, 60.0, 60.0),
        Rect(-10.0, -10.0, 1.0, 1.0),
        Rect(0.0, 90.0, 300.0, 110.0),
        Rect(118.0, 118.0, 122.0, 122.0),
    ]
    return [
        {
            "box": _rect(band),
            "expected": [o.key for o in eg.objects_in(objects, band)],
        }
        for band in bands
    ]


def _reselect_cases(objects: list[PageObject]) -> list[dict[str, Any]]:
    moved = [
        [Rect(55.0, 55.0, 85.0, 75.0)],
        [Rect(-5.0, -5.0, 0.0, 0.0), Rect(120.0, 120.0, 121.0, 121.0)],
        [],
    ]
    return [
        {
            "boxes": [_rect(b) for b in boxes],
            "expected": eg.reselect(objects, boxes),
        }
        for boxes in moved
    ]


def build() -> dict[str, Any]:
    objects = _objects()
    return {
        "_about": (
            "Generated by scripts/make_edit_vectors.py from pdfeditor.actions.edit_geometry. "
            "Do not edit by hand."
        ),
        "constants": {
            "HANDLE_PX": eg.HANDLE_PX,
            "OBJECT_TOL_PX": eg.OBJECT_TOL_PX,
            "MIN_DRAG": eg.MIN_DRAG,
            "MIN_SIZE": eg.MIN_SIZE,
        },
        "objects": [{"key": o.key, "bbox": _rect(o.bbox)} for o in objects],
        "fit_matrix": _fit_cases(),
        "handle_points": _handle_cases(),
        "handle_at": _handle_at_cases(),
        "resize_box": _resize_cases(),
        "is_click": _click_cases(),
        "object_at": _object_at_cases(objects),
        "objects_in": _objects_in_cases(objects),
        "reselect": _reselect_cases(objects),
    }


def render() -> str:
    return json.dumps(build(), indent=2, sort_keys=True) + "\n"


def main(argv: list[str]) -> int:
    text = render()
    if "--check" in argv:
        current = OUTPUT.read_text(encoding="utf-8") if OUTPUT.exists() else ""
        if current != text:
            print(f"{OUTPUT} is out of date: run scripts/make_edit_vectors.py", file=sys.stderr)
            return 1
        print("edit geometry vectors are up to date")
        return 0
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(text, encoding="utf-8", newline="\n")
    print(f"wrote {OUTPUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
