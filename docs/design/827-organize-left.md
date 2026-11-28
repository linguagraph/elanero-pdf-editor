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
- `src/App.tsx:470`: `rightPanelOpen`. `src/App.tsx:884`: ribbon command `organize-pages` calls
  `openPanel('organizer')`, so it needs no change.
- `src/layout/AppFrame.tsx:161-167`: the right rail `div` (role toolbar, "Right panels") always renders.
- Desktop, reference only (not changed): `src/pdfeditor/ui/main_window.py:303-311` (the desktop's
  left and right `SidePanels`) and `src/pdfeditor/ui/organize.py`.

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

- `src/layout/sidePanels.test.ts:19-30` expects `organizer: 'right'`; `:41-47` and `:58` read
  `openPanelOf('right')`.
- `src/App.test.tsx:420-455` expects seven left panels and `['organizer']` in `.app-rail-right`;
  `:1516-1563` asserts `#app-panel-right`.
- `e2e/layout.spec.ts:161-171` (`LEFT_RAIL_PANELS`, seven entries): add `organizer`.
- `e2e/layout.spec.ts:191-205` expects one right rail button: retarget to the left rail's
  organizer button (the test is about icons fitting).
- `e2e/layout.spec.ts:139` and `:148-157` check the right rail is visible at the right edge: still
  true with the empty rail, kept.
- `src/layout/railButton.test.tsx`: uses `PANEL_SIDE`, unchanged.
- `e2e/visual-ui.spec.ts:126-141` finds the button by title: still works.

## Goldens that will change (tests/golden/web/linux)

- `organizer-light.png`, `organizer-dark.png`: the panel moves left.
- `document-*.png`, `night-reading-*.png`, `header-footer-*.png` (light and dark): the left rail
  gains an icon and the right rail is empty.
- `start-*.png`: none (rails hidden on the start page).

PNGs are not regenerated here; a web-e2e update run (the `web-ui-snapshots` artifact) refreshes them.

## Checks and risks

- Production change about 40 lines, under the 400 cap. Tests and docs do not count.
- Guide: `docs/guide/web.md` Side panels. The organizer bullet says "right rail" and becomes "left
  rail". The Thumbnails and Bookmarks bullets also say "right rail" but are already on the left; they
  are corrected in the same edit.
- Tablet and phone keep the left `drawer`, so the organizer opens as a drawer there, like the other
  left panels.
- The empty right rail stays as a 48 px column; that is a follow-up.

## Owner questions

1. Remove the empty right rail and its breakpoint flag in a follow-up? Recommended: yes.
