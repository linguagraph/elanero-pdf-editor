# Stamp buttons consolidation: one split button (issue #801)

**Status: proposed, for owner approval; no production code in this change.**

Issue #801 ("Stamp buttons consolidation"): "I want the two stamp buttons to be merged into one with a
drop-down part as it is in the desktop app." The issue has two screenshots (declared 800 by 412 and
840 by 654 px). I could not view them; this note works from the text and the code.

## 1. Verified status on `origin/main` (`a68e365`)

### 1.1 The web: two separate buttons in the Comment tab's Comments group

| Part | Evidence |
| --- | --- |
| Button 1, the Stamp toggle | The registry command `stamp` (`web/app/src/commands/catalog.ts:328-331`), label `command.stamp.label` = "Stamp" (`web/app/src/i18n/en.ts:338`), group `comment.comments`, `checked` while `commentTool === 'stamp'`. The ribbon draws it as a `ToggleButton` with the `stamp` icon (`web/app/src/ribbon/Ribbon.tsx:450-531`, toggle at `:504`). Its handler toggles the stamp tool with the stamp last chosen in the menu (`web/app/src/App.tsx:841-846`, `toggleCommentTool` in `web/app/src/comments/tools.ts:79-85`). |
| Button 2, the Stamp menu | `StampMenu` (`web/app/src/comments/stampTool.tsx:51-212`): a react-aria `MenuTrigger` whose trigger is a text `Button` "Stamp" with the accessible name `stamp.menuButton` = "Stamp options" and class `stamp-menu-button` (`:138-141`; `en.ts:1164-1166`). The menu (`aria-label` "Stamps") lists the 14 `STANDARD_STAMPS` (`web/app/src/comments/stamps.ts:6-21`), then the custom stamps with thumbnails in a section, a separator, **Add Custom Stamp…** and the **Remove Custom Stamp** submenu (`stampTool.tsx:142-209`). Choosing an item calls `onChoose`, which sets the stamp and turns the stamp tool on (`web/app/src/view/DocumentView.tsx:541-546`). |
| Where the menu is drawn | Not next to the toggle: it is a *group extra*, drawn after all the group's commands (`App.tsx:943-953`, `Ribbon.tsx:426` in `RibbonGroup`, `:398-434`). The Comments group is Sticky Note, Text Box, Callout, Stamp, Attach File (`catalog.ts:316-335`), so the menu button sits after **Attach File**, not beside **Stamp**. |
| Styling of the menu button | No ribbon rule styles `.stamp-menu-button` (only `.stamp-menu-thumb`, `web/app/src/ribbon/ribbon.css:213-219`). It is not a `.ribbon-command`, so it misses the ribbon's hover, pressed, focus ring and the coarse-pointer 44 px minimum (`ribbon.css:113-157`, `:475-480`). |
| The chosen stamp | Per document view: `useState<ChosenStamp>(DEFAULT_STAMP)` (`DocumentView.tsx:518-520`), `DEFAULT_STAMP` = Approved (`stamps.ts:36`). A removed custom stamp that was current falls back to Approved and turns the tool off (`stamps.ts:41-48`). |
| Shortcut | None (`docs/guide/keyboard-shortcuts.md:137`: "Stamp \| None"). |

So today the web has the two buttons the issue describes: a "Stamp" toggle and a separate "Stamp"
text button that opens the menu, two places apart.

### 1.2 The desktop: one split button

| Part | Evidence |
| --- | --- |
| Action | `("stamp", "Sta&mp", "stamp")` in `COMMENT_TOOLS` (`src/pdfeditor/ui/main_window.py:142-159`, `:150`); a checkable `QAction` (`:485-490`). |
| Menu | `self.stamp_menu = StampMenu(...)`; `self.tool_actions["stamp"].setMenu(self.stamp_menu)` (`main_window.py:491-493`). `StampMenu` (`src/pdfeditor/ui/stamp_menu.py:35-94`) is rebuilt on `aboutToShow`: the 14 standard stamps, a separator, the custom stamps with icons, **Add Custom Stamp…**, the **Remove Custom Stamp** submenu (disabled when empty). |
| Button form | The action goes into the Comments ribbon group's `QToolBar` (`main_window.py:779-782`). The ribbon does not set a popup mode for it, so Qt's default for an action with a menu applies. I checked it with PySide6 offscreen: a `QToolBar` button for a checkable action with a menu gets `ToolButtonPopupMode.MenuButtonPopup`, i.e. a **split button**: the main part triggers the action, a separate arrow part opens the menu. (Organize's Marks buttons set the same mode explicitly, `src/pdfeditor/ui/organize.py:196-200`.) |
| Main part | `tool_clicked("stamp")` (`main_window.py:1575-1580`): turns the stamp tool on, or off when it is already on. It places `self.stamp_name` (`:1560-1561`). |
| Default stamp | `self.stamp_name = STANDARD_STAMPS[0]` = Approved at start (`main_window.py:491`); after that, the **last stamp chosen in the menu** (`choose_stamp`, `:1446-1448`). Not kept across launches. One per window, not per document. |
| Menu choice | Always (re)starts the tool, never toggles it off (`main_window.py:1448`). |
| Keyboard | Space or Enter on the focused button triggers the main part. I did not verify a key that opens a `MenuButtonPopup` menu from the keyboard on the desktop. |

The web's menu content and the default rule (Approved, then the last chosen) already match the
desktop. The only gap is the form: two buttons apart instead of one split button.

## 2. Design

### 2.1 What the user sees

One **Stamp** control in the Comments group, in Stamp's current place (between Callout and Attach
File), with two parts that look like one button:

- **Main part**: the `stamp` icon and the "Stamp" label (icon only in the compact form, as other
  commands). Pressing it toggles the stamp tool with the current stamp: Approved at first, then the
  last stamp chosen from the menu. This matches the desktop. It stays the registry command `stamp`,
  so quick access, Search tools and the pressed state keep working unchanged.
- **Arrow part**: a narrow `chevron-down` button joined to the main part's right edge (a shared
  border, one hover outline around both on hover). It opens the existing stamp menu, unchanged: the
  14 standard stamps, the custom stamps with thumbnails, Add Custom Stamp…, Remove Custom Stamp.
  Choosing a stamp makes it the current stamp and turns the tool on (as now and as the desktop).

The separate "Stamp" text button after Attach File goes away.

### 2.2 Markup and semantics

ARIA has no split-button role; the usual pattern is two adjacent buttons:

```
<span class="ribbon-split" data-command-split="stamp">
  <ToggleButton class="ribbon-command" aria-pressed …>Stamp</ToggleButton>        (main part)
  <MenuTrigger>
    <Button class="ribbon-split-arrow stamp-menu-button"
            aria-label="Stamp options" aria-haspopup="menu" aria-expanded>chevron</Button>
    <Popover><Menu aria-label="Stamps">…</Menu></Popover>
  </MenuTrigger>
</span>
```

- Accessible names: main part "Stamp" (`command.stamp.label`); arrow "Stamp options"
  (`stamp.menuButton`, existing key); menu "Stamps" (`stamp.menuLabel`). react-aria's `MenuTrigger`
  sets `aria-haspopup="menu"` and `aria-expanded` on the arrow. No new strings are needed unless the
  owner accepts question 2 (one new key through `t()` in `en.ts`).
- Keyboard: both parts are stops in the ribbon's react-aria `Toolbar` (`Ribbon.tsx:200`), so Left and
  Right move between them as between other commands, and Tab leaves the ribbon. On the arrow,
  Enter, Space or Down opens the menu with focus on the first item, Up with focus on the last
  (react-aria `useMenuTrigger`). In the menu: arrows, Home and End, typeahead, Right into the Remove
  submenu, Escape closes. Focus returns to the arrow when the menu closes, by Escape or by a choice.
- Tooltip in the compact form: the main part keeps the command's tooltip; the arrow gets a tooltip
  "Stamp options" from the same key.

### 2.3 Ribbon mechanism

`RibbonGroup` can draw an extra only after all of a group's commands. Add a generic, optional
`commandMenus?: Readonly<Partial<Record<string, ReactNode>>>` prop on `Ribbon`, keyed by command id
and passed down like `groupExtras` (full row, the "»" overflow menu, and the collapsed tab popover).
When a command has an entry, `RibbonGroup` wraps its `CommandButton` and the entry in the
`.ribbon-split` span. `App.tsx` moves `<StampMenu …/>` from `groupExtras['comment.comments']` to
`commandMenus.stamp`; `groupExtras` keeps the Protect mark count. `StampMenu`'s trigger changes from
the text "Stamp" to the chevron icon with the `ribbon-split-arrow` class; the menu body does not change.
The `stamp-menu-button` class stays on the arrow so the e2e spec keeps its locator.

In the collapsed popover a menu choice should also close the popover, as a command press does
(`onRun`). `StampMenu` gets an optional `onChosen` callback for that; the ribbon passes it.

### 2.4 Style (`ribbon.css`)

- `.ribbon-split`: `display: inline-flex; align-items: stretch`. The main part drops its right
  radius and the arrow its left radius; they share one border. Hover on either part outlines both.
- `.ribbon-split-arrow`: the `.ribbon-command` colours, focus ring and disabled look, width about
  16 px plus padding on a fine pointer, full height of the main part.
- Pressed: the accent border shows on the main part only (the arrow is not a toggle).
- Coarse pointer: the arrow gets `min-width` and `min-height` of `var(--size-touch-target)` (44 px),
  like `.ribbon-command` (`ribbon.css:475-480`). This fixes today's under-size menu button too.
- Forced colours: the arrow joins the existing `@media (forced-colors: active)` block
  (`ribbon.css:468-473`): `ButtonText` icon, `Highlight` focus and hover outline, the shared
  border in `CanvasText`.
- Disabled (no document): the whole split is not drawn today without a document (`App.tsx:947`);
  the main part keeps its disabled reason as now, the arrow is not drawn.

## 3. Slice plan

One slice, about 120 to 180 production lines (cap 400):

- `web/app/src/ribbon/Ribbon.tsx`: the `commandMenus` prop, passed to the row, the overflow menu and
  the collapsed body; the `.ribbon-split` wrapper in `RibbonGroup`; the arrow's compact tooltip.
- `web/app/src/ribbon/ribbon.css`: the split, arrow, coarse-pointer and forced-colours rules.
- `web/app/src/comments/stampTool.tsx`: the chevron trigger and class, the optional `onChosen`.
- `web/app/src/App.tsx`: `commandMenus.stamp` instead of the group extra.
- `docs/guide/comments.md` (lines 28-30 and 42-49) and `docs/guide/web.md` (lines 451 and 497):
  "the Stamp menu beside the tools" becomes "the arrow on the Stamp button".

If the owner accepts question 2, its description adds about 15 lines to the same slice.

## 4. Tests and where each runs

| Test | Where | Change |
| --- | --- | --- |
| `web/app/src/App.test.tsx:1188-1192` "the Comment tab has the Stamp menu" | Vitest (`npm test`) | Still passes on the class. Extend: the arrow is the next sibling of `[data-command="stamp"]` inside `.ribbon-split`, has `aria-haspopup="menu"`, and no other "Stamp" text button is in the group. |
| `web/app/src/comments/stampTool.test.tsx` (14 tests, e.g. `:45`, `:339-345`, `:453`) | Vitest | They find the trigger with `container.querySelector('button')` and do not assert its text, so they keep passing. Add: the trigger's accessible name is "Stamp options", it holds the chevron icon, focus returns to it after Escape and after a choice, `onChosen` is called after a choice. |
| `web/app/src/ribbon/ribbon.test.tsx` (groupExtras test at `:722-733`) | Vitest | Unchanged. Add: a `commandMenus` entry is drawn right after its command in the row, in the "»" overflow copy, and in the collapsed popover; Left and Right move main part to arrow to the next command. |
| `web/app/src/commands/commands.test.ts:647-662` "the stamp command" | Vitest | Unchanged: the main part is still the `stamp` command. |
| `web/app/e2e/features/stamps-custom.spec.ts:33-37` `openStampMenu` | Playwright feature round trips (`npm run e2e:features:chromium`, nightly on three browsers) | Keeps working through `.stamp-menu-button` and the "Stamp" menu name. Add one check that the main part places Approved by default and, after choosing Draft from the arrow, the main part (toggled off and on) places Draft. |
| `web/app/e2e/features/touch-targets.spec.ts:86` | Playwright `@a11y`, coarse pointer | Today it sweeps only the default tab, so the Comment tab is never measured. Add a sweep of the Comment tab (or its collapsed popover at the tablet tier): both parts at least 44 by 44. |
| `web/app/e2e/features/axe.spec.ts` | Playwright `@a11y` (`web-a11y`, on demand) | Add one axe run with the Comment tab shown and one with the stamp menu open. |
| `web/app/e2e/forced-colours.spec.ts` | Playwright | Add the arrow's visible border and focus outline under `forced-colors: active`. |
| `npm run typecheck`, `lint`, `format:check` | CI `web` job | Required. |

No test breaks by itself on the planned change. What would break if the `stamp-menu-button` class or
the "Stamp" menu name were dropped: `App.test.tsx:1191` and `stamps-custom.spec.ts:35-36`. The
design keeps both. Pyodide (`web-pytest`) is not affected: no engine or `webapi` change.

## 5. Risks

- **Overflow and collapsed forms.** The split must appear in all three places a group is drawn
  (`Ribbon.tsx:200-222`, `:286`, `:313-340`); missing one brings back a lone Stamp. The ribbon tests
  above cover each.
- **Group width.** The arrow adds about 20 px (fine) or 44 px (coarse) to the Comments group, minus the
  removed text button (wider), so the group gets narrower; overflow measurement (`useGroupOverflow`)
  needs no change.
- **Popover inside a popover.** In the collapsed form the stamp menu opens from inside the tab's
  popover. react-aria supports nested popovers; the e2e check at the tablet tier covers it.
- **Focus after Add Custom Stamp.** The file picker takes focus; on return focus should land on the
  arrow, not the body. The unit test checks it with the picker mocked; the real picker is checked by
  hand.
- **Per-document stamp.** The web keeps the current stamp per document view; the desktop per window.
  Unchanged by this design (question 3).

## 6. Questions for the owner

1. **Default for the main part.** Recommended: Approved at first, then the last stamp chosen from the
   arrow, as now and as the desktop. Not the stamp last *placed* (the same thing in practice) and not
   kept across sessions (the desktop does not keep it either).
2. **Should the main part say which stamp it will place?** Recommended: yes, as a hidden description
   only ("Places: Draft", one new `t()` key), so a screen reader user hears it; no visible change, as
   the desktop shows none. Saying no leaves the slice smaller and still meets the issue.
3. **One current stamp per window, as the desktop, instead of per document?** Recommended: no, keep
   per document for now; it is outside the issue's scope and changes `DocumentView` state.
4. **Mark the current stamp in the menu (a check)?** Recommended: no, the desktop does not; a later
   issue can add it.

None of these blocks the slice: with the recommended answers it can start once the note is approved.

## 7. Not verified

- The two screenshots in the issue (not viewable here); I assumed they show the web's two buttons and
  the desktop's split button.
- No browser run: the look of the joined parts, react-aria's arrow-key behaviour inside the ribbon
  `Toolbar`, and nested popovers in the collapsed form are from the code and react-aria's documented
  behaviour, not observed.
- The desktop's keyboard path to the arrow's menu, and the desktop button's exact drawing in the
  ribbon's text-under-icon style.
