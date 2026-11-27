# Status bar: thinner, with the page navigation bar folded in (issue #808)

**Status: proposed, for owner approval; no production code in this change.**

Issue #808 ("Statusbar is way too bigger than needed"), the owner's words: "The status bar is too thick
and useless. The buttons at the left side are unclear what their purpose is. The right side is ok, but
is duplicated by the popup bar over the bottom of the page. My idea is to make the status bar thinner,
remove the current buttons and fields, and incorporate the popup bar into the status bar."

The issue has one screenshot (declared 2560 by 116 px). I could not view it. This note works from the
text and the code on `origin/main` (`a68e365`). No browser was run; every size below is computed from
the CSS, not measured.

## 1. Verified status on `origin/main` (`a68e365`)

### 1.1 The web status bar

The bar is the `<footer>` of the app frame, filled by `DocumentStatusBar` only while a document shows.

| Part | Evidence |
| --- | --- |
| Frame slot | `web/app/src/layout/AppFrame.tsx:170-178`: `<footer className="app-frame-status" data-region="status" aria-label={t('layout.statusBar')}>`, the third grid row (`layout.css:6-16`, `grid-template-rows: auto minmax(0, 1fr) auto`). |
| Frame style | `web/app/src/layout/layout.css:246-253`: `padding: var(--space-1) var(--space-3)` (4 px / 12 px), 1 px top border, 12 px text. |
| Filled by | `web/app/src/App.tsx:962-973`: `DocumentStatusBar` with `zoom`, `layout`, `canBack`, `canForward`, `onBack`, `onForward`, `onFocusPageField`; `undefined` on the start page, so the footer is not rendered there. |
| Left: **Back** | `web/app/src/view/DocumentStatusBar.tsx:41-43`: a text button `t('view.back')` "Back" (`en.ts:1048`), disabled with no history. |
| Left: **Forward** | `DocumentStatusBar.tsx:44-46`: a text button `t('view.forward')` "Forward" (`en.ts:1049`). |
| Right: zoom text | `DocumentStatusBar.tsx:49-51`: `.doc-status-zoom`, the zoom as `{percent}%` (read-only). |
| Right: layout text | `DocumentStatusBar.tsx:52-60`: `.doc-status-mode`, "Single column", "Single page" or "Two pages" (`en.ts:1052-1054`, read-only). |
| Bar style | `web/app/src/view/documentView.css:119-129`: `.doc-status` `min-height: 32px`, `padding: var(--space-1) var(--space-3)`, `flex-wrap: wrap`. Coarse pointer: Back and Forward 44 px (`:151-156`). |
| Height (computed) | There is no global `box-sizing: border-box`, so: footer padding 4 + 4, border 1, `.doc-status` padding 4 + 4 around a 32 px min-height = **49 CSS px** at a fine pointer; **61 px** under a coarse pointer (44 px buttons). Not measured. |

So the bar is 49 px tall to hold two text buttons and two read-only labels.

**The unclear left-side buttons** are Back and Forward. They step the view-history (the pages you
jumped from: a link, a thumbnail, a bookmark, a search hit; `docs/guide/web.md:332-335`), not the
previous and next page. Their words look like browser Back and Forward, and nothing on the bar says
what they go back to. Both are duplicated elsewhere:

- the ribbon's Home tab, Navigate group: `web/app/src/commands/catalog.ts:174-175` (`back`, `forward`
  in `home.navigate`), with the disabled reason `disabled.cannotGoBack` (`en.ts:111`);
- Alt+Left and Alt+Right, run by the registry commands, not by the bar
  (`DocumentStatusBar.test.tsx:73-84`; comment at `DocumentStatusBar.tsx:1-3`).

**The right-side fields** duplicate the pill: the zoom text repeats the pill's zoom box
(`CanvasPill.tsx:221-237`), and the layout text repeats the pressed state of the ribbon's View >
Display toggles (`catalog.ts:376-388`).

### 1.2 The floating page navigation bar (the canvas pill)

| Part | Evidence |
| --- | --- |
| Component | `web/app/src/view/CanvasPill.tsx:160-302`, `role="toolbar"`, `aria-label={t('pill.label')}` "Page and zoom controls" (`en.ts:1073`). |
| Navigator | Previous page (`:178-186`), `PageJumpField` (`:187-193`; input `t('view.goToPage')` and `/ N`, `PageJumpField.tsx:38-58`), Next page (`:194-202`). |
| Zoom group | Zoom out (`:205-213`), zoom box with hint and presets list (`:214-271`), Zoom in (`:272-280`), Fit width and Fit page, `aria-pressed` (`:282-299`). All buttons are icons with `aria-label` and `title`. |
| Where | Rendered by `DocumentView.tsx:1904-1917`, absolutely positioned at the bottom centre of `.doc-view` (`canvasPill.css:16-37`, `bottom: 16px`). |
| Size | 32 px tall, 24 px controls, one row (`canvasPill.css:28-29`, `:72-81`), from PR #799 (#796). 44 px controls under a coarse pointer, and it wraps (`:172-183`). |
| Fade | Fades after `FADE_AFTER_MS = 3000` (`CanvasPill.tsx:13-14`, `:78-130`); the only CSS transition in the web app (`canvasPill.css:36`). |
| Narrow | Hidden when the page area is narrower than the pill (`CanvasPill.tsx:69-70`, `:112-115`). |
| Clearance | `--pill-clearance: 64px`, a spacer after the last page (`canvasPill.css:5-14`). |
| Popups | Presets list opens upward (`bottom: 100%`, `canvasPill.css:142-155`); the zoom error (`:164-170`) and the page error (`.canvas-pill-error`, `PageJumpField.tsx:55-57`) open **downward** (`top: 100%`). |
| Page field focus | `pageFieldRef` is owned by the view (`DocumentView.tsx:481-482`), reached by the view handle `focusPageField` (`:1358-1360`), called by the Go to Page command (`App.tsx:782`) and by the bar's handle (`App.tsx:971`). |

### 1.3 What the host already knows

`App` already holds everything the folded-in controls need, so the bar can be rendered by `App`
without new plumbing from the view:

- `viewState` (`App.tsx:591-600`): `page`, `zoom`, `layout`, `labels`, `pageCount`, `fit`, reported by
  the view;
- the view handle (`DocumentView.tsx:194-223`): `scrollToPage(index)`, `zoom(request | {step})`,
  `stepPage(direction)`.

### 1.4 The desktop

| Part | Evidence |
| --- | --- |
| Status bar | A `QStatusBar` (`src/pdfeditor/ui/main_window.py:323-350`): at the left the active tool's name and a Stop button (`tool_label`, `tool_exit`, `:327-336`), hidden unless a tool is on; at the right the job progress chip (`:340-343`). Style: `qss.py:160-161`. It shows no page, zoom, Back or Forward. |
| Back and Forward | Menu or ribbon actions only (`main_window.py:568`, Alt+Left), not on the status bar. |
| Page navigation | The floating pill, `src/pdfeditor/ui/view/pill.py` (one per window, fades after 3 s, 16 px above the bottom). |

So the web's Back and Forward on the status bar have no desktop counterpart, and the desktop does not
put page or zoom controls in its status bar. Folding the pill into the bar is the owner's new choice
for the web; it departs from the desktop (question Q6).

### 1.5 Where the web bar's job and messages are

Job progress is `JobProgressHost` (`App.tsx:1482`, `feedback/JobProgressHost.tsx`), not on the bar.
Messages are toasts (`ToastRegion`, fixed at the bottom right, `feedback/feedback.css:4-14`). The web
bar has no message area today.

## 2. Design

### 2.1 What the bar holds

One row, full width, under the document. Left to right:

| Area | Content | From |
| --- | --- | --- |
| Start | Previous page, page field with `/ N`, Next page | the pill's navigator, unchanged |
| End | Zoom out, zoom box with presets, Zoom in, a 1 px separator, Fit width, Fit page | the pill's zoom group, unchanged |

The page navigator goes where Back and Forward were; the zoom group goes where the zoom and layout
text were, which the owner called "ok". The middle stays empty (no message area, Q4).

**Removed**: Back and Forward (the ribbon and Alt+Left/Right keep them), the read-only zoom text (the
zoom box shows it), the read-only layout text (the ribbon's View toggles show it).

**The floating pill goes**: it is no longer rendered over the page, so nothing covers the page's
bottom, the 3 s fade and its timer go, the narrow-width hiding goes, and the 64 px clearance spacer
goes. The controls keep their names, icons, tooltips, `aria-pressed` and keyboard behaviour.

### 2.2 Size targets (measurable)

| Context | Target |
| --- | --- |
| Fine pointer, 1366 by 768 | Footer box **29 px tall (± 1)**: 24 px controls, 2 px padding top and bottom, 1 px top border. One row; every control at least 24 by 24 px; all controls on the same row (tops within 1 px). Down from 49 px. |
| Coarse pointer, 1366 by 768 | Every control at least 44 by 44 px; one row; footer at most 50 px. |
| Coarse pointer, 390 by 844 | The two groups wrap to two rows (navigator above, zoom below), every control still 44 px; no horizontal page scroll; footer at most 100 px (Q5). |
| Fine pointer, 390 by 844 | One row if it fits, else two; no horizontal page scroll. |

The page area gains about 20 px of height from the thinner bar, and the bottom 48 px it lost to the
pill.

### 2.3 Styling

- The bar uses the pill's control styles (bare icon buttons, a transparent 1 px border that shows in
  forced colours, the hover fill, the pressed fill with the focus-ring border), moved from
  `canvasPill.css` to the bar's stylesheet. The bar keeps the frame's surface background and top
  border; no shadow, no rounded shape.
- The presets list, the zoom error and the page error open **upward** (`bottom: 100%`), since the bar
  is at the bottom of the window. Today the two errors open downward, which in the bar would put them
  off-screen.
- The class names become `.doc-status-*` (`.doc-status-nav`, `.doc-status-zoom-group`,
  `.doc-status-presets`, `.doc-status-error`, `.doc-status-total`); `.canvas-pill*` is retired.
- No new colours; tokens only. No inline style (CSP rule).

### 2.4 Code shape

- `CanvasPill.tsx` becomes `view/StatusControls.tsx` (a `git mv`, so the diff shows only the changes):
  the fade (`FADE_AFTER_MS`, `arm`, `hold`, the pointer and scroll listeners) and the fit check are
  deleted; the render keeps the two groups.
- `DocumentStatusBar` renders `StatusControls` from props that `App` passes from `viewState` and the
  view handle: `page`, `total`, `labels`, `zoom`, `fit`, `onGoTo`, `onStep`, `onZoom`, `onZoomStep`,
  and the page field ref. Its `canBack`, `canForward`, `onBack`, `onForward` and `layout` props go.
- The page field ref moves to `App`. The Go to Page command (`App.tsx:782`) focuses it directly.
  `DocumentViewHandle.focusPageField` and the view's `pageFieldRef` are removed, and
  `DocumentStatusBarHandle` with them (nothing else calls it).
- `DocumentView` no longer renders the pill; `canvasPill.css` is deleted.
- i18n: `pill.*` keys are kept (they name the controls); `view.back` and `view.forward` are removed if
  `npm run lint` and the key check show no other use (the ribbon uses `command.back.label`).
  `layout.statusBar` stays.

## 3. Slice plan

Each slice is one PR, at most 400 production lines (added or changed; tests and generated files do
not count).

**Slice 1: the bar with the page and zoom controls (about 250-330 lines).** Everything in section 2:
`StatusControls` from the pill (fade and fit code removed), `DocumentStatusBar` rewritten, `App`
wiring and the page field ref, the pill unmounted from `DocumentView`, the clearance spacer removed,
the bar's CSS (29 px, upward popups, coarse-pointer 44 px, wrap on narrow), en.ts clean-up. The user
guide (`docs/guide/web.md`, "Going to a page", lines 327-337: the page box, Back and Forward now in the
ribbon) is updated in the same PR. If the count passes 400, stop and split: 1a moves the controls into
the bar and removes Back, Forward and the text; 1b deletes the fade code and the pill stylesheet.

**Slice 2 (only if the owner answers Q4 "yes"): a message area.** The active tool's name with a Stop
button at the start of the middle, and the job progress at the right of the middle, as on the
desktop. Not designed here beyond that.

**Slice 3 (only if the owner answers Q6 "yes"): desktop parity.** Move the desktop's pill into its
`QStatusBar`. Needs its own design note; not designed here.

## 4. Tests and where they run

All tests that change are in slice 1.

### 4.1 Unit (Vitest, `npm test` in `web/app`; CI `web` job)

| Test | Change |
| --- | --- |
| `src/view/DocumentStatusBar.test.tsx` | Rewritten: the bar holds Previous, page field, Next, Zoom out, Zoom, Zoom presets, Zoom in, Fit width, Fit page, in that order; **no** Back or Forward button and no `.doc-status-mode`; the groups sit in start and end. The Alt+Left test (`:73-84`) and the `focusPageField` tests (`:88-119`) and "desktop order" (`:122-139`) are replaced. |
| `src/view/CanvasPill.test.tsx` | Renamed to `StatusControls.test.tsx`. Control names, disabled states, steps, typed zoom, presets kept (`:85-200`); the fade tests (`:220-290`) deleted. New: the presets list and both error messages open upward (class check). |
| `src/documents/documents.test.tsx:633-662` | Selectors move from `.canvas-pill-jump input`, `.canvas-pill-total`, `.doc-status-zoom` to the bar's page field, `.doc-status-total` and the zoom box value. `:662` (no bar without a document) is kept. |
| `src/layout/useFocusRegions.test.tsx:163` | Unchanged (`.app-frame-status` stays). Added: F6 from the page lands on the bar's first control, Previous page. |
| `src/commands/commands.test.ts` | Unchanged; Back and Forward stay as commands. Added (App level, if an App test exists for it): Go to Page focuses the bar's page field. |

### 4.2 Playwright (`web/app`; feature specs need the staged engine; `web-e2e` workflow, not a required check)

| Spec | Change |
| --- | --- |
| `e2e/layout.spec.ts:579-624` "page navigation bar size (#796)" | Becomes "status bar size (#808)": at 1366 by 768, `.app-frame-status` height 29 ± 1 px, controls at least 24 px and on one row; at 390 by 844 no horizontal scroll. Added: under a coarse pointer at 1366, one row with 44 px controls and height at most 50 px; at 390, at most two rows. |
| `e2e/layout.spec.ts:556-575` (tab row widths) | Waits for `.canvas-pill`; waits for the bar's page field instead. |
| `e2e/features/view.spec.ts:29-60` "zoom steps, a typed zoom and the presets" | `.doc-status-zoom` text is gone: read the percentage from the Zoom textbox value. `.canvas-pill-presets` becomes `.doc-status-presets`. The steps themselves are unchanged. |
| `e2e/features/view.spec.ts:69-71` Fit page and Fit width | Locator `.canvas-pill` becomes `.app-frame-status`. |
| `e2e/features/navigate.spec.ts:31-35, 125` | `.canvas-pill` and `.canvas-pill-total` move to the bar. |
| `e2e/features/navigate.spec.ts:86-88` Back and Forward | Use the ribbon's Home > Navigate Back and Forward (or Alt+Left and Alt+Right) instead of `.doc-status` buttons. |
| `e2e/features/links.spec.ts:72, 86` | Same: Back from the ribbon, not `.doc-status`. |
| `e2e/long-document.spec.ts:30` | `.canvas-pill-zoom-input` becomes the Zoom textbox by role. |
| `e2e/features/document.spec.ts:100-115` "motion on: the canvas pill keeps its 200 ms transition" | The pill's fade was the app's only transition, so this negative check loses its witness. The bar's buttons get a 150 ms `background-color` transition on hover (covered by the reduced-motion overrides in `theme/motion.css`), and the check reads that instead. The two reduced-motion sweeps (`:63-98`) are unchanged and must still pass. |
| `e2e/features/document.spec.ts:150-170` touch, 44 px | Selectors `.canvas-pill button`, `.canvas-pill input` become `.app-frame-status button`, `.app-frame-status input`. |
| `e2e/features/document.spec.ts` forced colours | Added: in forced colours, a pressed Fit button in the bar keeps a visible border. |
| `e2e/features/axe.spec.ts` (and `a11y-panels.spec.ts`) | No code change expected; must pass with the bar's toolbar and footer (three browsers, on demand). |
| `e2e/visual-ui.spec.ts` | References change: `document-light.png`, `document-dark.png`, `night-reading-light.png`, `night-reading-dark.png`, `organizer-light.png`, `organizer-dark.png` in `tests/golden/web/linux/`. Regenerated by a `web-e2e` dispatch with `update_snapshots=true`, never locally (W8.2 D6). `start-*` (no bar on the start page) and `header-footer-*` (dialog only) are unchanged. |

### 4.3 Not affected

The desktop (no change unless Q6), Pyodide `web-pytest` (no Python change), `rpc/generated.ts`,
`tokens.css` and the icons (no new icon: the bar reuses `chevron-left`, `chevron-right`, `minus`,
`plus`, `chevron-down`, `move-horizontal`, `expand`).

## 5. Accessibility

- **Region**: the `<footer>` keeps `aria-label="Status bar"` and `data-region="status"`, so F6 still
  reaches it (`useFocusRegions`). Inside, one `role="toolbar"` named "Page and zoom controls"
  (`pill.label`), as the pill had. Tab moves through every control; the controls are the same native
  buttons and inputs, so Enter and Space work as before.
- **Live text**: no live region on the page number or zoom. Both are input values, read on focus;
  announcing every page change while scrolling would be noise. The two error messages keep
  `role="alert"`. The view's own `role="status"` paragraph (`DocumentView.tsx:1918-1922`) is unchanged.
- **Keyboard**: every remaining control is reachable by Tab and F6. Go to Page (its shortcut and the
  command palette) focuses the page field and selects its text, as now. Back and Forward stay on
  Alt+Left and Alt+Right and in the ribbon.
- **Target size**: 24 px at a fine pointer (WCAG 2.5.8 minimum), 44 px under a coarse pointer.
- **Forced colours**: the transparent button border becomes visible; the pressed Fit button keeps
  its border (tested, 4.2).
- **Reduced motion**: the only motion left is the hover transition, removed by the existing overrides.
- **Zoom (browser)**: at 200 % browser zoom the bar wraps rather than scrolling sideways (the
  narrow-width rule).

## 6. Risks

1. **The bar is fixed, not hidden.** The pill used to fade; the bar is always there. That is what the
   owner asked, and it costs 29 px, less than today's 49.
2. **Narrow phones wrap to two rows** (about 97 px) under a coarse pointer. Still under today's
   49 px bar plus the 52 px floating pill. See Q5 for the alternative.
3. **Popups at the window's bottom edge.** The presets list already opens upward; the errors must be
   flipped (2.3), or they render off-screen. Covered by the unit test.
4. **Six goldens change** and need a CI dispatch to regenerate; until then `visual-ui.spec.ts` fails
   on the branch. The PR names the dispatch run.
5. **Lost motion witness**: covered by the new hover transition (4.2). If the owner prefers no hover
   transition, the negative check needs a test-only element instead.
6. **Desktop divergence** (Q6). The guide's desktop pages are unchanged; the web guide is updated.
7. **Back and Forward are less visible.** They are now only in the ribbon's Home tab and on Alt+Left
   and Alt+Right. The owner called them unclear; the ribbon names them with tooltips and a disabled
   reason.

## 7. Owner questions (each with a recommended answer)

- **Q1. Remove Back and Forward from the bar?** Recommended: **yes**. They stay in the ribbon (Home >
  Navigate) and on Alt+Left and Alt+Right, as on the desktop, which never had them on its status bar.
- **Q2. Remove the read-only zoom and layout text?** Recommended: **yes**. The zoom box shows the
  zoom; the ribbon's View toggles show the layout.
- **Q3. Placement in the bar?** Recommended: **page navigator at the left, zoom group at the right**
  (where the owner said the bar was "ok"). Alternative: both groups centred, as the pill was.
- **Q4. Add a message area (the active tool with a Stop button, and job progress), as the desktop's
  status bar has?** Recommended: **not in this issue**. The bar stays page and zoom only; open a
  follow-up if wanted (slice 2).
- **Q5. Phone width under touch: wrap to two rows, or drop the Fit buttons below 480 px to keep one
  row?** Recommended: **wrap** (no control is lost; the Fit commands would otherwise be ribbon-only on
  a phone). One row does not fit even without the Fit buttons (about 413 px of controls at 44 px).
- **Q6. Do the same on the desktop?** Recommended: **no, web only for now**. The owner asked about the
  web screenshot, and the desktop's pill was the model for #796. Open a desktop issue later if the web
  bar proves better.
- **Q7. Bar height 29 px at a fine pointer?** Recommended: **yes**. 24 px controls are the smallest
  that meet the WCAG 2.5.8 target size; 2 px padding and the border make 29.

None of the questions blocks slice 1 if the recommended answers are taken.

## 8. Not verified

- The issue's screenshot (2560 by 116 px): not viewed.
- No browser was run: the 49 px current height and the 29 px, 50 px and 97 px targets are computed
  from the CSS. Slice 1's layout spec measures them.
- The widths of the controls at 390 px (Q5) are estimates from the coded sizes, not measured.
- The desktop status bar's rendered height was not measured.
