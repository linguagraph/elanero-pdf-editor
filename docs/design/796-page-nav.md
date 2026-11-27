# Page navigation bar size: match the desktop pill (issue #796)

**Status: proposed, for owner approval; no production code in this change.**

Issue #796 ("Page navigation bar is too big"): "I also prefer the smaller page navigation popup bar
from the desktop version". The issue has two screenshots. I could not view them; this note works from
the text, the code, and the declared image sizes in the issue's HTML (691 by 104 and 426 by 93 px).
Read as web first and desktop second, the 1.6 width ratio matches the estimate in section 1.3, but that
is a consistency check only.

## 1. Verified status on `origin/main` (`a802a46`)

### 1.1 The web bar: the canvas pill

The web's page navigator is the canvas pill. It holds the page field and the zoom controls, floats at
the bottom centre of the page area and fades after 3 s.

| Part | Evidence |
| --- | --- |
| Component | `web/app/src/view/CanvasPill.tsx:159-289`: `role="toolbar"`, `aria-label={t('pill.label')}`, three `.canvas-pill-group` blocks: navigator (`:176-200`), zoom (`:201-275`), fits (`:276-287`). |
| Glyph buttons | Previous `'‹'` (`:183`), next `'›'` (`:198`), zoom out `'−'` (`:208`), presets `'▾'` (`:248`), zoom in `'+'` (`:273`). All are text glyphs, not icons. |
| Text fit buttons | `t('view.fitWidth')` "Fit width" and `t('view.fitPage')` "Fit page" as visible text (`:277-286`). These are the widest controls. |
| Page field | `web/app/src/view/PageJumpField.tsx:38-61`: the input (`aria-label={t('view.goToPage')}`) and `.canvas-pill-total` showing `t('pill.pageCount')` = `/ {total}` (`en.ts:1076`). |
| Pill box | `web/app/src/view/canvasPill.css:16-36`: `padding: var(--space-1) var(--space-2)` (4 px / 8 px), 1 px border, `gap: var(--space-2) var(--space-3)` (8 px / 12 px) between groups, **`flex-wrap: wrap`**, `font-size: var(--font-size-small)` (12 px, `tokens.css:39`), `border-radius: var(--radius-large, 999px)`. The token is defined (8 px, `tokens.css:38`), so the 999 px fallback never applies: the corners are 8 px, not round. |
| Buttons | `canvasPill.css:64-72`: `min-width: 32px; min-height: 32px; padding: 0 8px`, **a visible 1 px `--color-border-strong` border** on every button, and a surface background. Pressed (`:74-77`): focus-ring border and weight 600. |
| Group gap | `canvasPill.css:58-62`: 4 px inside a group. |
| Inputs | Page field `width: 6em` (72 px at 12 px, `:97-99`); zoom field `width: 5em` (60 px, `:101-104`). |
| Clearance | `--pill-clearance: 64px` (`:5-14`), the spacer after the last page. |
| Coarse pointer | `canvasPill.css:151-158`: buttons and inputs get `min-width/min-height: 44px`. |
| Fit check | `CanvasPill.tsx:106-129`: the pill is hidden when the page area is narrower than it. With `flex-wrap: wrap` and `max-width: calc(100% - 32px)` it wraps to two or three rows before that happens. |

### 1.2 The desktop bar: `ui/view/pill.py`

| Part | Evidence |
| --- | --- |
| Navigator | `src/pdfeditor/ui/view/pill.py:61-97`: previous, field, `/ N`, next. First and last exist but are hidden (`:91-92`) "so the pill stays small". Spacing `METRICS.space(1)` = 4 px (`:95`). |
| Buttons | `_button` (`:51-58`): `QToolButton` with an **icon** (`chevron-left`, `chevron-right`, `minus`, `plus`, `move-horizontal`, `expand`; `:75`, `:86`, `:208`, `:212`, `:215`, `:218`), `setAutoRaise(True)`, tooltip and accessible name from the same string. |
| Button style | `src/pdfeditor/ui/style/qss.py:62-71`: transparent background, **1 px transparent border**, radius 6 px (`m.radius`), padding 3 px; hover fills `c.hover`; checked fills `accent_subtle`. With a 16 px icon this is 16 + 2 x 3 + 2 x 1 = **24 px square**. The 16 px icon size is Qt's default for a standalone tool button; it is not set in `pill.py`, and I did not measure it. |
| Page field | `self.edit.setFixedWidth(44)`, centred (`:80-81`); QSS `padding: 2px 4px`, 1 px border (`qss.py:106-109`). |
| Zoom box | `QComboBox`, editable, `setMinimumContentsLength(5)` (`:170`), presets in its drop-down. |
| Layout | One row (`QHBoxLayout`, `:222-237`), spacing 4 px, margins 8 px left and right and 4 px top and bottom inside the shadow (`:223-226`). **One 1 px separator** between the navigator and the zoom (`:220-221`, painted at `:455`). There is no separator before the fit buttons. |
| Shape | Fully rounded: `radius = body.height() / 2` (`:442`), 1 px `border_strong`, drawn shadow. |
| Placement | 16 px above the bottom (`BOTTOM_MARGIN`, `:48`). Hidden when the viewport is narrower than the pill (`:355-357`). It never wraps. |
| Font | The app font, Segoe UI 9 pt = 12 px at 96 dpi (`qss.py:13`). The same as the web's `--font-size-small`. |

### 1.3 Size, coded and estimated (fine pointer, English, 5-page document, 100 %)

| | Web now | Desktop |
| --- | --- | --- |
| Control height | 32 px | 24 px |
| Pill height | 32 + 2 x 4 + 2 x 1 = **42 px** (one row) | 24 + 2 x 4 = **32 px** |
| Button chrome | visible border on every button | none until hover |
| Gap between groups | 12 px, 3 groups | 4 px plus a 1 px separator, 1 group break |
| Page field | 72 px | 44 px |
| Fit buttons | text, about 70 px each | 24 px icons |
| Pill width (estimate) | **about 530 px** | **about 330 px** |
| Corners | 8 px | fully round |

I did not measure the widths in a browser. They are sums of the coded sizes plus estimated text widths.

## 2. Design

The change is to `CanvasPill.tsx`, `canvasPill.css` and nothing else in production. There are no new i18n
keys and no token changes, so `tokens.css` and `icons.generated.ts` are not regenerated. Every icon the
pill needs is already generated: `chevron-left`, `chevron-right`, `chevron-down`, `minus`, `plus`,
`move-horizontal` and `expand` are all in `web/app/src/theme/icons.generated.ts`.

### 2.1 Markup (`CanvasPill.tsx`)

1. **Icons instead of glyphs**, as on the desktop. Use `<Icon name=… size={16} />` (`theme/Icon.tsx`):
   previous `chevron-left`, next `chevron-right`, zoom out `minus`, presets `chevron-down`, zoom in
   `plus`.
2. **Icon-only fit buttons.** Fit width uses `move-horizontal` and Fit page uses `expand`, each with
   `aria-label={t('view.fitWidth')}` / `t('view.fitPage')`. The accessible names do not change, so every
   test that finds them by name keeps working (section 4).
3. **A tooltip for each icon button**: `title` set to the same `t()` string as its `aria-label`, as the
   desktop's `setToolTip(tip)` with `setAccessibleName(tip)` does. The ribbon's react-aria `Tooltip` is
   not used here (see Q2).
4. **Two groups instead of three**: the navigator, then the zoom with the fits. CSS draws the desktop's
   one separator between them. The DOM order of the controls stays the same, so the tab order and the
   `controls()` order test are unchanged.

### 2.2 Style (`canvasPill.css`), fine pointer

| Property | Now | Target |
| --- | --- | --- |
| `.canvas-pill` padding | `4px 8px` | `calc(var(--space-1) - 1px) var(--space-2)`: 3 px plus the 1 px border, so the outer height is 32 px, as on the desktop |
| `.canvas-pill` gap | `8px 12px` | `var(--space-1)` (4 px) |
| `.canvas-pill` radius | `var(--radius-large, 999px)` (8 px) | `999px` (fully round, as the desktop's height / 2) |
| `.canvas-pill` wrap | `wrap` | `nowrap` under a fine pointer. Keep `wrap` under `(pointer: coarse)`, where 44 px targets cannot fit one row on a phone (see Q1) |
| Second group | none | `border-left: 1px solid var(--color-border); padding-left: var(--space-1)`, the separator |
| Buttons | 32 x 32, visible border, surface background | `min-width/min-height: 24px; padding: 0 var(--space-1)`; `border: 1px solid transparent`; `background: transparent`; `border-radius: var(--radius-base)` (6 px) |
| Button hover | none | `background: var(--color-surface-alt); border-color: var(--color-border)` (the ribbon's hover, `ribbon/ribbon.css:127-130`) |
| Pressed fit | border `--color-focus-ring`, weight 600 | `background: var(--color-surface-alt); border-color: var(--color-focus-ring)`. The border is the mark that forced colours keeps; the weight goes, because an icon has none |
| Inputs | page 6em, zoom 5em, browser height | `min-height: 24px; box-sizing: border-box; padding: 0 var(--space-1)`; page field `width: 44px` (the desktop's fixed width), centred; zoom field `width: 48px` ("6400%" at 12 px fits) |
| Total `/ N` | unchanged | unchanged (`--color-text-muted`, `nowrap`) |
| Coarse block (`:151-158`) | 44 px | unchanged: buttons and inputs keep `min-width/min-height: 44px` |
| `--pill-clearance` | 64 px | unchanged: 16 px offset plus 32 px pill leaves 16 px clear. `long-document.spec.ts` reads it from CSS anyway |

Focus rings (`:83-87`), the fade, the reduced-motion rules (`:48-56`), the preset list and the error text
do not change.

### 2.3 Measurable target (Chromium, 1366 x 768, fine pointer, English, `text_multipage.pdf`, 100 %)

- **Pill height 32 px (± 1)** and **pill width ≤ 360 px**, on **one row**: every control's
  `boundingBox().y` is the same within 1 px.
- Every visible `.canvas-pill button` and `.canvas-pill input` is **at least 24 x 24 px** (WCAG 2.2
  AA 2.5.8). The buttons are exactly 24 px, so the target size is met by size alone. axe's
  `target-size` rule (`e2e/features/axe.ts:12`, `wcag22aa`) passes without relying on spacing.
- Under a coarse pointer, nothing changes from today: every pill control is at least 44 px.

## 3. Slice plan

**One slice, `fix-796-page-nav-size`**, about 90 production lines: `CanvasPill.tsx` about 35 changed
lines and `canvasPill.css` about 55. It is well under the 400-line cap. There are no i18n or generated
token changes; the regenerated golden PNGs (section 4) are test data and do not count. It also updates
the user guide, `docs/guide/reading.md` (the zoom-box paragraph at `:40` is the place): the pill's
buttons are icons, and their names show on hover.

## 4. Tests and where each runs

| Test | Change | Runs in |
| --- | --- | --- |
| `src/view/CanvasPill.test.tsx:86-100` (control order by accessible name) | none, the names and order are unchanged | Vitest (`npm test`, CI `web`) |
| `CanvasPill.test.tsx:199-208` (fit buttons by name, `aria-pressed`) | none | Vitest |
| **New** in `CanvasPill.test.tsx`: each icon button has an `svg.icon`, no visible text, and a `title` equal to its `aria-label`; the pill has two groups | add | Vitest |
| `src/view/DocumentView.fit.test.tsx` (`button('Fit width')` by aria-label, else text, `:53`) | none (aria-label) | Vitest |
| `src/documents/documents.test.tsx:630-654`, `DocumentView.place.test.tsx:119-131`, `pageLabels.test.tsx`, `DocumentStatusBar.test.tsx` (class names `.canvas-pill-jump input`, `.canvas-pill-total`, `.canvas-pill-presets`) | none, the class names are kept | Vitest |
| `src/a11y/touchAndForced.test.ts:77-78` (the coarse rule sets 44 px on `.canvas-pill button` and `input`) and `:131-149` (no forced-colours block removes a border) | none: the coarse block is kept and no forced-colours block is added | Vitest |
| `e2e/features/navigate.spec.ts:30-35, 125` (by name, `.canvas-pill-total` text `/ 5`) | none | Chromium e2e (`npm run e2e:features:chromium`) |
| `e2e/features/view.spec.ts:58-98` (Fit page and Fit width by exact name) | none | Chromium e2e |
| `e2e/features/document.spec.ts:100-114` (the pill's 200 ms transition) | none | Chromium e2e |
| `e2e/features/document.spec.ts:143-190` and `e2e/features/touch-targets.spec.ts` (44 px under touch) | none expected; must pass | Chromium e2e |
| `e2e/features/axe.spec.ts` (`wcag22aa`, includes `target-size`) | none; must pass with 24 px buttons | Chromium e2e |
| `e2e/long-document.spec.ts:30, 116-124` (`.canvas-pill-zoom-input`, the clearance read from CSS) | none | e2e (nightly / on demand) |
| `e2e/forced-colours.spec.ts` | none (it checks the header). The transparent button borders show in forced colours; the pressed fit keeps its border | e2e |
| **New** in `e2e/layout.spec.ts`: the section 2.3 target at 1366 px (height 32 ± 1, width ≤ 360, one row, each control ≥ 24 x 24), and at 390 px: the pill is visible and causes no horizontal scroll | add | Chromium, on every web PR: `layout.spec.ts` is one of the specs CI's `web-browser` job runs (`.github/workflows/ci.yml:211-214`) |
| `e2e/visual-ui.spec.ts:104-125` document and night-reading goldens (`tests/golden/web/linux/document-{light,dark}.png`, `night-reading-{light,dark}.png`) | **break**: the pill is shown when the screenshot is taken (`settle` does not wait 3 s, `:70-73`). Regenerate them with the `web-e2e` workflow's `update_snapshots` input and commit the artifact's PNGs on the branch | web-e2e (on demand / nightly) |

Under AGENTS.md step 7, the PR touches browser behaviour, so a web-e2e run on the branch has to be
checked by hand before auto-merge.

## 5. Risks

- **Icon-only fit buttons are less discoverable** than the words. The tooltip and accessible name carry
  the meaning, as on the desktop. See Q2 for the tooltip style.
- **A `title` tooltip does not show on touch or keyboard focus.** The accessible name still reaches
  screen readers, and the icons are the desktop's. Q2 is the alternative.
- **Sub-pixel rounding.** A 24 px target that renders at 23.9 px fails axe. Set the sizes with
  `box-sizing: border-box` and integer `min-*` values; the new layout test checks `≥ 24` on the bounding
  boxes.
- **Forced colours.** Transparent borders become visible in forced colours, which keeps each button
  outlined. The pressed state relies on the border, not the background (backgrounds are overridden).
  `touchAndForced.test.ts` keeps guarding that no rule removes it.
- **Golden churn.** Four web UI references change. They are regenerated, not hand-edited.
- **Narrow, touch screens.** With 44 px targets the pill still wraps on a phone; that is today's
  behaviour and is kept (Q1).

## 6. Questions for the owner

1. **On touch screens, should the pill keep its 44 px controls (and wrap on a phone), or use the same
   compact size?** *Recommended: keep 44 px under a coarse pointer.* The touch-target specs and the guide
   (W1.6 section 8, `tokens.ts:112-114`) require it, and the desktop has no touch case to copy.
2. **Tooltip: a native `title`, or the ribbon's react-aria `Tooltip`?** *Recommended: `title`.* It
   matches the desktop's plain tool tips and keeps the pill's native buttons and the slice small. The
   react-aria tooltip would also show on keyboard focus, so it could be a later change if wanted.
3. **Should the fit buttons become icons, or keep their words?** *Recommended: icons.* The words make up
   about 140 of the roughly 200 px saved, and the desktop uses icons.
4. **Should the first and last page buttons stay hidden, as on the desktop?** *Recommended: yes.* The
   web pill does not have them now; Home and End do the job.

None of these blocks the design: the recommended answers give a complete slice.

## 7. Not verified

- The two screenshots in the issue: I could not view them, only their declared sizes.
- No browser run: the web widths and heights in section 1.3 are computed from the CSS, not measured. The
  desktop 16 px icon size is Qt's default, not measured.
- No check that the four golden PNGs differ only in the pill (to be seen in the regenerated artifact).
