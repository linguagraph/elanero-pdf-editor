# Top navigation and ribbon space (issue #795)

**Status: proposed, for owner approval; no production code in this change.**

The owner's report: the Preferences button is not needed in the top bar; the theme buttons are too
big and can move next to the Search tools box; the document tab area is too tall, and with the
expanded ribbon the top chrome takes almost a quarter of the window's height. The issue also says
"I prefer this sort of top navigation" with a screenshot.

**I could not view either screenshot** (the issue's two images, 1917 x 550 and 1272 x 372 px). This
design is based on the issue's text only. Question 1 asks the owner to confirm the layout before
slice 2.

## 1. Verified status on `origin/main` (`a802a46`)

All paths are under `web/app/src/` unless marked otherwise.

### Web top chrome, top to bottom

| Element | Evidence |
| --- | --- |
| Frame header (all top chrome) | `layout/AppFrame.tsx:92-94`: `<header className="app-frame-header" data-region="ribbon">`. The frame is a grid, `auto` header row (`layout/layout.css:6-10`). |
| Row 1, the top bar | `App.tsx:1150-1176`. `.app-header` (`App.tsx:1152`) holds the app menu, the logo and quick access (`:1153-1162`), the document tabs (`:1163`), the **Preferences button** (`:1164-1170`) and the **ThemeSwitch** (`:1171`). CSS `app.css:45-54`: `padding: var(--space-3) var(--space-4)` (12 px top and bottom), `flex-wrap: wrap`. |
| Logo | `theme/BrandMark.tsx`; 32 x 32 px (`app.css:89-93`). |
| App menu button | `ribbon/AppMenu.tsx:49`; 32 x 32 px minimum (`ribbon/ribbon.css:159-167`). |
| Quick access | `ribbon/QuickAccess.tsx:31`, compact `.ribbon-command` buttons (min-height 28 px, `ribbon/ribbon.css:113-125`). |
| Preferences button | `App.tsx:1164-1170` runs the `preferences` command; label `command.preferences.label` = "Preferences…" (`i18n/en.ts:379`). CSS `app.css:56-72` (its own colours for WebKit dark, W8.5 S3, and a coarse-pointer rule). The same command is in the app menu (`commands/catalog.ts:471`, `MENU` section 2) and the command palette. |
| Theme switch | `theme/ThemeSwitch.tsx:15-39`: a `<fieldset>` with a visible `<legend>` "Theme" (`prefs.theme.label`, `en.ts:440`) and three radio labels, each a 16 px icon plus the visible text System / Light / Dark (`theme.system` `en.ts:453`, `prefs.theme.light`/`dark` `en.ts:442-443`). CSS `theme/ThemeSwitch.css:1-54`: each option has 4 x 8 px padding, a border and the body font, so the group is roughly 230 px wide. Coarse pointer: 44 px (`ThemeSwitch.css:40-46`). |
| Document tabs | `tabs/DocumentTabs.tsx:36-94` (strip, `TabList` "Open documents"); below 1024 px it is a drop-down (`DocumentTabs.tsx:29-30`, `tabs/DocumentTabMenu.tsx`). CSS `tabs/tabs.css:3-8` (strip, `align-self: stretch`), `:51-55` (list padding 4 px top), `:57-74` (tab: 4 x 8 px padding, 2 px top border); menu button min-height 44 px at every pointer (`tabs.css:23-36`). |
| Narrow notice | `App.tsx:1173`, `layout/NarrowNotice.tsx:31` (phone tier only). |
| Row 2, ribbon tab row | `ribbon/Ribbon.tsx:162-179`: tabs (`:169-175`), **SearchTools** (`:176`), Help (`:177`), collapse chevron (`:178`). CSS `ribbon/ribbon.css:22-29` (tab padding 8 x 12 px), `:289-299` (row), `:301-311` (Help 32 px), `:323-334` (search box 32 px high, 120-180 px wide), `:373-383` (chevron 32 px). The box becomes an icon below 1000 px and in compact or collapsed forms (`Ribbon.tsx:67`, `:176`; `ribbon/SearchTools.tsx:18-34`). |
| Row 3, ribbon panel | `ribbon/Ribbon.tsx:180-211`; toolbar padding 8 px (`ribbon.css:46-53`); full-form command: 22 px icon plus label (`Ribbon.tsx:70`, `ribbon.css:113-125`), group label 12 px (`ribbon.css:80-83`). |
| Ribbon forms | `ribbon/form.ts:18-24`: phone and tablet tiers are tier-collapsed (`CollapsedRibbon`, `Ribbon.tsx:245-275`, with `SearchTools iconOnly` at `:271`); the user can collapse (Ctrl+F1, chevron) or ask for compact; the medium tier (1024-1279 px) forces compact. Breakpoints `theme/tokens.ts:95-98`. |
| Group overflow | `ribbon/useGroupOverflow.ts:42` measures the **toolbar's** width, not the tab row, so a control added to the tab row does not change which groups fit. |

### Estimated heights today (from the CSS, not measured)

At 1366 x 768, fine pointer, full ribbon, one document open, 14 px body text (about 17 px line):

| Row | Estimate |
| --- | --- |
| Top bar: 12 + 32 + 12 px, plus its 1 px border | 57 px |
| Ribbon tab row: 8 + 17 + 8 px, 2 px tab underline, 1 px rule | 36 px |
| Ribbon panel: 8 px padding, 53 px command, 15 px group label, 8 px, 1 px border | 85 px |
| **Total** | **about 178 px, 23 % of 768 px** |

That matches "almost a quarter". These numbers are estimates; slice 2's first commit adds the
measuring test, and its PR body records the real values before and after.

### Desktop equivalents (`src/pdfeditor/ui/`)

- **No Preferences button and no theme buttons in the top chrome.** Preferences is a menu action,
  `main_window.py:437` (`Pre&ferences…`, Ctrl+K). The theme is `View ▸ Theme` with System / Light /
  Dark radio actions (`main_window.py:614-624`, `:681-683`).
- **The ribbon's tab row is one row** with the menu button, quick access, ribbon tabs, the Search
  tools box, Help and the collapse button (`ribbon.py:183-196`; search inserted before Help,
  `ribbon.py:236-242`; box collapses below `SEARCH_BOX_MIN_WIDTH = 1000`, `ribbon.py:45`, `:272`).
  The layout margins are 4/2/4/0 px (`ribbon.py:192`).
- **Document tabs** are a document-mode `QTabWidget` under the ribbon (`document_tabs.py:200-230`,
  `main_window.py:252`, `:262-280`), with a compact corner (overflow and +).

The web's own design (W1.6 §1, `docs/web/design/W1.6.md:11` and `:29`) put the document tabs in the
top bar to save a row, and its diagram has no Preferences button or theme switch in the top bar.
Those two were added later. This change brings the web back to that diagram.

### Open work that touches the same files

Open PRs on `origin/main` today: #794 only (performance trend script), which touches none of these
files. No PLAN.md item names #795.

## 2. Design

### 2.1 Remove the Preferences button from the top bar

- Delete `App.tsx:1164-1170` and its CSS (`app.css:56-72`).
- Preferences stays reachable from the app menu (`catalog.ts:471`), the command palette, and any key
  bound to `preferences`. (Whether the browser lets Ctrl+K reach the page was not checked here; the
  web guide lists keys in Preferences.)
- **Focus return.** Today `keyboard.spec.ts:129-148` and `shortcuts.spec.ts:71`, `:97` expect focus
  back on the header button after Preferences closes. Opened from the app menu, the menu item is
  gone when the dialog closes, so focus must go to the **Main menu** button (WCAG 2.4.3). React-aria
  usually restores to the menu trigger through its focus-scope chain, but no spec on main checks it
  for a dialog opened from the menu. Slice 1 adds that check; if it fails, `App.tsx` focuses the app
  menu button when Preferences closes (a few lines, inside the slice).

### 2.2 Theme switch: icon-only, next to Search tools

- **Position.** In the ribbon tab row, right after `SearchTools` and before Help:
  `Ribbon.tsx:176` (full, compact and user-collapsed forms) and `Ribbon.tsx:271` (tier-collapsed,
  **tablet tier only**). At the **phone tier** (< 768 px) the switch is not shown; the theme is in
  Preferences ▸ Appearance (`prefs/PreferencesDialog.tsx:75-77`), which the app menu opens. At
  320 px there is no room for three 44 px touch targets beside the tabs.
- `Ribbon` renders `<ThemeSwitch />` itself (`ribbon` importing from `theme` is already done for
  `Icon`); no new prop.
- **Form.** Still a `<fieldset>` of three native radios, so keyboard behaviour (arrow keys inside
  the group, one Tab stop) and the forced-colours focus ring stay as they are. Changes:
  - the `<legend>` and each option's text get the existing `.visually-hidden` class
    (`layout/layout.css:327`), so the accessible names stay "Theme", "System", "Light", "Dark";
  - each label gets `title={t(LABELS[value])}` as the pointer tooltip (same keys, through `t()`);
  - each option is a **28 x 28 px** box (fine pointer) with the 16 px icon centred and 0 gap between
    options, joined as one segmented control with the selected one marked by the accent border
    (`ThemeSwitch.css:30-33`, kept). Width about 86 px instead of about 230 px;
  - the coarse-pointer rule stays at 44 px (`ThemeSwitch.css:40-46`), which
    `a11y/touchAndForced.test.ts:88` requires.
- **No new i18n keys** and no token changes: every string already exists, every size uses existing
  `--space-*` tokens or a px value in the component CSS, and `tokens.css` is not regenerated.

### 2.3 Compact the rows (fine pointer only)

Coarse-pointer rules are not touched: every touch target stays 44 px.

| Row | Change | Target |
| --- | --- | --- |
| Top bar | `.app-header` padding `var(--space-3) var(--space-4)` to `0 var(--space-2)`; `flex-wrap: nowrap` at the wide and medium tiers (the start group, tabs and nothing else now); logo 32 to 24 px (`app.css:89-93`); app menu button 32 to 28 px (`ribbon.css:159-161`). | 32 px row |
| Document tabs | List padding-top 4 px to 2 px (`tabs.css:54`); tab padding `var(--space-1) var(--space-2)` kept (27 px tab); tabs sit on the bar's bottom edge, browser style. | inside the 32 px row |
| Ribbon tab row | Tab padding `var(--space-2) var(--space-3)` to `var(--space-1) var(--space-3)` (`ribbon.css:23`); search box, search icon, Help and chevron min-height 32 to 28 px (`ribbon.css:304`, `:326`, `:348`, `:376`). | 28 px row |
| Ribbon panel | Toolbar block padding 8 to 4 px (`ribbon.css:52`), inline padding unchanged so group widths and the overflow count do not change. | about 76 px |

**Measurable targets**, at 1366 x 768, fine pointer, one document open, measured as the height of
`.app-frame-header`:

- full ribbon: **at most 140 px (18 % of 768)**, from about 178 px (23 %);
- user-collapsed ribbon: **at most 64 px (8 %)**;
- compact (1100 x 768): at most 128 px.

The test asserts the full-ribbon target at 1366 x 768 and 1280 x 800, compact at 1100 x 768, and the
collapsed target after Ctrl+F1.

### 2.4 Desktop

No desktop change. The desktop has neither control in its top chrome (section 1), and its rows are
already tight (`ribbon.py:192`). Question 5 confirms.

### 2.5 User guide

`docs/guide/web.md:65-70`: the theme switch is "next to Search tools on the ribbon's tab row (on a
phone, in Preferences ▸ Appearance)", and Preferences is "in the app menu (☰)". `web.md:504`, `:519-520`
and `:535` (the source map) follow the move. `docs/guide/preferences.md` is the desktop page and does
not change.

## 3. Slice plan

Lines are production lines (TS, TSX, CSS). Tests, golden PNGs and docs do not count.

| Slice | Branch | Contents | Estimate |
| --- | --- | --- | --- |
| 1 | `fix-795-top-bar-controls` | 2.1 and 2.2: remove the Preferences button and its CSS; ThemeSwitch icon-only and in the ribbon tab row (not at phone tier); focus return to the Main menu button if needed; guide text. | about 70 lines (about 25 removed) |
| 2 | `fix-795-compact-chrome` | 2.3: the CSS changes and the height test. After owner question 1 is answered. | about 50 lines |

Each slice is far under the 400-line cap. i18n: none. Generated files: none, except the visual
goldens in slice 2 (and slice 1, since the header changes), which are produced by the workflow, not
by hand.

## 4. Tests and where each runs

### Tests that this change breaks, and their update

| Test | Why it breaks | Update |
| --- | --- | --- |
| `e2e/forced-colours.spec.ts:19-24` | expects a Preferences button in `.app-header` | assert the header has no Preferences button; keep the System radio focus-ring check (it finds the radio by role and name, which stay). Tab loop limit of 30 (`:29-33`) is still enough. |
| `e2e/features/touch-targets.spec.ts:119` | clicks the header "Preferences…" button | open Preferences through the Main menu (the spec already opens it at `:114`). |
| `e2e/features/axe.spec.ts:17`, `e2e/features/fonts.spec.ts:11`, `e2e/features/shortcuts.spec.ts:15` | open Preferences with the header button | one shared helper in `e2e/harness/` that opens it from the Main menu. |
| `e2e/features/shortcuts.spec.ts:71`, `:97` | expect focus back on the header button | expect focus on the Main menu button. |
| `e2e/features/keyboard.spec.ts:129-148`, `:153` | the opener is the header button | open from the Main menu with the keyboard; Escape returns focus to the Main menu button. |
| `src/App.test.tsx:336` | `buttonIn(host, 'Preferences…')` finds the header button | open Preferences through the app menu item, or `runCommand(..., 'preferences')`. |
| `e2e/visual-ui.spec.ts:95-145` and `tests/golden/web/linux/{start,document,night-reading,organizer}-{light,dark}.png` | the header pixels change | regenerate with `gh workflow run web-e2e.yml --ref <branch> -f update_snapshots=true` (the spec's own instruction, `visual-ui.spec.ts:19-20`), in each slice. `header-footer-*.png` is a dialog only and does not change. |

Not broken, checked: `src/theme/theme.test.tsx:62-95` (finds radios by value), `src/ribbon/ribbon.test.tsx:320`
(menu text), `src/a11y/touchAndForced.test.ts:88` (coarse rule kept), `src/i18n/usage.test.ts:121`
(file still scanned), `src/theme/tokens.test.ts:31-32`, `e2e/open-recent.spec.ts:65-74`,
`e2e/recent-previews.spec.ts:82-88`, `e2e/features/document.spec.ts:130-170` (tab classes and the
44 px coarse checks stay), `e2e/ribbon.spec.ts` (group widths unchanged, so the overflow checks hold).

### New tests

- Unit (Vitest, `npm test`): the header has no Preferences button; the ribbon tab row holds the
  theme radiogroup right after Search tools in the full, compact and user-collapsed forms; the
  tier-collapsed form shows it at tablet width and not at phone width; the radios keep their names.
- `e2e/layout.spec.ts`: (a) at 1366, 1280, 1100, 1024, 800, 390 and 320 px, no horizontal page scroll
  with the switch in the tab row (extends `:331-358`); (b) the theme options are at least 24 x 24 px
  under a fine pointer (WCAG 2.5.8) at 1366 px; (c) the height targets of 2.3 on the start page
  (always runs) and with a document open (inside the engine-staged `describe` at `:368-397`).
- Chromium feature run (`npm run e2e:features:chromium`) for the updated Preferences specs and the
  focus-return check, and a manual `web-e2e` run on each PR branch, per the auto-merge gate.

## 5. Risks

- **Smaller targets.** 28 px theme options and 28 px tab row controls pass WCAG 2.2 AA 2.5.8 (24 px
  minimum) under a fine pointer; under a coarse pointer every rule stays at 44 px, which
  `touch-targets.spec.ts` and `touchAndForced.test.ts` check.
- **Icon-only theme choice.** Sighted users lose the words; the tooltip and the three icons
  carry it, and screen readers keep the names. Forced colours: the selected option keeps its
  border (`ThemeSwitch.css:30-33`), and `forced-colours.spec.ts` keeps the focus-ring check.
- **Focus after Preferences** (2.1): covered by the new check; fallback in the slice.
- **Tab row width at 1024-1279 px.** The search is an icon there, so the row gains about 86 px; seven
  ribbon tabs plus Help and chevron fit at 1024 px by estimate. The layout test at 1024 px checks it.
- **Visual goldens** must be regenerated in CI on Linux; a stale golden fails `web-e2e`, which is not
  a required check, so the reviewer must look at that run.

## 6. Questions for the owner

1. **What does the preferred screenshot show?** I cannot view it. Recommended answer: three compact
   rows (top bar with tabs, ribbon tab row, ribbon panel), as in 2.3. If it shows the document tabs
   on the same row as the ribbon tabs, or the ribbon tabs in the top bar, slice 2 changes. *Slice 1
   does not depend on this; slice 2 waits for the answer.*
2. **Theme switch form.** Three icon-only radios (one click), or one button with a menu? Recommended:
   three 28 px icon radios.
3. **Phone width.** Leave the switch out below 768 px (the theme is in Preferences)? Recommended: yes.
4. **Preferences only in the app menu and the palette?** Recommended: yes, as the desktop and W1.6 §1.
5. **Desktop.** Leave it unchanged? Recommended: yes; it has neither control in its top chrome.
6. **Logo at 24 px** in the top bar? Recommended: yes (the start page keeps its large logo).

## 7. Not verified

- The two screenshots in the issue (not viewable here).
- Real pixel heights: section 1's numbers are estimates from the CSS; no browser was run.
- Whether react-aria returns focus to the Main menu button after a dialog opened from a menu item
  closes.
- Whether Ctrl+K reaches the page for `preferences` in each browser.

## Slice 2 (revised): merged tab row

**Status: proposed, for owner approval; no production code in this change.**

This addendum replaces slice 2 of section 3 (`fix-795-compact-chrome`) and answers question 1. The
owner described the preferred layout, the desktop app's, and confirmed it in chat ("yes, that's
what i want"): **one ribbon tab row** holds the app menu button, the tabs Home, Edit, Organize,
Protect, Comment, View and Tools, the Search tools box, Help and the collapse caret; the ribbon panel
is under it; the **document tab strip is a slim row under the ribbon panel**, with the file tabs and
a **+** button. There is no top bar above the ribbon tabs. Slice 1 (sections 2.1 and 2.2) is merged
(#800) and is not changed here.

### S2.1 Verified current state on `origin/main` (`172e16f`)

Paths are under `web/app/src/` unless marked otherwise. No PRs are open on `origin/main` today.

| Element | Evidence |
| --- | --- |
| Header fragment | `App.tsx:1161-1179`: the `header` prop of `AppFrame` is `.app-header` (`:1162`), then `NarrowNotice` (`:1175`), then `Ribbon` (`:1176`). `AppFrame` renders it in `<header className="app-frame-header" data-region="ribbon">` (`layout/AppFrame.tsx:92-94`), the `auto` row of the frame grid (`layout/layout.css:6-8`). |
| Top bar (row 1) | `.app-header` (`App.tsx:1162`) holds `.app-header-start` (`:1163-1172`: `AppMenu` `:1164-1169`, `BrandMark` `:1170`, `QuickAccess` `:1171`) and `DocumentTabs` (`:1173`). CSS `app.css:45-54` (padding 12 x 16 px, `flex-wrap: wrap`, bottom border), `.app-header-start` `app.css:57-62`. |
| App menu button | `ribbon/AppMenu.tsx:49`: `<Button aria-label={t('appMenu.label')} className="app-menu-button">☰</Button>` ("Main menu"). CSS 32 x 32 px minimum, `ribbon/ribbon.css:159-167`; 44 px under a coarse pointer, `ribbon.css:451-457`. |
| Logo | `theme/BrandMark.tsx:10-25`: `<img class="brand-logo" src="icons/elanero-32.png" alt="Elanero logo">`, falling back to the `.brand` wordmark. CSS 32 x 32 px, `app.css:76-81`; wordmark `app.css:64-68`. The start page has its own large logo. |
| Quick access | `ribbon/QuickAccess.tsx:23-45`, a `Toolbar` "Quick access" of 16 px icon buttons: `QUICK_ACCESS` (Select, Hand, Undo, Redo, Save; `commands/catalog.ts:477`) from 1024 px, `QUICK_ACCESS_NARROW` (Undo, Redo, Save; `catalog.ts:478`) below (`QuickAccess.tsx:25`). |
| Document tabs | `tabs/DocumentTabs.tsx:25-99`: nothing with no document (`:28`); below 1024 px the drop-down `DocumentTabMenu` (`:29-31`); otherwise `.doc-tabs` with a `TabList` "Open documents" (`:63`). CSS `tabs/tabs.css:3-8` (`flex: 1 1 0` in the bar), `:51-55` (list padding 4 px top), `:57-74` (tab: 4 x 8 px padding, 2 px top border); drop-down button 44 px at every pointer (`tabs.css:23-36`); coarse 44 px tab and close mark (`tabs.css:113-121`). **The web has no + button today**; the desktop has one (`src/pdfeditor/ui/document_tabs.py:222-229`, "Open a file", emits `open_requested`). |
| Ribbon tab row (row 2) | `ribbon/Ribbon.tsx:165-183`: `.ribbon-tabrow` with the `TabList` (`:172-178`), `SearchTools` (`:179`), `ThemeSwitch` (`:180`, slice 1), `HelpButton` (`:181`), `CollapseChevron` (`:182`). CSS `ribbon.css:289-299` (row, 1 px rule), `:22-29` (tab padding 8 x 12 px), `:301-311` Help 32 px, `:323-334` search box 32 px high and 120-180 px wide, `:345-355` search icon 32 px, `:373-383` caret 32 px; theme options 28 px (`theme/ThemeSwitch.css:18-19`). |
| Tier-collapsed row (below 1024 px) | `Ribbon.tsx:248-286`: `.ribbon-collapsed` with a `role="group"` of tab buttons (`:258-280`), `SearchTools iconOnly` (`:281`), `ThemeSwitch` except at the phone tier (`:282`, `:86`), Help (`:283`). Its tabs scroll inside the row (`ribbon.css:248-251`) and are 44 px high (`:253-256`). |
| Ribbon panel (row 3) | `Ribbon.tsx:184-215`; toolbar padding 8 px all round (`ribbon.css:46-53`). The overflow count reads the **toolbar's** inline padding and width (`ribbon/useGroupOverflow.ts:41-42`), not the tab row's, so controls added to the tab row do not change which groups fit. |
| Narrow notice | `layout/NarrowNotice.tsx:28-46`, phone tier only, between the top bar and the ribbon today. |
| Tiers | `theme/tokens.ts:95-99`: wide 1280, medium 1024, tablet 768; `AppFrame` sets `data-tier` (`layout/AppFrame.tsx:82`). |
| Desktop | `src/pdfeditor/ui/ribbon.py:186-195`: one tab row of menu button, quick access, tabs (with search and Help) and collapse; margins 4/2/4/0 px. No logo in the row. Document tabs under the ribbon (`document_tabs.py:200-230`). |

Section 2.3's compact sizes were never implemented: the ribbon tab padding is still 8 px
(`ribbon.css:23`) and the toolbar padding 8 px (`ribbon.css:52`). This addendum folds them in.

### S2.2 Target layout

Top to bottom, all inside `.app-frame-header` (so F6 and the region checks still see `ribbon`):

1. **Tab row** (`.ribbon-tabrow`, or the `.ribbon-collapsed` row): app menu button, logo (wide tier
   only), quick access, ribbon tabs, Search tools, theme switch, Help, collapse caret.
2. **Narrow notice** (phone tier only, unchanged).
3. **Ribbon panel** (hidden when collapsed, as today).
4. **Document strip** `.doc-strip`: the document tabs (below 1024 px, the drop-down) and the **+**
   button. Shown only while at least one document is open, as today (`DocumentTabs.tsx:28`); the
   start page has no strip.

**Implementation shape.** `Ribbon` gets one optional prop, `start?: ReactNode`, rendered first in
`.ribbon-tabrow` (`Ribbon.tsx:165`) and first in the `.ribbon-collapsed` row (`Ribbon.tsx:257`).
`App.tsx` passes `<AppMenu …/><BrandMark/><QuickAccess …/>` inside a `<div className="ribbon-start">`
and deletes `.app-header`; `DocumentTabs` moves after `<Ribbon>` inside a `.doc-strip` wrapper. The
ribbon module does not learn about `AppMenu`'s props or the document state. `ribbon.test.tsx`
renders `Ribbon` without `start` and keeps passing.

**Row heights at 1366 x 768, fine pointer, one document open** (estimated from the CSS; the slice
PRs record the measured values):

| Row | Today | Target | How |
| --- | --- | --- | --- |
| Top bar | 57 px | **0** (removed) | its contents move to the tab row |
| Tab row | 36 px | **29 px** (28 + 1 px rule) | ribbon tab block padding 8 to 4 px (`ribbon.css:23`); menu button, Help, search box, search icon and caret min-height 32 to 28 px (`ribbon.css:160-161`, `:303-304`, `:326`, `:347-348`, `:375-376`); logo 32 to 20 px (`app.css:76-81`); quick access is already 16 px icons |
| Ribbon panel | 85 px | **about 77 px** | toolbar padding `var(--space-2)` to `var(--space-1) var(--space-2)`: block 4 px, inline 8 px kept, so `useGroupOverflow.ts:41` sees the same inline padding and the overflow count does not change |
| Document strip | (inside the top bar) | **at most 28 px** | list padding-top 4 to 2 px (`tabs.css:54`); tab block padding 4 to 2 px (`tabs.css:63`), 2 px top edge kept; + button 24 x 24 px; 1 px bottom border |
| **Total** | **about 178 px (23 %)** | **at most 136 px (18 %)** | |

Same window, ribbon collapsed (Ctrl+F1): tab row 29 + strip 28 = **at most 60 px (8 %)**. Start page
(no strip): full ribbon **at most 108 px**, collapsed **at most 32 px**. Compact form at 1100 x 768 with
a document: **at most 110 px**.

The measurable target is the height of `.app-frame-header`, asserted as above at 1366 x 768 and
1280 x 800 (full, one document), after Ctrl+F1, at 1100 x 768, and on the start page.

**Coarse pointer.** Nothing shrinks: every rule under `@media (pointer: coarse)` stays at 44 px, and
the + button gets one. The tab row and the strip are then about 45 px each; there is no height
target under a coarse pointer.

### S2.3 Logo and app menu button

- **App menu button**: first item of the tab row at every width and in every form; same element,
  same accessible name "Main menu" (`appMenu.label`), same 44 px coarse rule; 28 x 28 px at a fine
  pointer.
- **Logo**: second item, 20 x 20 px (the 32 px PNG scaled down; the `<img>`'s `width` and `height`
  attributes become 20), **shown at the wide tier only (1280 px and up)**, hidden below 1280 px by
  `.app-frame:not([data-tier='wide']) .ribbon-start :is(.brand-logo, .brand) { display: none; }` (the
  wordmark fallback hides too). The desktop has no logo in its tab row; question S2-1.
- **Quick access**: third item. The full set (5 icons) at the wide tier; the narrow set (Undo, Redo,
  Save) below 1280 px, so the threshold in `QuickAccess.tsx:25` moves from `medium` to `wide`. This
  saves about 60 px at the medium tier, where the row is tightest.

### S2.4 Responsive behaviour (no horizontal page scroll at any width)

Width estimate for the full row at 1280 px, fine pointer: menu 28, logo 20, quick access 5 x 26,
seven ribbon tabs about 75 each (text plus 24 px padding), search box 180, theme switch 82, Help 28,
caret 28, gaps and margins about 60: **about 1110 px**, so about 170 px to spare.

- **1366 and 1280 px (wide, full form):** everything on one row, as above.
- **1100 px (medium, compact form):** no logo, three quick-access icons, search as an icon
  (`Ribbon.tsx:179`): about 900 px, fits.
- **1024 px:** as 1100 px; about 120 px to spare.
- **Safety net:** `.ribbon-tabrow .ribbon-tabs` gets `overflow-x: auto; scrollbar-width: none`, as the
  collapsed row already does (`ribbon.css:248-251`). If a translation or a larger root font makes
  the row too wide, the ribbon tabs scroll inside the row and the page never scrolls; arrow keys
  still reach every tab.
- **800 px (tablet, tier-collapsed):** one row: menu, three quick-access icons, the tab buttons
  (scrolling inside), search icon, theme switch, Help. Under it the strip, with the document
  drop-down (`DocumentTabMenu`, 44 px as today) and the + button.
- **390 px (phone):** the row **wraps to two lines**: line one is menu, three quick-access icons,
  search icon and Help (no theme switch, slice 1); line two is the tab buttons, full width, scrolling
  inside. CSS at the phone tier: `.ribbon-collapsed { flex-wrap: wrap }` and its `.ribbon-tabs
  { order: 1; flex-basis: 100% }`. Without the wrap, under a coarse pointer the fixed controls take
  about 280 px and leave the seven tabs about 100 px. The DOM order does not change, so neither does
  the Tab order. Then the narrow notice, then the strip with the drop-down and +.
- **320 px:** as 390 px. Line one under a coarse pointer is 6 controls of 44 px plus gaps, about 290
  px; it fits. Question S2-3 asks whether to keep the three quick-access icons there.

### S2.5 Document strip and the + button

- `.doc-strip`: `display: flex; align-items: flex-end; gap: var(--space-1); padding: 2px var(--space-2) 0;
  background: var(--color-window)` (the tabs sit over the page, as in the desktop's document mode),
  with a 1 px bottom border `var(--color-border)`. `.doc-tabs` keeps `flex: 1 1 0; min-width: 0;
  overflow-x: auto` (`tabs.css:3-8`), so many tabs scroll inside the strip.
- **+ button**: a react-aria `Button` after the tab list (after the drop-down below 1024 px), class
  `.doc-strip-open`, the `plus` icon (`src/pdfeditor/data/icons/plus.svg`, already generated),
  accessible name and `title` `t('command.open.label')` ("Open…"). It runs the `open` command
  (`catalog.ts:153`) through a new `onOpen` prop on `DocumentTabs`. 24 x 24 px at a fine pointer,
  44 x 44 px under a coarse pointer. **No new i18n key.**
- Tab order: the strip comes **after** the ribbon panel (today the document tabs come before the
  ribbon tabs). Inside the strip: the tab list is one stop (arrow keys inside), then +. The strip
  stays inside `.app-frame-header`, so F6 still treats it as the ribbon region.

### S2.6 Accessibility

- The ribbon's own roles and keyboard order stay: `tablist` "Ribbon" (or the collapsed `group`),
  then Search tools, the theme `radiogroup` (fieldset), Help, caret. The start group (menu button,
  quick-access `toolbar`) was already first in the header's Tab order and stays first. The one order
  change is the document tabs, which move from before the ribbon tabs to after the ribbon panel,
  matching the visual order (WCAG 2.4.3).
- The menu button keeps its element and its accessible name "Main menu", so focus return after
  Preferences (`e2e/features/keyboard.spec.ts:130-148`) is unaffected.
- Fine-pointer sizes: 28 px tab-row controls and the 24 px + button meet WCAG 2.2 2.5.8 (24 px).
  Coarse pointer: 44 px everywhere.
- Forced colours: the selected ribbon tab keeps its 2 px underline and the selected document tab its
  top edge (`e2e/features/document.spec.ts:130-145`); the + button gets a `ButtonText` border under
  `forced-colors: active`.

### S2.7 Slice plan

Production lines are TS, TSX and CSS; tests, goldens and docs do not count. Each slice is far under
the 400-line cap.

| Slice | Branch | Contents | Estimate |
| --- | --- | --- | --- |
| 2a | `fix-795-merged-tabrow` | `Ribbon` `start` prop; `App.tsx` moves menu, logo and quick access into it, deletes `.app-header`, moves `DocumentTabs` under the ribbon in `.doc-strip`; delete `app.css:45-62`; logo 20 px, hidden below 1280 px; quick-access threshold 1280 px; phone wrap; tab-row safety net; guide `docs/guide/web.md:134` ("under the top bar") and `:155`. | about 110 lines (about 40 of them removed) |
| 2b | `fix-795-compact-rows` | The sizes in S2.2 (28 px tab row, panel padding, slim strip) and the `.app-frame-header` height test. | about 50 lines |
| 2c | `fix-795-strip-open` | The + button, its coarse and forced-colours rules, guide text. | about 50 lines |

2a and 2b each change the goldens. One PR for both (about 160 lines) regenerates them once; question
S2-4.

### S2.8 Tests and where each runs

**Tests that break, and their update:**

| Test | Slice | Why | Update |
| --- | --- | --- | --- |
| `e2e/forced-colours.spec.ts:21`, `:25` | 2a | `.app-header img.brand-logo` and the `.app-header` Preferences locator | `.ribbon-tabrow img.brand-logo` (1366 px is the wide tier, so the logo shows); scope the Preferences check to `.app-frame-header`. The 30-press Tab loop (`:30-36`) still reaches System: the start page has no strip. |
| `src/App.test.tsx:252` | 2a | `.app-header .app-menu-button` | `.ribbon-tabrow .app-menu-button` |
| `src/App.test.tsx:565`, `:676`, `:855`, `:1048`, `:1058` | 2a | `.app-header-start [data-command=…]` | `.ribbon-start [data-command=…]` (Save, Undo and Redo are in the narrow set that jsdom's 1024 px width gets) |
| `src/ribbon/quickAccess.test.tsx:73-77` | 2a | the narrow set's threshold moves | add a check at 1100 px (narrow set); the 1280 px test (`:64-71`) holds |
| `e2e/layout.spec.ts:368-397` | 2a | describe "document tabs in the top bar" | rename; assert the "Open documents" tablist's top is at or below the ribbon's bottom; the 800 px drop-down check keeps its `.app-frame-header` locator |
| `e2e/layout.spec.ts:215-216` | 2a | comment "under the logo bar" | comment only |
| `e2e/visual-ui.spec.ts:95-145`: `tests/golden/web/linux/start-light.png`, `start-dark.png`, `document-light.png`, `document-dark.png`, `night-reading-light.png`, `night-reading-dark.png`, `organizer-light.png`, `organizer-dark.png` | 2a, 2b, 2c | header pixels | regenerate with `gh workflow run web-e2e.yml --ref <branch> -f update_snapshots=true` (`visual-ui.spec.ts:19-20`). `start-*` change in 2a and 2b only (no strip on the start page). `header-footer-*` is a dialog crop and does not change. |
| `src/a11y/touchAndForced.test.ts:79-80` | 2c | the table of coarse rules | add `['tabs/tabs.css', '.doc-strip-open', ['min-width', 'min-height']]` |

Not broken, checked: `e2e/features/keyboard.spec.ts:39-65` (start page; every stop before the page is
still the ribbon region), `:81` and `:114-148` (by role "Main menu"); `e2e/layout.spec.ts:217-236`
(`.app-frame-header .ribbon`; the collapsed `> .ribbon-tabs > button` count stays 7, since the start
group is a sibling of `.ribbon-tabs`), `:333-354`; `e2e/features/markup.spec.ts:76` (`.quick-access`
Redo); `e2e/features/document.spec.ts:130-170`, `e2e/open-recent.spec.ts:65-74`,
`e2e/recent-previews.spec.ts:82-88` and `src/documents/documents.test.tsx` (the `.doc-tab*` classes
stay); `src/theme/BrandMark.test.tsx:37-40` (src, alt and fallback unchanged); the Main menu specs
(`a11y-panels`, `attachments`, `print`, `save-as`, `shortcuts`, `touch-targets`), which find the
button by role.

**New tests:**

- Vitest (`npm test`, CI `web` job): the tab row's first children are the menu button, then quick
  access; there is no `.app-header`; `.doc-strip` follows the ribbon and holds the tablist and the +
  button; + runs `open`; `Ribbon` renders `start` in both the full and the tier-collapsed row.
- `e2e/layout.spec.ts` (start-page cases in CI's Playwright run; document cases inside the
  engine-staged describe, so in the `web-e2e` workflow):
  - no horizontal page scroll at 1366, 1280, 1100, 1024, 800, 390 and 320 px, on the start page and
    with a document (extends `:349-354`);
  - the menu button, the ribbon tablist and the caret share one row (same box top) at 1366, 1100 and
    1024 px; at 390 px the tab buttons are on a second line below the menu button;
  - the logo is visible at 1366 px and hidden at 1100 px;
  - **height** of `.app-frame-header`: at most 136 px at 1366 x 768 and 1280 x 800 (full, one
    document), at most 60 px after Ctrl+F1, at most 110 px at 1100 x 768, at most 108 px on the start
    page at 1366 x 768;
  - fine-pointer sizes: tab-row controls at least 24 px square, the + button 24 x 24 px.
- `e2e/features/touch-targets.spec.ts` (coarse pointer, 1366 x 768, `:84`): already scans every
  control for 44 px, so it covers the moved controls and the + button. Add a coarse 1280 x 800 case
  with no horizontal scroll (the coarse row is about 1260 px, so the safety net is what holds).
- `e2e/forced-colours.spec.ts`: the updated logo locator; the + button has a visible border.
- `e2e/features/axe.spec.ts`: unchanged; covers the new button's name (feature run, Chromium).
- Visual goldens as listed, regenerated by the workflow.
- Each PR: `npm run typecheck`, `lint`, `format:check`, `test`, `npm run e2e:features:chromium`, and a
  manual `web-e2e` run on the branch checked by hand before auto-merge (AGENTS.md step 7).

### S2.9 Risks

- **Tab-row width under a coarse pointer.** At 1280 px with 44 px targets the row is about 1260 px;
  the ribbon tabs then scroll inside the row, and on a touch laptop the last tab may be partly hidden.
  The new coarse 1280 px case checks page scroll, not a hidden tab.
- **Translations.** Longer labels widen the row; the safety net keeps the page from scrolling.
- **Tab order of the document tabs** (now after the ribbon panel). Keyboard and screen-reader users
  reach them later; the order now matches what is seen.
- **Goldens** change in each slice; `web-e2e` is not a required check, so the reviewer must look at
  that run.
- **No logo below 1280 px.** The favicon and the start page still show it.
- **Strip colour.** `--color-window` beside the page may read as part of the page; question S2-5.

### S2.10 Questions for the owner

1. **Logo.** Keep a 20 px logo after the menu button at 1280 px and wider, hidden below?
   Recommended: yes (the desktop has none, but the web page has no window icon of its own).
2. **Quick access on the tab row.** Keep it, as the desktop does: all five icons at 1280 px and up,
   Undo, Redo and Save below? Recommended: yes.
3. **Phone (390 and 320 px).** Wrap the tab row to two lines (controls, then the ribbon tabs), with
   the three quick-access icons kept? Recommended: yes.
4. **Slices 2a and 2b in one PR**, so the goldens are regenerated once? Recommended: yes (about 160
   production lines), with 2c separate.
5. **Strip colour.** The window colour behind the document tabs (desktop document mode)?
   Recommended: yes, `--color-window`; `--color-surface-alt` if it blends into the page.
6. **The + button** opens the file picker (the `open` command, "Open…") and shows only while a
   document is open? Recommended: yes; the start page has its own Open.

### S2.11 Not verified

- No browser was run: every height and width here is estimated from the CSS and label lengths.
  The first slice's PR records the measured `.app-frame-header` height before and after, at
  1366 x 768.
- The owner's screenshot itself (described in the task and confirmed in chat; not viewed here).
- Whether react-aria scrolls a focused ribbon tab into view inside an `overflow-x: auto` tablist in
  all three browsers.
- The real coarse-pointer row width at 1280 px.
