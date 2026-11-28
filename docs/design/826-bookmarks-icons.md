# Bookmarks panel: icon buttons that take less space (#826)

**Status: approved in the one-PR flow; implemented in this PR.**

Line numbers in this note refer to 50e87fb (main before this PR).

## Verified status (main at 50e87fb)

- Toolbar is text buttons: `web/app/src/bookmarks/BookmarksPanel.tsx:581-657` builds
  `toolbarButtons` (Add, Add Child, Rename, Delete, Move Up, Move Down, Indent, Outdent,
  Set to Current Page), each with `label` from `t('bookmarks.*')`. `:684-705` renders
  `<button className="bookmarks-action">{button.label}</button>` with a `title` tooltip.
- Container: `:676-681` (`role="toolbar"`, `aria-label` = `bookmarks.actions`); empty-state text button `:509-516` stays.
- Styles: `web/app/src/bookmarks/bookmarks.css:94-123`. `.bookmarks-action` has
  `min-height: 44px` and text padding.

## Model: Organize pages panel

- `web/app/src/organizer/OrganizerPanel.tsx:64-79`: `OrganizerAction` is an icon-only react-aria
  `Button` with `aria-label={label}`, a `TooltipTrigger`/`Tooltip`, and `<Icon size={20} />`.
- Toolbar: `OrganizerPanel.tsx:431-486` (`role="toolbar"`, one icon per action).
- `web/app/src/organizer/organizer.css:18-41`: `.organizer-action` is a 32 px square; a
  `(pointer: coarse)` rule uses `var(--size-touch-target)` (44 px, `theme/tokens.css:49`).

## Design

1. Each toolbar button is icon-only. Keep the native `title` tooltip (the disabled-hint logic
   already lives there); no react-aria change, so the diff stays small.
2. Accessible name: `aria-label={button.label}`, the same string as the visible text today.
   `aria-keyshortcuts` and `title` are unchanged.
3. Icons, all existing (checked in `theme/icons.generated.ts`):
   Add `bookmark-plus`; Add Child `plus`; Rename `pencil`; Delete `trash-2`;
   Move Up/Down `chevron-up`/`chevron-down`; Indent/Outdent `arrow-right`/`arrow-left`;
   Set to Current Page `map-pin`. No icon is missing.
4. Size: 24 px square on fine pointers, icon 16 px; `(pointer: coarse)` gives 44 px
   (`var(--size-touch-target)`), as the Organize panel does.
5. Unchanged: `role="toolbar"`, its name, disabled states, click handlers, the empty-state text button.
6. Strings: no new keys (existing `bookmarks.*` labels). No inline style or script. No generated
   file changes.
7. `docs/guide/web.md:203-216` names the buttons by text; one sentence is added that the toolbar
   buttons are icons whose names show as tooltips.

## Test changes

- `web/app/src/bookmarks/BookmarksPanel.test.tsx:470-476` (`buttonNamed`) and `:584` match
  `textContent`; they change to `aria-label`.
- New assertion: each toolbar button renders an `svg.icon` and no visible text.
- E2E `web/app/e2e/features/bookmarks.spec.ts:62-65` uses `getByRole('button', { name, exact })`;
  the accessible name is unchanged, so no spec edit. Web-e2e run still needed (not run here).

## Goldens

- None. No golden under `tests/golden/web/linux` shows the bookmarks panel (organizer, start,
  document, header-footer, night-reading only). `web/app/e2e/layout.spec.ts:163` checks the panel
  name, not pixels.

## Risks and owner questions

- 24 px targets are below 44 px on fine pointers, per the issue spec. Each button keeps its
  tooltip and accessible name.
- "Add Child" uses `plus`, the nearest existing icon. Recommended answer: keep it.
