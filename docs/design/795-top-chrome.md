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
