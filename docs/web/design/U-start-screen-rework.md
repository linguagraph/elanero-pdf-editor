# #626: Start screen rework (web)

**Status: decided by the design owner's delegate (Opus 5.5) on 2026-11-22; proposed for owner approval; no production code in this change.**

Issue: #626 ("Home page design need rework": "Make this design more pleasant and user friendly").
Role: design, Opus 5.5. Branch: `docs-626-start-screen-design`. Scope: the **web** app's start
screen (`web/app`), the screen in the issue's screenshot. The desktop start page
(`src/pdfeditor/ui/start_page.py`) is a different, already richer screen and is out of scope.

Inputs: `web/app/src/start/StartPage.tsx`, `web/app/src/start/start.css`, `web/app/src/App.tsx`,
`web/app/src/about.tsx`, `web/app/src/i18n/en.ts`, `web/app/src/theme/tokens.css` (generated),
`web/app/src/recent/recentFiles.ts`, `web/app/src/documents/useDocuments.ts`,
[W1.6 §3 and §12](W1.6.md), `docs/guide/web.md`, the Vitest and Playwright tests named below.

## 1. Verified status (origin/main at d56536c)

What the screenshot shows, top to bottom, and where it comes from:

| On screen | Source |
|---|---|
| "Open a PDF" (h2) | `StartPage.tsx:41-43`, key `start.heading` (`en.ts:821`) |
| Dashed box with "Drop PDF files here, or use Open file." and the **Open file** button | `StartPage.tsx:44-61`, keys `start.drop`, `start.open` (`en.ts:822-823`); style `start.css:14-38` |
| "Recent files" (h3) and rows "name Opened {date}" | `StartPage.tsx:92-118`, keys `start.recent.heading`, `start.recent.opened` (`en.ts:824-826`); style `start.css:51-79` |
| "Elanero" (h1), "Version 0.4.1" | `App.tsx:1241-1247`, keys `app.name`, `app.version` (`en.ts:18-19`) |
| "About Elanero" (h2), "Version 0.4.1", "Licence: AGPL-3.0-or-later", "Source code" link | `<About />` rendered by `App.tsx:1245`, component `about.tsx:8-20`, keys `about.title`, `about.licence`, `about.source` (`en.ts:21-23`) |

Further facts:

- **Layout.** `.start-page` is a grid with `max-width: 40rem` and no `margin-inline: auto`
  (`start.css:2-6`), so the column hugs the left edge and the right half of a desktop window stays
  empty. `.app-main` pads by `--space-4` (`app.css:60-66`). The About block sits **outside** the
  start page, as siblings in `.app-main`, rendered whenever `documentShown` is false
  (`App.tsx:1241`, `documentShown` at `App.tsx:385`, `showStart` at `App.tsx:330`).
- **Headings.** The order in the DOM is h2 "Open a PDF", h2 from the load panel while the engine
  loads (`feedback/LoadingScreen.tsx:33,49`), h3 "Waiting to open" (`StartPage.tsx:65`), h3
  "Recent files" (`StartPage.tsx:93`), then the page's only **h1** "Elanero" (`App.tsx:1243`), then
  h2 "About Elanero" (`about.tsx:11`). The h1 comes last.
- **Version printed twice**: `App.tsx:1244` and `about.tsx:12` both render `app.version`.
- **Drop target.** Only `.start-drop` handles `dragover`/`drop` (`StartPage.tsx:47-53`). Nothing in
  `web/app/src` listens on the window or the rest of the page (grep for `'drop'`, `onDrop=`,
  `'dragover'`: only Combine, the edit layers and the document view). A PDF dropped beside the box
  gets the browser's default action. There is no drag-over feedback: the box looks the same during
  a drag.
- **Recent files.** Names and open times only, newest first, at most 10, in `localStorage`
  (`recentFiles.ts:1-10, 33-52`). A name is a text-styled button (`start.css:65-74`); clicking it
  opens the file picker and shows "Pick {name} again in the file picker." (`useDocuments.ts:329-332`,
  `StartPage.tsx:87-91`, key `start.recent.pickAgain` at `en.ts:827`). Nothing tells the user this
  before they click. There is no way to remove one entry or clear the list on the start page
  (no remove or clear function in `recentFiles.ts` or `useDocuments.ts`); only Preferences, Privacy,
  **Clear all local data…** removes them (`docs/guide/web.md:75-78`).
- **No quick actions and no logo** on the web start page, although the app has Combine and Compare
  without a document (`App.tsx:289`, `App.tsx:296`; commands at `commands/catalog.ts:229,361`) and
  the brand images `public/icons/elanero-256.png` and `elanero-512.png`.
- **About overlay** already exists: the app menu's **About Elanero** opens `<About />` in an
  `Overlay` (`App.tsx:169-170, 280, 1003-1004`). `about.tsx:4-6` explains the AGPL §13 reason for
  the source link (to the exact commit).
- **Tokens** (generated from `src/theme/tokens.ts`, `tokens.css:2-49` light, `:51-73` dark by
  preference, `:75-96` dark by choice, `:97` on accent presets): colours `window`, `surface`, `surfaceAlt`, `border`,
  `borderStrong`, `text`, `textMuted`, `accent`, `onAccent`, `accentText`, `focusRing`, `brand`;
  spacing `--space-1..6` (4 to 24 px); radii `small/base/large` (4/6/8 px); font sizes only
  `small/body/title` (12/14/20 px); breakpoints `wide/medium/tablet` (1280/1024/768 px).
  `contrast.test.ts:30-31,50-66` already checks `text`, `textMuted` and the accent-text presets at
  4.5:1 on `window`, `surface` and `surfaceAlt`, and the focus ring at 3:1, in both schemes.
- **Tests that pin today's start page**:
  - Vitest: `start/StartPage.test.tsx` (load panel inline, pending list);
    `documents/documents.test.tsx:211-249` (Open button opens the PDF-only input, keyboard reach,
    drop zone described by `start.drop`, dropped PDF opens a tab), `:382-405` (recent order, click
    opens the picker and shows the hint; it finds the row by `buttonNamed('first.pdf')`), `:523-531`
    and `:560-564` (About text and h1 on the start page, gone with a document);
    `App.test.tsx:223-232` (h1 is "Elanero").
  - Playwright: `e2e/pwa.spec.ts:103,138` and `e2e/file-launch.spec.ts:88` use the h1 "Elanero" as
    the "app is up" marker; `e2e/features/axe.spec.ts:24-27` (axe, WCAG 2.2 AA, light and dark);
    `e2e/features/keyboard.spec.ts:39-65` (Tab lap, every stop has a visible ring);
    `e2e/layout.spec.ts:30-43` (no horizontal scroll at 1366, 1100, 800, 390 px);
    `e2e/open-during-load.spec.ts`, `e2e/file-launch.spec.ts:81-82` (the `.start-pending` list).
  - There are **no screenshot goldens** for the web app (no `toHaveScreenshot` in `web/app`). The
    desktop goldens in `tests/golden/ui/windows/start-page-*.png` cover the desktop page only.
- **Guide.** `docs/guide/web.md` has no description of the start page beyond "Waiting to open"
  (`web.md:36-38`); About is described as an app-menu item (`web.md:107-108`).

## 2. Problems a user sees

1. **No visual hierarchy.** The biggest text on the screen is "Elanero" at the bottom, under the
   working part of the page. The page starts with a small h2 and ends with an unstyled block.
2. **The About block reads as leftover debug text**: browser-default h1 and h2, the version twice,
   plain paragraphs, and it competes with the recent files for attention.
3. **The column sits at the left** with the right 60 % of a desktop window empty.
4. **The drop box is weak**: a grey dashed outline, small muted text, no icon, no change while a
   file is dragged over it, and a drop beside the box does not open the file.
5. **Recent files have no clear action**: a blue name with a date beside it looks like a link but
   does not reopen the file (the browser cannot); the "pick it again" explanation appears only
   after a click. There is no way to remove an entry or clear the list here.
6. **Nothing says what else you can do** without a document: Combine and Compare are only in the
   ribbon.
7. **Heading order is wrong for screen readers** (h2, h3, then h1 last).

## 3. Proposed layout

One centred column, `max-width: 45rem` (720 px), `margin-inline: auto`. Top to bottom:

```
            [logo 64]  Elanero                                   <- h1, hero
                       Read, edit and combine PDFs in your browser.
                       Your files are not uploaded.              <- muted tagline

  Open a PDF                                                     <- h2
  +-------------------------------------------------------------+
  |   [upload icon 32]                                          |  <- open card (surface,
  |   Drop PDF files here                                       |     dashed borderStrong,
  |   or                                                        |     radius-large)
  |   [ (folder-open) Open file ]                               |  <- primary, accent
  +-------------------------------------------------------------+
  (load panel while the engine loads, unchanged)
  (Waiting to open list, unchanged rows)

  Quick actions                                                  <- h2
  [ (combine) Combine files ]  [ (git-compare) Compare files ]   <- secondary buttons, wrap

  Recent files                                     [Clear list]  <- h2 + small text button
  Elanero keeps only the names. Choose one to pick it again.    <- muted note
  +-------------------------------------------------------------+
  | (file) report.pdf                                       (x) |  <- one row per file:
  |        Opened Nov 22, 2026, 10:14 PM                        |     open button + remove
  +-------------------------------------------------------------+
  ...
  ---------------------------------------------------------------
  Elanero 0.4.1 · Licence: AGPL-3.0-or-later · Source code · About Elanero   <- footer, small, muted
```

### Hierarchy and spacing (tokens only)

- **Hero.** Logo `icons/elanero-256.png` at 64 × 64 CSS px (sharp up to 4× device pixel ratio),
  `alt=""` because the h1 beside it names the app. h1 `app.name`, `font-size:
  calc(var(--font-size-title) * 1.4)` (28 px), weight 600, colour `--color-text`. Tagline
  `--font-size-body`, `--color-text-muted`. Gap between logo and text `--space-4`.
- **Section gaps.** Column grid `gap: var(--space-6)`; heading to content `--space-2`; top padding
  `calc(var(--space-6) * 2)` (48 px) at ≥ 768 px, `--space-4` below.
- **Section headings (h2).** `calc(var(--font-size-body) + 2px)` (16 px), weight 600,
  `--color-text`. No new font-size token: the token pipeline mirrors the desktop's
  `ui/style/tokens.py`, and two derived sizes do not justify changing it (see Owner decisions D6).
- **Open card.** `--color-surface` background, `2px dashed var(--color-border-strong)`,
  `--radius-large`, padding `--space-6`, content centred. Icon `upload` (32 px) in
  `--color-text-muted`; "Drop PDF files here" in `--color-text` at body size, weight 600; "or" in
  `--color-text-muted`. **Drag-over state** (`data-dragging="true"` on the card while any PDF is
  over the page): border `2px solid var(--color-focus-ring)`, background `--color-surface-alt`
  (`focusRing`, not `accent`, for the 3:1 reason in §4).
  The Open file button: `--color-accent` fill, `--color-on-accent` text and icon (`folder-open`
  16 px), `--radius-base`, `min-height: 2.5rem`, padding `0 var(--space-5)`.
- **Quick actions.** `display: flex; flex-wrap: wrap; gap: var(--space-2)`. Each button:
  `--color-surface` background, `1px solid var(--color-border)`, `--radius-base`, icon 20 px plus
  label, `min-height: 2.5rem`; hover background `--color-surface-alt`, border `--color-border-strong`.
- **Recent rows.** A list of rows, each `--color-surface`, `1px solid var(--color-border)`,
  `--radius-base`, padding `--space-2 --space-3`, rows separated by `--space-1`. The row's open
  button holds the `file` icon (20 px, `--color-text-muted`), the name (`--color-text`, weight 600,
  `overflow-wrap: anywhere`) and under it the time (`--font-size-small`, `--color-text-muted`).
  The open button fills the row; hover gives the row `--color-surface-alt`. The remove button (`x`
  16 px, `--color-text-muted`, hover `--color-text`) sits at the row's end, outside the open button
  (no nested interactive content).
- **Footer.** `border-top: 1px solid var(--color-border)`, padding-top `--space-3`,
  `--font-size-small`, `--color-text-muted`, items separated by `--space-3` and wrapping. Source
  code is a link (`--color-accent-text`, `.app-main a` at `app.css:74-76`); About Elanero is a
  text-styled button that opens the existing About overlay.
- **Focus.** Every interactive element: `outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px` on `:focus-visible`, as `start.css:40-44` does today.

### Light and dark

Only colour tokens above, no literal colours, so both schemes and all eight accent presets come from
`tokens.css` as they do now. Forced colours: borders and the drag-over state use `border` properties
(kept by the browser as system colours), the logo is decorative, and the icons use `currentColor`.

### Scaling and narrow widths

Browser zoom at 125 %, 150 % and 200 % (and Windows display scaling) reduces the CSS-pixel width:
1366 px at 200 % is 683 CSS px. Everything is sized in CSS px tokens, so zoom scales it uniformly;
the layout responds through width media queries only:

| CSS width | Layout |
|---|---|
| ≥ 768 px (100 %, 125 %, 150 % on 1366 px) | as drawn; column 720 px max, centred |
| < 768 px (200 % on 1366 px, tablets portrait, phones) | top padding `--space-4`; logo 48 px; hero stacks logo above text; open card padding `--space-4`; Open file button full width; quick actions wrap one per line below 480 px; footer items wrap |
| 320 px (WCAG 1.4.10 reflow: 1280 px at 400 %) | no horizontal scroll; long names wrap anywhere |

Under `@media (pointer: coarse)` the open button, quick actions, recent row buttons and remove
buttons are at least 44 × 44 px (W1.6 §12, the W8.5 touch-target rule; same pattern as
`ribbon.css:379`, `tabs.css:109`).

### Behaviour changes (and what does not change)

- **The whole start page is a drop target**: `dragover`/`drop` move from `.start-drop` to
  `.start-page`, so a PDF dropped anywhere on the page opens, and the card shows the drag-over state.
  The same `onFiles` call receives the files; non-PDF files keep today's "not a PDF" message path.
- **Remove and clear**: two new functions in `recentFiles.ts` (`removeRecentFile(name, openedAt)`,
  `clearRecentFiles()`), exposed from `useDocuments` as `forgetRecent` and `clearRecent`; storage
  rules as now (wrapped access, no throw).
- **About moves into the footer**: `App.tsx:1241-1247` goes away; the h1 moves into the hero, the
  version, licence and source link into the footer, and About Elanero opens the existing overlay
  (`setAboutOpen`, passed as an `onAbout` prop). `about.tsx` is unchanged (the overlay still shows
  the full About).
- **Unchanged**: Open file opens the PDF-only file input; a dropped PDF opens a tab; a recent row
  opens the file picker and shows the `start.recent.pickAgain` hint; the recent list's content,
  order, limit and storage; the load panel and Waiting to open list (their classes and text, used
  by `open-during-load.spec.ts` and `file-launch.spec.ts`); the h1 text "Elanero" (the e2e "app is
  up" marker); Ctrl+O; the About overlay from the app menu.

## 4. Accessibility rules

- **Headings**: exactly one h1 (`app.name`, in the hero), then h2 "Open a PDF" (`start.heading`,
  visible above the open card at section-heading size, D3), the load panel (already h2), "Waiting
  to open" (h3 → h2), "Quick actions" and "Recent files" (h3 → h2). No level is skipped. `section`
  elements keep their `aria-labelledby`.
- **Landmarks**: the start page stays inside the page area (`#app-page-area`, the skip-link target);
  the footer is a `<footer>` inside the start page's `section`, so it is not a page-level
  `contentinfo` landmark.
- **Focus order** (DOM order, no positive `tabindex`): Open file → Don't open buttons (if any) →
  load panel's Try again (if failed) → Combine files → Compare files → Clear list → each recent
  row's open button then its remove button → Source code → About Elanero. The drop card itself is
  not focusable (Open file is its keyboard path, as today).
- **Keyboard**: all controls are native `<button>` or `<a>`, so Enter and Space work. After a remove,
  focus moves to the next row's open button, else the previous row's, else the "Recent files" h2
  (`tabIndex={-1}`). After Clear list, focus moves to the "Recent files" h2. F6 region cycling is
  unchanged.
- **Screen-reader names**: Open file button `start.open`; card described by the drop text
  (`aria-describedby`, as `documents.test.tsx:235-239` checks); recent open button's name is the
  file name only (the time is linked with `aria-describedby`, so `buttonNamed('first.pdf')` still
  finds it); remove button `aria-label` `start.recent.removeLabel` ("Remove {name} from recent
  files"); Clear list `start.recent.clear`; quick actions their visible labels; the logo `alt=""`.
  A polite live region (the existing `role="status"` hint element) announces
  `start.recent.cleared` after Clear list.
- **Contrast**: only token pairs that `contrast.test.ts` already checks are used for text
  (`text`, `textMuted`, `accentText` on `window`, `surface`, `surfaceAlt`; `onAccent` on `accent`),
  and the focus ring at 3:1. The dashed `borderStrong` outline is decoration (the card is identified
  by its text), so WCAG 1.4.11 does not apply to it; the drag-over border uses `focusRing`,
  not `accent`: `contrast.test.ts` already holds `focusRing` at ≥ 3:1 on every surface for every
  preset, while some dark presets' `accent` is below 3:1 on `surfaceAlt` (for example teal
  `#038387` on `#323232` is about 2.8:1).
- **Motion**: hover and drag-over changes are instant (no transition), so reduced motion needs nothing.

## 5. Strings (`web/app/src/i18n/en.ts` only)

New keys:

| Key | English |
|---|---|
| `start.tagline` | `Read, edit and combine PDFs in your browser. Your files are not uploaded.` |
| `start.drop.or` | `or` |
| `start.quick.heading` | `Quick actions` |
| `start.quick.combine` | `Combine files` |
| `start.quick.compare` | `Compare files` |
| `start.recent.note` | `Elanero keeps only the names. Choose one to pick the file again.` |
| `start.recent.removeLabel` | `Remove {name} from recent files` |
| `start.recent.clear` | `Clear list` |
| `start.recent.cleared` | `Recent files cleared.` |
| `start.footer.version` | `Elanero {version}` |

Changed value: `start.drop` from `Drop PDF files here, or use Open file.` to `Drop PDF files here`
(the "or" and the button follow it).

Unchanged and reused: `app.name`, `start.heading`, `start.open`, `start.recent.heading`,
`start.recent.empty`, `start.recent.opened`, `start.recent.pickAgain`, `start.pending.*`,
`about.title` (footer button), `about.licence`, `about.source`, `brand.logoAlt` (not used by the
decorative hero logo). `app.version` stays for the About overlay. Nothing else changes: no
generated file (`rpc/generated.ts`, `tokens.css`, `icons.generated.ts`, licences) is touched, and
the icons used (`upload`, `folder-open`, `file`, `x`, `combine`, `git-compare`) already exist in
`icons.generated.ts`. The tagline's "not uploaded" claim matches `docs/guide/web.md:13-14`.

## 6. Tests

All web tests run in Vitest (jsdom) and Playwright **Chromium**; none run under Pyodide. Desktop
tests and `tests/golden/` are not touched.

**Vitest** (`start/StartPage.test.tsx`, `documents/documents.test.tsx`, `App.test.tsx`):

- Heading outline: exactly one h1 (`app.name`), it is the first heading, and no level is skipped
  with the engine loading, with pending files and with recent files.
- Footer: shows `start.footer.version`, `about.licence`, a link to `SOURCE_URL` with
  `rel="noopener noreferrer"`; About Elanero calls `onAbout`. With a document open the footer and
  the h1 are gone (update `documents.test.tsx:523-531, 560-564`: they now look in the footer).
- Drop anywhere: a `drop` on the hero or the recent list calls `onFiles`; `dragenter` sets
  `data-dragging`, `dragleave` and `drop` clear it.
- Recent: row button's accessible name is the file name; `aria-describedby` points at the time;
  remove calls `forgetRecent` and moves focus as in §4; Clear list empties the list, shows the empty
  text, announces `start.recent.cleared` and focuses the h2; `recentFiles.test.ts` covers
  `removeRecentFile` and `clearRecentFiles` (including a throwing `localStorage`).
- Quick actions: each button runs its command (`combine-files-into-pdf`, `compare-files`) through
  the same handler as the ribbon.
- Contrast: no new pair; the drag-over border uses `focusRing`, already checked at 3:1 on every
  surface (`contrast.test.ts`). A Vitest check reads `start.css` and fails if the drag-over rule
  uses any colour other than `--color-focus-ring`.
- Must not change (kept as is, must still pass): `documents.test.tsx:211-249` (Open file, keyboard
  reach, drop text, dropped PDF opens a tab) and `:382-405` (recent order, click opens the picker
  and shows the hint), `App.test.tsx:223-232`, `StartPage.test.tsx` (load panel, pending list).

**Playwright, Chromium** (`e2e/`):

- `layout.spec.ts`: extend the start-page loop with 683 × 384 (1366 at 200 %), 911 × 512
  (1366 at 150 %), 1093 × 614 (1366 at 125 %) and 320 × 640; no horizontal scroll at each; the
  column is centred (left and right gaps within 1 px) at ≥ 768 px; the Open file button is at least
  as wide as the card's content at < 768 px.
- A `deviceScaleFactor` 2 run at 1366 × 768 checks the hero logo's natural width ≥ 128 px (sharp).
- `features/keyboard.spec.ts`: the Tab lap still rings every stop; a new test seeds two recent
  names in `localStorage`, Tabs to the first row's remove button, presses Enter and checks focus
  lands on the next row's open button.
- `features/axe.spec.ts`: unchanged test, light and dark, now also with seeded recent names.
- `forced-colours.spec.ts`: one new check that the open card's border is visible under
  `forcedColors: 'active'`.
- **No pixel golden** for the web start page (decision D8): screenshots are attached to the layout
  test as artifacts (light and dark, 1366 and 390 px) for the owner to look at in the PR, not
  compared.
- Must not change: `pwa.spec.ts:103,138` and `file-launch.spec.ts:88` (h1 "Elanero"),
  `open-during-load.spec.ts` and `file-launch.spec.ts:81-82` (`.start-pending` and its rows).

The required checks for each slice: `npm run typecheck`, `npm run lint`, `npm run format:check`,
`npm test` in `web/app`; the Playwright specs above on Chromium (`npx playwright test` and
`npm run e2e:features -- --project=chromium`), reported in the PR body. No Python change, so no
pytest, mypy or `web-pytest` impact.

## 7. Guide pages

`docs/guide/web.md`: a new "The start page" subsection after "Start the web version"
(`web.md:24-38`): opening by button or drop anywhere, the quick actions, recent names (only names
are kept; choosing one opens the picker; remove and Clear list), and the footer's version, licence,
source code and About. The "About Elanero" sentence at `web.md:107-108` gains "also at the bottom of
the start page". Each slice updates the part it ships.

## 8. Slices

Each slice is one PR from `origin/main`, branch `fix-626-start-screen-s<N>`, Haiku implementation,
Sonnet review. Production lines exclude tests and generated files.

| Slice | Content | Production lines (est.) |
|---|---|---|
| **S1: layout and hero** | Centred column; hero (logo, h1, tagline); open card restyle with icon, "or", drag-over state; whole page as drop target; Waiting to open and Recent files headings to h2; footer (version, licence, source link, About button wired to `setAboutOpen`); remove `App.tsx:1241-1247`; CSS for all widths and `pointer: coarse`; keys `start.tagline`, `start.drop.or`, `start.footer.version`, `start.drop` value; guide "The start page" (open and footer parts) | ~230 (StartPage.tsx ~90, start.css ~120, App.tsx ~10, en.ts ~5, guide not counted) |
| **S2: recent rows** | Row layout (icon, name, time as description, open button filling the row); remove button and Clear list; `removeRecentFile`, `clearRecentFiles`; `forgetRecent`, `clearRecent` in `useDocuments`; focus moves and live announcement; note text; keys `start.recent.note`, `start.recent.removeLabel`, `start.recent.clear`, `start.recent.cleared`; guide recent part | ~190 (StartPage.tsx ~70, start.css ~50, recentFiles.ts ~30, useDocuments.ts ~25, en.ts ~5) |
| **S3: quick actions** | Quick actions section with Combine files and Compare files, run through the command handlers (`onCommand(id)` prop from `App.tsx`); keys `start.quick.*`; guide quick-actions part | ~80 (StartPage.tsx ~40, start.css ~25, App.tsx ~5, en.ts ~4) |

S2 and S3 depend on S1 (they edit the same component layout); S2 and S3 are independent of each
other but touch the same files, so they run one after the other to avoid conflicts.

## 9. Risks

- **Transient state without a start page and without a document** (`documentShown` false and
  `showStart` false, e.g. a tab whose session is still being created): today the About block fills
  it; after S1 the page area is empty for that moment. S1 adds a Vitest check that the area is empty
  but not broken, and the tab strip shows the opening tab. If it is visible for long, a follow-up
  can show a spinner there.
- **Page-wide drop** must not swallow drops the load panel or pending list never wanted; they have
  no drop handlers of their own today, so none is lost.
- **Removing the About block** changes the text that `documents.test.tsx:523-531, 560-564` read;
  those tests are updated, not deleted, and still prove the About text is gone with a document.

## 10. Questions for the owner

1. **Keep the About information on the start page at all?** Recommended: yes, as a one-line footer
   (version, licence, source code, About). The source link is the AGPL §13 offer
   (`about.tsx:4-6`), and a visible version helps support.
2. **Add quick actions (Combine, Compare) to the web start page?** Recommended: yes. W1.6 §3 already
   planned them, both work without a document, and they answer "what can I do here".
3. **Remove and Clear list for recent names on the start page?** Recommended: yes. W1.6 §3 planned
   them; today the only way is Clear all local data, which also drops preferences and fonts.
4. **Hero with the large logo?** Recommended: yes, 64 px (48 px on narrow screens). It gives the
   page an identity and the top-bar logo is only 32 px.
5. **Centred column or a two-column layout on wide screens?** Recommended: centred single column,
   720 px max. It reads the same at every zoom and width; two columns would collapse to one at
   150 % zoom on a laptop anyway.
6. **Pixel goldens for the web start page?** Recommended: no. Geometry and axe checks in Chromium
   plus screenshots attached for review; pixel goldens across OS font rendering would be flaky, and
   the web has none today.

## Owner decisions

Decided by the owner's delegate (Opus 5.5) on 2026-11-22, pending the owner's approval of this note:

- **D1** (Q1) About becomes a footer line on the start page; the separate h1/version/About block in
  `App.tsx:1241-1247` is removed. Reason: removes the duplicate version and the unstyled block while
  keeping the AGPL source link visible.
- **D2** (Q5) Centred single column, `max-width: 45rem`. Reason: fixes the empty right half and
  keeps one layout from 320 px to 200 % zoom.
- **D3** "Open a PDF" stays a visible h2 above the card. Reason: it names the main task for sighted
  and screen-reader users alike; hiding it would make the outline and the screen differ.
- **D4** (Q2) Quick actions Combine files and Compare files, nothing else. Reason: the only web
  tools that start without a document (W1.6 §3); Office import and OCR are hidden on the web.
- **D5** (Q3) Per-row remove and Clear list, with explicit buttons rather than a Delete key or
  context menu. Reason: visible, touch-friendly and needs no hidden gesture; the desktop's context
  menu has no good web equivalent on touch.
- **D6** No new tokens; h1 and h2 sizes derive from existing tokens with `calc()`. Reason: the token
  file is generated and mirrors the desktop's `tokens.py`; two derived sizes are not worth changing
  that pipeline.
- **D7** (Q4) Hero logo from `public/icons/elanero-256.png` at 64 px (48 px below 768 px), decorative.
  Reason: identity and warmth with a same-origin image the CSP already allows.
- **D8** (Q6) No pixel golden for the web; Chromium geometry, axe, keyboard and forced-colours
  checks, with screenshots attached as artifacts. Reason: the web has no golden infrastructure and
  cross-platform font rendering would make one flaky.
- **D9** The whole start page accepts dropped PDFs. Reason: a drop beside the small box today falls
  to the browser's default action, which is surprising and can leave the app.
- **D10** The recent row's accessible name stays the file name, with the time as its description.
  Reason: keeps a short, unique name for screen readers and keeps existing tests valid.
- **D11** Three slices (layout, recent rows, quick actions), each well under 400 production lines.

## Corrections to existing docs found while verifying

- `docs/web/design/W1.6.md:80-89` describes the web start page with "a large Open button", quick
  actions (Combine, Compare), a remove button per recent entry and a "Clear" for the list. None of
  these exist on main (`StartPage.tsx:25-121`), yet W4.2b is ticked in `PLAN.md:570` without a
  partial note. This design delivers them (S2, S3); the PLAN note is left to the close-out step.
- `docs/web/design/W1.6.md:176` lists `icons/png/elanero-128.png` as used by the "Start page and
  loading screen". The web start page uses no image, and `web/app/public/icons/` holds only the
  32, 256 and 512 px PNGs.
- `StartPage.tsx:12` says the load stages are "shown in place of the quick actions"; there are no
  quick actions on the web start page today.
