# Organize pages panel: move to the left stack (issue #827)

**Status: approved in the one-PR flow; implementation follows in this PR.**

## Where it is today (origin/main 50e87fb, web/app)

- `src/layout/sidePanels.ts:21-30`: `PANEL_SIDE.organizer = 'right'` (the other seven are `'left'`).
  The store (`openPanel`, `togglePanel`) dispatches on this map; there is no other panel list.
- `src/App.tsx:1000-1054`: left rail buttons, in JSX order: pages, bookmarks, attachments, layers,
  redactions, search, comments.
- `src/App.tsx:1154-1162`: right rail, holding only the organizer `RailButton`
  (`controlsId` `app-panel-right`).
- `src/App.tsx:1163-1180`: `rightPanel` renders `<OrganizerPanel>` when `rightPanelOpen === 'organizer'`.
- `src/App.tsx:470` (`rightPanelOpen`); `src/App.tsx:884` (ribbon `organize-pages` calls
  `openPanel('organizer')`, no change needed).
- `src/layout/AppFrame.tsx:161-167`: the right rail `div` always renders.
- Desktop, reference only: `src/pdfeditor/ui/main_window.py:303-311` (not changed).

## What moves

1. `PANEL_SIDE.organizer` becomes `'left'` (its comment is updated).
2. The organizer `RailButton` goes into the left rail after Comments, with `controlsId` `app-panel-left`.
3. `<OrganizerPanel>` moves from `rightPanel` to `leftPanel` (a new branch after Comments);
   `onClose` becomes `closePanel('left')`.
4. The `rightRail` prop is dropped from `<AppFrame>`, so the right rail is empty.

## Default order

Left rail: Pages (default open), Bookmarks, Attachments, Layers, Redactions, Search, Comments,
**Organize pages** (last). Appending keeps the existing order and follows how the other left panels
are registered. No panel opens on the right by default any more.

## Tests that depend on the position

- `src/layout/sidePanels.test.ts:19-58`: `organizer: 'right'` and `openPanelOf('right')`.
- `src/App.test.tsx:420-455` (`['organizer']` in `.app-rail-right`) and `:1516-1563`
  (`#app-panel-right`).
- `e2e/layout.spec.ts:161-171` (`LEFT_RAIL_PANELS`): add `organizer`.
- `e2e/layout.spec.ts:191-205`: expects one right rail button; retarget to the left organizer button.
- `e2e/layout.spec.ts:139`, `:148-157`: right rail visible at the edge; still true, kept.
- `src/layout/railButton.test.tsx`, `e2e/visual-ui.spec.ts:126-141`: unaffected.

## Goldens that will change (tests/golden/web/linux)

- `organizer-light.png`, `organizer-dark.png`: the panel moves left.
- `document-*`, `night-reading-*`, `header-footer-*` (light and dark): left rail gains an icon.
- `start-*`: none (rails hidden on the start page).

PNGs are not regenerated here; a web-e2e update run (`web-ui-snapshots`) refreshes them.

## Checks and risks

- Production change about 40 lines, under the 400 cap.
- Guide `docs/guide/web.md` Side panels: organizer bullet "right rail" becomes "left rail"; the
  Thumbnails and Bookmarks bullets say "right rail" but are already on the left, so they are fixed too.
- Tablet and phone keep the left `drawer` for the organizer.
- The empty right rail stays as a 48 px column; follow-up.

## Owner question

1. Remove the empty right rail and its breakpoint flag in a follow-up? Recommended: yes.
