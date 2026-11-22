# Fix: placement on pages that are rotated and cropped (issue #537)

Role: design Opus 5.5; implementation Haiku 5.5, review Sonnet 5.5 · Branch: `fix-rotated-crop-placement` · Follows [W6.7b](W6.7b-shapes.md) §2.3 and its Question 1 · Engine fix, shared by the desktop app and the web build.

## Summary

On a page with a /Rotate and a crop box whose lower-left corner is not at (0, 0), content written through the engine lands offset by that corner. The cause is one PyMuPDF matrix: `Page.transformation_matrix` drops the crop origin on rotated pages. Our engine uses that matrix directly in `pdf_matrix` and in the annotation writer, and PyMuPDF's drawing helpers (`Shape`, `insert_image`, `insert_htmlbox`, `show_pdf_page`, `draw_rect`) use it internally. A second, separate PyMuPDF bug in `Document.set_toc` puts bookmark destinations in the wrong place on every cropped page, rotated or not, and on uncropped /Rotate 270 pages.

Probing for this note found more than the issue lists. The most serious finding: **a multi-line redaction mark on such a page removes nothing**, so the text survives. The readers (text, search, links, annotations, outline) are correct. Only the writers and `pdf_matrix` are wrong.

The fix adds one small module, `engine/mupdf/space.py`, that takes the page transform from MuPDF itself (the transform rendering uses), with three helpers built on it. Every affected call site switches to one of them. On pages whose crop box starts at (0, 0) the helpers return exactly the matrices used today, so output there is byte-identical. The one exception is bookmarks on uncropped /Rotate 270 pages, which today are also wrong. About 110 changed lines, excluding tests.

"Crop box" below means the effective crop box: /CropBox if present, otherwise /MediaBox. A rotated page whose MediaBox is `[-50 -50 562 792]`, with no CropBox, is affected in the same way (probed: a shape at visible (100,100) lands at (150,150) at /Rotate 90).

## 1. Root cause

### 1.1 The coordinate spaces

| Space | Origin | Who uses it |
|---|---|---|
| Visible | top-left of the crop box, /Rotate applied | everything above the engine (AGENTS.md); `fz.rect`, rendering |
| PyMuPDF "unrotated" | top-left of the crop box, no rotation, y down | annotation constructors, `annot.rect`, raw `get_text`, `search_for` |
| PDF user space | bottom-left of the page coordinate system, y up | content streams, /Rect, /QuadPoints, /InkList, /L, /Vertices, /Dest |

visible → unrotated is `fz.derotation_matrix`, and unrotated → visible is `fz.rotation_matrix`. Both are **correct** on every page, cropped or not. We checked this by reading a known glyph back with `text_page()` and comparing it with pypdfium2's pixels in all 8 rotation × crop cases (section 1.3).

unrotated → PDF is `~fz.transformation_matrix`. That is where the bug is.

### 1.2 The PyMuPDF code (1.28.2, `pymupdf/__init__.py`)

```python
# Page.transformation_matrix, lines 13299-13315
mupdf.pdf_page_transform(page, mediabox, ctm)
val = JM_py_from_matrix(ctm)
if self.rotation % 360 == 0:
    val = Matrix(val)
else:
    val = Matrix(1, 0, 0, -1, 0, self.cropbox.height)   # <- crop origin dropped
```

At /Rotate 0 the value is MuPDF's real transform, for example `1 0 0 -1 -36 806` for CropBox `[36 50 559 806]`. At any other rotation it is `1 0 0 -1 0 756`: the y flip is right but the crop box's x0 and y0 are gone. The error is a pure translation by the crop origin, applied in unrotated space. It therefore shows up in visible space as (−50, −36) at /Rotate 90, (+36, −50) at 180 and (+50, +36) at 270 (CropBox lower-left (36, 50)).

`Document.set_toc` converts a bookmark's `"to"` point with its own formula (around line 7360):

```python
point.y = page.cropbox.height - point.y
point = point * page.rotation_matrix
```

This ignores the crop origin entirely, even at /Rotate 0, and applies the visible-space rotation to a point that is in neither space. At /Rotate 270 on an uncropped A4 page, visible (100, 200) is written as `/XYZ 642 512` where `/XYZ 412 742` is right. `get_toc` reads destinations correctly (a hand-written `/XYZ` at the right PDF point reads back as the visible point in all 8 cases).

### 1.3 Where our engine picks it up

The probes are pypdfium2 renders at scale 1 (pdfium applies /Rotate and the crop box, so pixel = visible point). The test page is 612 × 842, the target is a red 100 × 60 box at visible (100, 100), and the crop box is `[36 50 559 806]`.

| Path | Code | Rot 0, 90, 180, 270 uncropped; rot 0 cropped | Rot 90 / 180 / 270 cropped |
|---|---|---|---|
| `Page.add_shape` | `content.py:860-879`: `fz.derotation_matrix` → `Shape` | ✓ | (50,64) / (136,50) / (150,136) ✗ |
| `Page.add_text`, text edits and moves | `content.py:558`: `derotation_matrix` → `insert_htmlbox` | ✓ | (52,68) / (138,54) / (152,140) ✗ (glyph ink) |
| `Page.stamp_image` (image watermark, image stamp) | `pages.py:262`: `derotation_matrix` → `insert_image` | ✓ | same offsets as shapes ✗ |
| `fill_background` (page background) | `pages.py:293` → `draw_rect` | ✓ | covers 705 × 486 of 756 × 523 ✗ |
| OCR text layer (`add_text_layer`) | `ocr.py:116-118` → `show_pdf_page` | ✓ | same offsets as shapes ✗ (invisible text misaligned with the scan) |
| Square/circle comment, create and resize | `annots.py:142-148` `_write_box` → `_Geo.pdf` | ✓ | (51,65) at rot 90 ✗ (read back at that wrong place) |
| FreeText callout, create and update | `annots.py:151-170`, `:459` → `_Geo.pdf` | ✓ | ✗ (from code: same `_Geo.pdf`) |
| Line / polygon / polyline / markup / ink **update** | `annots.py:463-479` → `_Geo.pdf` | ✓ | ink moved to (48,62) at rot 90 ✗ |
| Multi-line redaction mark | `annots.py:397-402`: /QuadPoints via `_Geo.pdf` | ✓ | **text under the mark survives `apply_redactions`** ✗ |
| `Page.pdf_matrix` (contract) | `page.py:240-243`: `derotation_matrix * ~transformation_matrix` | ✓ | offset by the crop origin ✗ |
| `content_objects` for images, paths and forms | `content.py:133`, `:254-268` via `pdf_matrix` | ✓ | image listed at (382,300), drawn at (332,264) ✗ |
| Resize/rotate of non-text objects | `content.py:790-791`: `a⁻¹ · V · a` with `a = pdf_matrix` | ✓ | pure moves ✓ (a translation commutes); scale and rotate pivot about the wrong point ✗ |
| XFDF import/export | `services/xfdf.py:125`, `:248` via `pdf_matrix` | ✓ | ✗ (from code) |
| Auto-tagging (reading order) | `autotag.py:88` via `pdf_matrix` | ✓ | ✗ (from code: wrong block for a text show) |
| Bookmarks: `set_outline` | `document.py:436-445` → `set_toc` | ✓ except **rot 270 ✗** | **every cropped page ✗**, rot 0 included |
| Bookmarks: dangling-entry prune after a page delete | `pages.py:117-135` `get_toc` → `set_toc` | as above | as above: surviving entries drift |

These paths are correct today and must not change:

| Path | Why it is right |
|---|---|
| Annotation constructors (`add_rect_annot`, `add_ink_annot`, `add_highlight_annot`, `add_redact_annot`, …) via `_Geo.point/rect/quad` = `derotation_matrix` | MuPDF's annotation API converts unrotated → PDF with the page's real transform. Probed: `add_rect_annot` and ink create are right in all 8 cases |
| `annot.set_rect` (non-box rect types on update) | same MuPDF annotation API |
| `stamp_text` (`pages.py:219-254`, `insert_text` with `morph`) | probed right in all 8 cases |
| `_remove_text` (`content.py:295`): `add_redact_annot` + `apply_redactions` | constructor; single-rect redactions are right |
| `set_crop` (`pages.py:204-215`) | adds the crop offset itself and writes through `set_cropbox` (top-left, MediaBox-relative) |
| All readers (`text_page`, `search`, `links`, `annotations`, `outline`) | MuPDF's native extraction plus `rotation_matrix`; probed against pdfium |

Two consequences explain why this survived:
- The writer and the lister share the wrong matrix. Today a shape is drawn in the wrong place, and `content_objects` lists it at the requested place. Annotations are the opposite: the reader is right, so a square comment reads back where it was drawn, not where it was asked for.
- Every existing rotation test uses `rotated_pages`, whose rotated pages have no crop box. Its cropped landscape page is not rotated.

## 2. The fix: one conversion point

### 2.1 `engine/mupdf/space.py` (new, about 45 lines)

```python
def visible_to_pdf(fz: pymupdf.Page) -> pymupdf.Matrix:
    """Visible space -> PDF user space, from MuPDF's own page transform (the one rendering
    uses). PyMuPDF's transformation_matrix drops the crop origin on rotated pages."""
    ctm = mupdf.FzMatrix()
    mupdf.pdf_page_transform(
        mupdf.pdf_page_from_fz_page(fz.this), mupdf.FzRect(mupdf.FzRect.Fixed_UNIT), ctm
    )
    return ~pymupdf.Matrix(ctm.a, ctm.b, ctm.c, ctm.d, ctm.e, ctm.f)


def helper_space(fz: pymupdf.Page) -> pymupdf.Matrix:
    """Visible space -> the 'unrotated' coordinates PyMuPDF's drawing helpers expect.

    Shape, insert_image, insert_htmlbox, show_pdf_page and draw_rect convert their input with
    ~transformation_matrix; composing with it here cancels that matrix's error. Wherever the
    matrix is right this is exactly derotation_matrix, so those pages are unchanged."""
    return visible_to_pdf(fz) * fz.transformation_matrix


def toc_point(fz: pymupdf.Page, p: pymupdf.Point) -> pymupdf.Point:
    """A visible point, encoded so that Document.set_toc writes the right /XYZ for it."""
    q = p * visible_to_pdf(fz) * fz.derotation_matrix
    return pymupdf.Point(q.x, fz.cropbox.height - q.y)
```

`mupdf.pdf_page_transform` is the call PyMuPDF itself makes on the line before it throws the result away. It handles a MediaBox off the origin, a CropBox, both, /UserUnit and all four rotations, and it checks nothing the reader doesn't already rely on. It is the low-level `pymupdf.mupdf` module, so the PyMuPDF import rule is unchanged (`engine/mupdf/` only), and the Pyodide wheel ships the same module. Probed: `visible_to_pdf` equals "derotate, then the /Rotate-0 matrix" in all 12 cases (3 box layouts × 4 rotations), and boxes written with it render at (100, 100) in pdfium in every case. `toc_point` read back as (100, 200) in all 8 rotation × crop cases.

Why `helper_space` composes with PyMuPDF's own matrix instead of hard-coding the offset: if a later PyMuPDF fixes `transformation_matrix`, the product turns back into `derotation_matrix` by itself, and the contract tests (section 4) catch any other change.

### 2.2 Call sites (each a one- or two-line change)

| File | Change |
|---|---|
| `engine/mupdf/page.py:240-243` `pdf_matrix` | `m = space.visible_to_pdf(fz)`. This fixes `content_objects`, `transform_objects`, XFDF and autotag together |
| `engine/mupdf/annots.py:92-94` `_Geo` | `vis_to_pdf = space.visible_to_pdf(page)`; `vis_to_unrot` stays `derotation_matrix` (constructors are right) |
| `engine/mupdf/content.py:558` `insert_text` | `* space.helper_space(fz)` instead of `* fz.derotation_matrix` |
| `engine/mupdf/content.py:863` `add_shape` | `m = space.helper_space(fz)` |
| `engine/mupdf/pages.py:262` `stamp_image` | `* space.helper_space(fz)` |
| `engine/mupdf/pages.py:293` `fill_background` | `(fz.rect * space.helper_space(fz)).normalize()` |
| `engine/mupdf/ocr.py:116` `add_text_layer` | `(fz.rect * space.helper_space(fz)).normalize()` |
| `engine/mupdf/document.py:438-439` `set_outline` | `info["to"] = space.toc_point(self.page(i).fz, …)` for the target page |
| `engine/mupdf/pages.py:117-135` `_prune_dangling_outline` | re-encode each kept GOTO entry's `"to"` (visible, from `get_toc`) with `toc_point` for its target page before `set_toc` |
| `engine/mupdf/content.py:295`, `pages.py:207`, `pages.py:221`, `annots.py:93` | **no change** (constructors, `set_crop`, `insert_text` morph): a comment at each says why it keeps `derotation_matrix` |

The module docstring of `annots.py` and the comment at `page.py:77-79` gain one sentence each pointing to `space.py`.

### 2.3 Rotated-only and unrotated pages

When the crop box's lower-left corner is (0, 0), or the page is not rotated, `transformation_matrix` is already right. Then `visible_to_pdf == derotation_matrix * ~transformation_matrix` and `helper_space == derotation_matrix`, exactly up to float rounding of 0/±1 entries. All the existing rotation guards (`test_round_trip_filled_shape_on_rotated_page`, `test_coordinates_match_rendering_on_rotated_pages`, `test_pdf_matrix_maps_to_pdf_space`, the annotation, stamp and content-edit tests on `rotated_pages`) keep their expected values. A new identity test pins this (section 4.4). It also makes the page-content bytes for those pages identical before and after the fix.

The one difference on pages whose crop box starts at (0, 0): bookmarks to /Rotate 270 pages. `set_toc` mis-encodes them today, and they become right.

## 3. Desktop impact and existing files

The desktop app uses this engine, so it gets the same fix, through the same actions: Add Text and text edits, shapes, image watermarks and stamps, background, OCR, square, circle and callout comments, moving or resizing line, polygon, ink and markup comments, multi-line redaction, the Edit tool's object boxes and resize, XFDF, Make Accessible, and bookmarks.

- **Opening and saving change nothing.** No path rewrites existing content. A file changes only where the user edits it, as before.
- **Pages whose crop box starts at (0, 0) (most PDFs), and unrotated cropped pages:** identical output for every write path, except bookmarks (below).
- **Bookmarks:** `set_outline` rewrites the whole outline on every bookmark edit, and the page-delete prune rewrites it too. Today each rewrite moves every destination on a cropped page (any rotation) and on a /Rotate 270 page, so editing one bookmark silently moves the others. After the fix, a rewrite keeps them. This is a visible change, and it is the fix. Destinations already moved by earlier versions stay where they are, because they can't be told apart from intended ones.
- **Rotated and cropped pages:** new edits land where the user put them. Content placed there by earlier versions keeps its old (offset) position, with no migration (Question 4). An XFDF exported by an earlier version from such a page has offset coordinates. Importing it now puts the comments where that export said, which is offset by the same amount.
- **Redaction:** after the fix, multi-line marks on such pages remove the text. This is a security fix and should be called out in the release notes (Question 1).
- **Signatures:** unchanged. Any edit invalidates them as before, and saving stays incremental.
- No UI, settings, i18n or user-guide change. It is a bug fix, not a feature, so no `docs/guide/` page changes. The release notes get one line.

## 4. Tests

The fixtures, pixel checks and host checks follow AGENTS.md: edit → save → reopen → assert; the saved file opens in pikepdf and renders in pypdfium2. Checks go through `tests.hostcheck.record`, so the Pyodide run executes the tests and the host verifies them. Nothing is added to the skip budget.

### 4.1 Fixture (`scripts/make_fixtures.py`, about 35 lines)

`rotated_cropped`: 612 × 842 pages, each with a blue "Anchor" text run and a small red-free image drawn at known PDF points inside the crop box.
- pages 0–3: CropBox `[36 50 559 806]`, /Rotate 0, 90, 180, 270;
- pages 4–7: MediaBox `[-50 -50 562 792]`, no CropBox, /Rotate 0, 90, 180, 270;
- page 8: CropBox at (0, 0) (`[0 0 559 806]`), /Rotate 270, as the bookmark regression page.

`off_page_text` page 1 stays the issue's reproduction.

### 4.2 New host checks (`tests/hostcheck.py`)

- `red_bbox_pdfium(page, expected, tol=2)`: the bounding box of red pixels in a scale-1 render equals `expected` (visible points) within `tol`.
- `outline_dest_pikepdf(index, page, left, top, tol=0.5)`: the n-th outline item's `/Dest` or `/A /D` is `[page /XYZ left top …]`.
- These reuse the existing `text_lacks_pdfium`, `text_contains_pdfium` and `opens_pikepdf`.

### 4.3 Round trips on rotated and cropped pages (parametrized over `rotated_cropped` pages 0–7)

`tests/actions/test_content.py`:
- `test_shape_on_rotated_cropped_page`: **remove the `xfail`**; it must pass unchanged.
- `test_round_trip_shape_rotated_cropped[page]`: filled red box at visible (100,100,200,160) → `red_bbox_pdfium` (100,100,200,160); reopen, and `content_objects` lists one new `PATH` with that bbox ±2 (the writer and the lister agree *and* match the pixels).
- `test_round_trip_add_text_rotated_cropped[page]`: red "Hello" 20 pt in (100,100,300,160) → `text_contains_pdfium`, and the red ink bbox inside the box; reopen, and the `text_page` span bbox lies inside the box.
- `test_round_trip_resize_image_rotated_cropped`: scale the anchor image ×2 about its top-left → pdfium bbox matches.

`tests/actions/test_pages.py` (or the stamping tests):
- `test_round_trip_image_stamp_rotated_cropped[page]`: red PNG stamped at (100,100,200,160) with `keep_proportion=False` → `red_bbox_pdfium`, pikepdf opens.
- `test_text_stamp_rotated_cropped[page]`: a guard for the path that is already right.
- `test_background_covers_rotated_cropped_page[page]`: red background → `red_bbox_pdfium` equals `(0,0,w,h)`.

`tests/engine/test_annotations_write.py`:
- square and circle create and move; ink, line and polygon update; highlight update; a callout, all on pages 0–7: read back `rect` equals the requested one ±1, and `red_bbox_pdfium` agrees.
- **Leak test** (`tests/engine/test_redaction.py`): a two-line redaction mark over "SECRETONE"/"SECRETTWO" on each of pages 0–7, apply, save → `text_lacks_pdfium` for both words, and the text outside the mark is still there.

`tests/engine/test_outline.py` (or the existing outline tests):
- `set_outline` with dest visible (100, 200) on pages 0–8 → `outline_dest_pikepdf` equals `visible_to_pdf`'s point (computed from the boxes in the test, not with the engine). Reopen, and `outline()` gives (100, 200) ±0.5.
- Drift guard: on a file whose destinations are correct, `set_outline(outline())` leaves every raw `/XYZ` unchanged. The same holds after deleting a page that a bookmark points to (the prune path).

`tests/engine/test_ocr*.py`: a synthetic one-page text layer (`ocr.text_layer_pdf` with a fixed word box) added to page 1 → `search("word")` returns the box ±1.

### 4.4 Guards for pages that must not change

- `tests/engine/mupdf/test_space.py` (backend-specific, PyMuPDF allowed): for every page of `rotated_pages`, `mixed_content` and `text_multipage`, `helper_space(fz)` equals `fz.derotation_matrix` and `visible_to_pdf(fz)` equals `fz.derotation_matrix * ~fz.transformation_matrix` (abs 1e-9). On `rotated_cropped` pages 0–7, `visible_to_pdf` maps the visible corners onto the crop box corners.
- `test_pdf_matrix_maps_to_pdf_space` gains the `rotated_cropped` pages: corners → CropBox corners. That is the contract statement, so a future backend inherits it.
- All existing rotation tests stay as they are.

## 5. Files and size

| File | Lines (approx.) |
|---|---|
| `src/pdfeditor/engine/mupdf/space.py` (new) | 45 |
| `engine/mupdf/page.py`, `annots.py`, `content.py`, `pages.py`, `ocr.py`, `document.py` | 35 (call sites, the prune re-encode, comments) |
| `scripts/make_fixtures.py` | 35 |
| `docs/web/design/W6.7b-shapes.md` §2.3 (a "fixed by" line), release notes | 5 |
| **Total excluding tests** | **about 120** (budget 400) |
| Tests and host checks | about 300 |

`PLAN.md`: no item exists for this bug, so nothing is ticked. The PR closes #537.

## 6. Risks

- **Mixing up the two matrices.** `helper_space` is only for PyMuPDF drawing helpers, and `derotation_matrix` is only for annotation constructors and `insert_text`. Swapping them breaks pages that work today. Mitigation: a comment at every call site, and the 8-page matrix covers every write path, so a swap fails a test.
- **`set_toc` encoding depends on PyMuPDF's private formula.** If PyMuPDF changes it, `toc_point` is wrong. The raw-`/XYZ` pikepdf test fails on the upgrade. The fallback is to write the `/Dest` arrays ourselves after `set_toc` (about 20 lines, Question 3).
- **Low-level API on the web.** `pymupdf.mupdf.pdf_page_transform` and `pdf_page_from_fz_page` must exist in the Pyodide wheel. They are part of the SWIG module that PyMuPDF itself is built on, and the web-pytest run executes `test_space.py` and every round trip above, so a gap fails CI.
- **Pages with /UserUnit or non-multiple-of-90 /Rotate.** MuPDF's transform already handles /UserUnit, and the engine refuses other rotations on write (`set_rotation`). The readers use the same transform, so any odd case stays consistent with rendering.
- **Old offset content stays offset.** That is intended (Question 4), but a user may notice that a fresh edit and an old one no longer line up on such pages.
- **Performance.** One matrix computation per write call, which is negligible. No cache.

## Questions for the maintainer

1. **One PR, or the redaction leak first?** Recommended: one PR. The leak fix is the same one-line `_Geo` change, and the leak test belongs with the others. Label it as a security fix and give it its own release-note line.
2. **Page transform source: `pymupdf.mupdf.pdf_page_transform`, or derive it from the boxes in Python?** Recommended: MuPDF's own transform. It is the matrix rendering uses, it handles every box layout and /UserUnit, and it is 4 lines. A Python derivation duplicates MuPDF's box rules (inheritance, intersection with the MediaBox, normalization).
3. **Bookmarks: pre-encode the point for `set_toc` (`toc_point`), or write `/Dest` ourselves after `set_toc`?** Recommended: `toc_point` now (3 lines, probed in all cases), guarded by the raw-`/XYZ` test. Switch to writing `/Dest` only if a PyMuPDF upgrade breaks it.
4. **Repair content that earlier versions placed with the offset?** Recommended: no. It can't be told apart from content the author meant to put there, and rewriting it would break "open and save changes nothing".
5. **Report the two PyMuPDF bugs upstream?** Recommended: yes, one issue each (`transformation_matrix` on rotated pages with a crop origin, and `set_toc`'s `"to"` encoding), each with the 8-case repro from this note. Keep our fix either way: `helper_space` turns into a no-op by itself if `transformation_matrix` is fixed.
6. **Include the /Rotate 270 bookmark fix, the only change on pages whose crop box starts at (0, 0)?** Recommended: yes. Today every bookmark edit moves such destinations, and the fix is the same helper.
