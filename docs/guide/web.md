# Web version

Elanero also runs in your web browser, with no installer. It is the same editor as the desktop
app, rebuilt for the browser: the same commands, names and icons, so what you learn here carries
over to the desktop. Most of the web version is still being built. This page describes what works
today and marks what is coming soon.

## How it differs from the desktop app

- **It runs in the browser tab.** Nothing to install on Windows, Mac or iPad: open the web address
  and the editor loads.
- **It works offline after the first load.** The browser keeps the app's own files and the PDF
  engine's files, so the editor opens without a connection. Your documents are never kept by the
  web version (see
  [Where your data is stored](#where-your-data-is-stored)).
- **It can be installed as an app.** The browser can add Elanero to your desktop, dock or home
  screen and open it in its own window.
- **The browser replaces some desktop features.** There is no menu bar and no separate window
  or Exit command: the browser provides them. The app menu (☰) that will hold the remaining menu
  commands is coming soon.
- **Some features are desktop only.** OCR, digital signatures and PDF/A conversion are not planned
  for the web version yet. See the table at the end of this page.

## Start the web version

Open the web version from the Elanero website: the **Open the web version** button on the front
page. The web address is <https://linguagraph.github.io/elanero-pdf-editor/app/>, which becomes
live when the web version is published. Until then the button does not work yet; use the desktop app.

The first visit loads the editor's engine, which takes a little while. Later visits are faster
because the browser keeps the app's files.

You don't have to wait for the engine. You can open or drop a PDF while Elanero starts: it is listed
under "Waiting to open" and opens as soon as the engine is ready. To drop a waiting file, press
**Don't open** beside its name.

## Install the app

Use your browser's own install option. In Chrome and Edge, use the install icon in the address bar
or the browser menu. In Safari, use the browser's **Add to Dock** (Mac) or **Add to Home Screen**
(iPad) option. Elanero's **Install App** command in the app menu is coming soon.

Once installed in Chrome or Edge, Elanero is an **Open with** choice for PDF files. Right-click a PDF
in Explorer (or Finder), choose **Open with**, then **Elanero**: the file opens in a tab. Selecting
several PDFs opens them together, as tabs in one window. If Elanero is already open, the files open
in that window and your open documents stay as they are. Up to 20 files open from one choice; the
others are left for the app's Open button. Other browsers and the plain browser tab have no
**Open with**: use Open or drag and drop.

When a new version of Elanero is ready, a banner appears at the top with a **Reload** button. Nothing
is reloaded until you press it.

## Theme and preferences

- **Theme.** The switch in the top bar chooses **System** (the default: follows your computer's
  light or dark setting, and changes with it), **Light** or **Dark**. The choice is remembered in
  this browser.
- **Preferences.** Click **Preferences** in the top bar. The dialog has three sections:
  - **General**: the language (English is the only one for now) and the **Author name**, which is
    saved with each comment and redaction mark you add.
  - **Appearance**: the theme, and **Reduce motion**, which turns off animations.
  - **Viewing**: **Default zoom** (Fit Width, Fit Page or 100%) and **Default page layout** (Single
    column, Two pages, or Two pages with page 1 alone), both used when a document is opened.
  - **Redaction**: the **Box colour**, **Text colour** and **Text on the box** used for new redaction
    marks (black, white and empty by default). Marks you have already drawn keep their style.
  - **Shortcuts**: **Keyboard Shortcuts…** lists every keyboard shortcut. It opens on top of
    Preferences, and your unsaved changes there are kept.
  - **Privacy**: **Clear all local data…** removes your saved preferences, recent file names and
    uploaded fonts from this browser, then reloads the page. It is turned off while a document is
    open; close the documents first. Your files are not touched, and the recovery copies of other
    open Elanero tabs are kept.

  **Apply** saves your changes; **Cancel**, Esc or a click outside the dialog puts back the saved
  theme. The default zoom applies to the open document at once, and to each document you open. The
  author name is written into each comment and redaction mark you add from now on.

  Zoom above 100% on a high-density screen can ask for more pixels than a page can be drawn at. The
  viewer then draws the page at the largest size it supports, so the page stays visible rather than
  going blank.

## Ribbon and keyboard shortcuts

- **Ribbon.** The ribbon sits under the top bar with the same seven tabs as the desktop (Home, Edit,
  Organize, Protect, Comment, View and Tools). Each command shows its icon above its label, the same
  icon as on the desktop. A command that is not available in the web version yet, or that needs an
  open document, stays visible but greyed out; point at it to see why.
- **Ribbon forms.** The ribbon follows the window width. From 1280 px it shows the full ribbon, with
  icons and labels. From 1024 px to 1279 px it is compact: icons only, with each command's name in
  its tooltip. Below 1024 px the ribbon is collapsed to one row of tabs; each tab opens its commands
  in a drop-down that closes when a command runs. On a narrow window that row scrolls sideways.
- **More commands.** When a tab's groups are wider than the window, the last groups move to a
  **»** (More commands) button at the end of the row. It opens those groups, in the same order,
  and closes when a command runs. A tab with room for all its groups shows no **»**.
- **Collapse and compact.** The chevron at the right of the tab row collapses the ribbon to its
  tabs, and shows it again. Press **Ctrl+F1** to do the same. Pressing a tab, or double-clicking
  one, also brings a collapsed ribbon back. **Compact ribbon** in Preferences (Appearance) shows
  icons only on wide windows as well (1280 px and up). Both choices are kept in this browser.
- **Quick access and help.** Above the ribbon, next to the menu button, the quick-access buttons
  are Select, Hand, Undo, Redo and Save; below 1024 px only Undo, Redo and Save remain. The **?**
  button at the right of the tab row opens this guide at the page for the tab you are on.
- **Search tools.** The box at the right of the tab row (the search icon alone in a narrow window
  or a compact ribbon) opens the command palette. Type in the box and the palette opens already
  filtered by what you typed; the icon opens the palette empty. **About Elanero** in the app menu shows the version, the licence and
  a link to the source code. Close in the app menu closes the open document. The Select, Hand, Undo,
  Redo and Save buttons are greyed out for now, and they work once their commands are added.
- **Keyboard shortcuts.** A few web keys work so far: **Alt+Left** and **Alt+Right** go back and
  forward through the pages you have visited, **Alt+G** (Go to Page) moves the cursor to the page
  box in the status bar, and **Alt+PgDn** and **Alt+PgUp** switch to the next and previous open
  document, wrapping at the ends. Go to Page and the two document keys are also in the command
  palette. The web version will use the desktop's keys wherever the browser allows, and will list
  them in [Keyboard shortcuts](keyboard-shortcuts.md) once the command palette is built (coming
  soon).
  **Keyboard Shortcuts…** in the app menu and in Preferences shows the list that is available now.

## Side panels

- **Thumbnails.** The **Thumbnails** button on the right rail opens a panel with a small preview of
  every page. Click a preview to go to that page. The panel opens and closes for each open
  document separately, and it is not remembered after a reload. Attachments and layers are not
  available yet.
- **Bookmarks.** The **Bookmarks** button on the right rail opens the document's outline as a tree.
  Use the arrow beside an entry to expand or collapse it, and click an entry to go to its page.
  With the keyboard, Up and Down move through the entries, Right and Left open and close them,
  and Enter goes to the page.
  Entries without a page are greyed out. The panel is read-only for now: you cannot add, rename or
  move bookmarks yet. Each open document keeps its own expanded entries until you close it.
- **Organize pages.** The **Organize pages** button on the right rail opens a panel with a
  thumbnail of every page. Click a page to select it, Ctrl-click to add or remove one, and
  Shift-click to select a range. Then rotate the selected pages left or right, move them up or
  down, delete them (after a confirmation; a document always keeps one page), or duplicate them.
  Insert blank page adds an empty page after the last selected page (or at the end when nothing is
  selected), the same size as the page before it. Duplicate puts a copy of each selected page right
  after the last one. Insert from file adds the pages of a PDF, or one image, after the last selected
  page (or at the end when nothing is selected); an encrypted PDF asks for its
  password, up to five times. Extract downloads the selected pages as a new PDF named
  "<name> (extract).pdf"; the document itself does not change. Each change, other than an
  extract, can be undone from the notice that follows it. Dragging pages is not available yet.
  Undo on a notice undoes only that change; if you have changed the document since, nothing is
  undone and the notice says so.

## Going to a page

- **Page box.** The status bar under the document shows the page you are reading. Type a page
  number and press Enter to go to that page. If the number is not in the document, a message says
  which numbers are valid, and the view does not move.
- **Back and Forward.** The **Back** and **Forward** buttons in the status bar return to pages you
  jumped from, or went to from a thumbnail, and go forward again. A small move of one page is not
  recorded, and a new jump after going back clears the forward pages. The history is kept for each
  open document until you reload the page.
- **Page labels and links.** The status bar shows the document's own page labels (such as i, ii, 1),
  and you can type a label into the page field to go to that page. Links in the document do not
  work yet (coming soon).

## What is not available yet

These features are on the desktop today and are planned for the web version. None works in the web
version yet:

- opening, viewing, searching and saving PDF files, and the start page with recent files;
- the ribbon, the command palette and keyboard shortcuts;
- editing text and images, inserting, duplicating and extracting pages, combining, splitting and compressing files;
- comments other than sticky notes, rectangles and highlights, the Comments panel, redaction, stamps and watermarks, password protection, and comparing files;
- the fonts, PDF version and security settings in document properties (the title, author, subject and keywords can be edited; see the table below);
- printing, and translation (which will be turned on only when you ask for it);
- the **Install App** command.

## Browser support

The target is the current Chrome, Edge, Firefox and Safari on a desktop computer, and Safari on iPad
on a best-effort basis. Testing in every one of these browsers is still to come, so report a problem
if you see one.

Saving a document in place needs the browser's File System Access API. The plan is that where the
browser has that API, Save writes back to the original file, and elsewhere Save downloads a copy and
says so. Saving is coming soon, so this is not yet working.

## Where your data is stored

- **Your documents** are held in the memory of the browser tab while they are open. While a document
  has unsaved changes, the web version also keeps an autosave copy in the browser's private storage
  (not in a folder you can see), about once a minute, so the editor can reopen it if the engine
  restarts. The copy is deleted when you close the document, when it has no unsaved changes, and
  when you leave the page. Password-protected documents are never copied, and a document over 200 MB
  is not copied. If the browser has no such storage, or it is full, the app tells you once and keeps
  working without the copy. A browser crash can leave a copy behind; the app does not read it, and
  clearing the site's data removes it. Save or download a file before you close the tab to keep it.
- **Your theme** is kept in the browser's local storage under the name `elanero.theme`.
- **Your preferences** (language, author name, reduce motion and default zoom) are kept in the same
  browser's local storage under the name `elanero.prefs`. **Clear all local data** in the Preferences
  dialog removes every key that starts with `elanero.`, and the uploaded fonts, but keeps other
  sites' data on the same address and the recovery copies of other open tabs.
- **The app's files** are kept by the browser so the editor works offline.

The web version sends nothing to any server while you edit, and has no accounts, analytics or
advertising. Translation, once it is available, is the only outside request, and it is opt-in. The
full policy, with what the desktop app stores, is in the
[privacy policy](https://github.com/linguagraph/elanero-pdf-editor/blob/main/PRIVACY.md), and
[Privacy](privacy.md) summarizes it.

## Desktop and web: what is available

| Feature | Desktop | Web version |
|---|---|---|
| Light, dark and system theme | Yes | Yes |
| Preferences: language, author name, reduce motion, default zoom, default page layout, redaction box style | Yes | Saved; default zoom and page layout apply now; the author name and redaction style apply to the comments and marks you add next |
| Clear all local data (Preferences, Privacy) | Yes | Removes saved preferences, recent file names and uploaded fonts; disabled while a document is open |
| Install as an app | Windows Store or installer | Yes, with your browser's install option |
| Works offline | Yes | Yes once loaded, for the app and the PDF engine's files; the engine's files come with the web version from its first deployment with them (coming soon) |
| Open, view, search and save PDFs | Yes | Coming soon |
| Ribbon, command palette and keyboard shortcuts | Yes | Partly: the ribbon and some Alt keys work; the full palette and shortcut list are coming soon |
| Edit text and images, insert and extract pages, split, combine, compress | Yes | Coming soon |
| Comments: sticky notes, rectangles and highlights | Yes | Yes (Comment tools in the toolbar; Undo after each) |
| Export comments as XFDF, CSV or PDF summary | Yes | Yes (Comment tab, Manage group, Export Comments; the PDF summary may be unavailable) |
| Import comments from an XFDF file | Yes | Yes (Comment tab, Manage group, Import Comments; files up to 8 MB; Undo after each import) |
| Document properties: title, author, subject, keywords | Yes | Yes (command palette, Ctrl+Shift+P; Undo after each change) |
| Other comments, redaction, stamps, watermarks, security | Yes | Coming soon |
| Compare two files (text and appearance) | Yes | Yes (the report saves as a text file, not a PDF) |
| Export pages as text, Markdown, HTML, Word, or images | Yes | Yes (Export, from the Tools group or the command palette) |
| Print | Yes | Coming soon |
| Translation (opt-in) | Yes | Coming soon |
| OCR and batch OCR | Yes | Desktop only (for now) |
| Digital signatures | Yes | Desktop only (for now) |
| PDF/A and accessibility checks | Yes | Desktop only (for now) |

<!--
Evidence for the claims on this page (repository paths, checked on main):
- Web app shell, what is mounted: web/app/src/App.tsx (Ribbon, AppMenu, ThemeSwitch, PreferencesDialog,
  UpdatePrompt, EngineLoadingScreen, ToastRegion).
- Ribbon icons: web/app/src/ribbon/Ribbon.tsx, web/app/src/theme/Icon.tsx, web/app/src/theme/icons.generated.ts
  (from src/pdfeditor/data/icons), web/src/generated/shortcuts.json (desktop icon names).
- Ribbon and app menu: web/app/src/ribbon/Ribbon.tsx, web/app/src/ribbon/AppMenu.tsx,
  web/app/src/commands/run.ts, web/app/src/commands/catalog.ts (seven tabs; app.help group).
- Install App has no handler: web/app/src/commands/catalog.ts ('install-app'); no handler in App.tsx.
- Install (manifest, standalone display): web/app/index.html, web/app/src/pwa/build.ts (buildManifest),
  web/app/vite.config.ts.
- Open with (file_handlers, launch_handler) and the launch queue: web/app/src/pwa/launch.ts,
  web/app/src/pwa/build.ts, web/app/src/main.tsx.
- Offline app files, documents never cached: web/app/public/sw.js, web/app/src/pwa/register.ts,
  web/app/src/main.tsx (service worker registered in production builds only).
- Update banner and Reload: web/app/src/pwa/UpdatePrompt.tsx, web/app/src/pwa/update.ts,
  web/app/src/i18n/en.ts (update.ready, update.reload).
- Theme (system, light, dark; key elanero.theme): web/app/src/theme/theme.ts,
  web/app/src/theme/ThemeSwitch.tsx.
- Preferences dialog and sections (General, Appearance, Viewing; Apply and Cancel; Reduce motion;
  Default zoom): web/app/src/prefs/PreferencesDialog.tsx, web/app/src/i18n/en.ts (prefs.*).
- Preferences store (key elanero.prefs, refuses secret keys, try/catch): web/app/src/prefs/store.ts.
- Preferences opened from the top bar: web/app/src/App.tsx, web/app/src/commands/catalog.ts.
- Autosave copies in the browser's private storage (OPFS): web/app/src/storage/ (opfs.ts,
  autosaveStore.ts, autosaver.ts, tabId.ts); the copy is read from the engine by save.autosave_bytes
  (src/pdfeditor/webapi/save.py). No IndexedDB or file-picker use in web/app/src, web/app/public or
  web/app/index.html (grep); the loader unpacks into the engine's memory file system:
  web/app/src/engine/loader.ts.
- About and source link (AGPL section 13): web/app/src/about.tsx.
- Engine not started yet, loading screen hidden: web/app/src/feedback/LoadingScreen.tsx,
  docs/web/plan.md (W4.4b, W3.1).
- Layout by width: web/app/src/layout/breakpoints.ts, web/app/src/layout/AppFrame.tsx.
- Browser targets, save fallback, File System Access API: docs/web/plan.md ("Other aspects"),
  docs/web/design/W1.6.md.
- Desktop-only features on the web (hidden capabilities ocr, signing, pdfa): docs/web/design/W1.6.md
  section 2.
- Translation is opt-in and the only outside request: PRIVACY.md (web version section), docs/web/plan.md.
- Ribbon tab order and seven tabs: docs/web/design/W1.6.md section 2.
-->
