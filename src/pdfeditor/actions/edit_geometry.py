"""Selection and resize geometry for the Edit tool (W6.7a S2), shared by the desktop and the web.

The desktop's ``ui/tools/edit.py`` and ``ui/view/document_view.py`` and the browser's edit layer
must make the same choices: which object a click picks, where the eight handles sit, how a drag
of a handle reshapes a box, and which objects a rubber band or an edit reselects. This module
holds those maths on plain model types, with no Qt, so both sides call it and
``scripts/make_edit_vectors.py`` can turn its answers into shared test vectors.

Boxes are axis-aligned ``Rect`` values. Callers pick the space: the desktop resizes in scene
pixels (so ``MIN_SIZE`` and the handle tolerance are in that space) and hit-tests in page points.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence

from pdfeditor.model.annotations import AnnotationModel, AnnotationType
from pdfeditor.model.geometry import Matrix, Point, Rect
from pdfeditor.model.objects import PageObject

# Screen pixels a handle grabs; callers divide by the zoom to get a tolerance in their space.
HANDLE_PX = 6.0
# Screen pixels an object is grabbed by beyond its outline.
OBJECT_TOL_PX = 2.0
# A drag this short on both axes is a click, not a move or a rubber band.
MIN_DRAG = 3.0
# The smallest side a resize may leave, in the box's own units (4 scene pixels on the desktop).
MIN_SIZE = 4.0

# Comments the Select tool cannot resize or move (the desktop's select tool and the web agree on
# these). Icons keep a fixed size; text markup follows the text it marks.
NOT_RESIZABLE = frozenset({AnnotationType.TEXT, AnnotationType.FILE_ATTACHMENT})
NOT_MOVABLE = frozenset(
    {
        AnnotationType.HIGHLIGHT,
        AnnotationType.UNDERLINE,
        AnnotationType.STRIKEOUT,
        AnnotationType.SQUIGGLY,
    }
)

# Where each handle sits, as (column, row) with 0 = low edge, 1 = middle, 2 = high edge. The
# order is the handle index used everywhere: left to right along the top, then the middle row,
# then the bottom row.
_HANDLE_CELLS = ((0, 0), (1, 0), (2, 0), (0, 1), (2, 1), (0, 2), (1, 2), (2, 2))


def fit_matrix(old: Rect, new: Rect) -> Matrix:
    """The matrix that maps ``old`` onto ``new`` by scaling about ``old``'s origin.

    A zero-width or zero-height ``old`` keeps its scale at 1 on that axis, so the result stays
    finite and the object is moved but not stretched along the degenerate axis.
    """
    sx = new.width / old.width if old.width else 1.0
    sy = new.height / old.height if old.height else 1.0
    return (
        Matrix.translate(-old.x0, -old.y0) @ Matrix.scale(sx, sy) @ Matrix.translate(new.x0, new.y0)
    )


def handle_points(box: Rect) -> list[Point]:
    """The eight handle positions on ``box``, in handle-index order."""
    xs = (box.x0, (box.x0 + box.x1) / 2, box.x1)
    ys = (box.y0, (box.y0 + box.y1) / 2, box.y1)
    return [Point(xs[col], ys[row]) for col, row in _HANDLE_CELLS]


def handle_at(box: Rect, point: Point, tol: float) -> int | None:
    """The index of the first handle within ``tol`` of ``point`` on both axes, if any."""
    for index, handle in enumerate(handle_points(box)):
        if abs(handle.x - point.x) <= tol and abs(handle.y - point.y) <= tol:
            return index
    return None


def resize_box(box: Rect, handle: int, point: Point, min_size: float = MIN_SIZE) -> Rect:
    """``box`` with the edges that ``handle`` controls moved to ``point``.

    The edges stop ``min_size`` short of the opposite edge, so a drag past it pins the box at
    that size instead of inverting it.
    """
    col, row = _HANDLE_CELLS[handle]
    left, top, right, bottom = box.x0, box.y0, box.x1, box.y1
    if col == 0:
        left = min(point.x, right - min_size)
    elif col == 2:
        right = max(point.x, left + min_size)
    if row == 0:
        top = min(point.y, bottom - min_size)
    elif row == 2:
        bottom = max(point.y, top + min_size)
    return Rect(left, top, right, bottom)


def is_click(a: Point, b: Point, min_drag: float = MIN_DRAG) -> bool:
    """Whether a press at ``a`` released at ``b`` stays within ``min_drag`` on both axes."""
    return abs(b.x - a.x) <= min_drag and abs(b.y - a.y) <= min_drag


def object_at(objects: Iterable[PageObject], point: Point, tol: float) -> PageObject | None:
    """The smallest object whose outline, grown by ``tol``, contains ``point``.

    The smallest wins, so an image sitting inside a large text block is the one picked. Ties
    keep the first object in ``objects``.
    """
    under = [o for o in objects if o.bbox.inflated(tol).contains(point)]
    return min(under, key=lambda o: o.bbox.width * o.bbox.height, default=None)


def objects_in(objects: Iterable[PageObject], box: Rect) -> list[PageObject]:
    """The objects whose outline meets ``box`` (a rubber band selects by intersection)."""
    return [o for o in objects if o.bbox.intersects(box)]


def annotation_bounds(a: AnnotationModel) -> Rect:
    """Tight bounds of an annotation's geometry (its /Rect can include line-ending margins)."""
    points: list[Point] = []
    if a.type.is_markup:
        points = [p for q in a.quads for p in (q.ul, q.ur, q.ll, q.lr)]
    elif a.type is AnnotationType.INK:
        points = [p for stroke in a.ink for p in stroke]
    elif a.type in (AnnotationType.LINE, AnnotationType.POLYGON, AnnotationType.POLYLINE):
        points = list(a.vertices)
    if points:
        return Rect.from_points(points)
    return a.rect.normalized()


def is_movable(a: AnnotationModel) -> bool:
    """Whether the Select tool may move the comment: not locked, and not text markup."""
    return not a.locked and a.type not in NOT_MOVABLE


def is_resizable(a: AnnotationModel) -> bool:
    """Whether the Select tool may resize the comment: not locked, and not an icon."""
    return not a.locked and a.type not in NOT_RESIZABLE


def comment_at(boxes: Sequence[tuple[Rect, bool]], point: Point, tol: float) -> int | None:
    """The index of the topmost box that holds ``point``, grown by ``tol``.

    Each entry is a comment's bounds and whether it is hidden; hidden ones are never hit. The
    last entry is the topmost, so the search runs from the end, as the desktop's ``annotation_at``.
    """
    for index in range(len(boxes) - 1, -1, -1):
        box, hidden = boxes[index]
        if not hidden and box.inflated(tol).contains(point):
            return index
    return None


def reselect(objects: Sequence[PageObject], boxes: Sequence[Rect]) -> list[str]:
    """For each moved box, the key of the object whose corner is nearest to it.

    After an edit the object keys change, so the selection is rebuilt from where the objects
    went. Boxes with no candidate object are skipped. Keys can repeat if two boxes share one.
    """
    chosen: list[str] = []
    for box in boxes:
        best = min(
            objects,
            key=lambda o: abs(o.bbox.x0 - box.x0) + abs(o.bbox.y0 - box.y0),
            default=None,
        )
        if best is not None:
            chosen.append(best.key)
    return chosen
