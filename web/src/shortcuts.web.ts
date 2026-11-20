// The web's shortcut overrides (W1.6 section 9, W4.3b). The shared table (generated/shortcuts.json)
// lists the desktop keys; a browser keeps some of them for itself before the page sees the key
// (Ctrl+W closes the tab, Ctrl+Shift+T reopens a closed tab, Ctrl+Shift+I opens the developer
// tools), so the web binds the command to a replacement or to nothing. A key here replaces the
// shared keys of that command entirely; a command that is not listed keeps the shared keys.
//
// Every id must be a command in the registry (web/app/src/commands/catalog.ts), and a test checks
// it. New Window and Exit are not overrides: they are dropped commands (DROPPED_IDS in catalog.ts),
// so they have no key on the web at all.
export const WEB_SHORTCUT_OVERRIDES: Readonly<
  Record<string, readonly string[]>
> = {
  // Desktop Ctrl+Shift+N: the browser opens a new private window first. Alt+G is the page field.
  "go-to-page": ["Alt+G"],
  // Desktop Ctrl+Tab: the browser switches its own tabs first. Alt+PgDn is the next document.
  "next-document": ["Alt+PgDn"],
  // Desktop Ctrl+Shift+Tab: the browser switches its own tabs first. Alt+PgUp is the previous one.
  "previous-document": ["Alt+PgUp"],
  // Desktop Ctrl+W and Ctrl+F4: the browser closes its own tab first.
  close: ["Alt+W"],
  // Desktop Ctrl+Shift+T: the browser reopens its last closed tab first.
  "crop-pages": [],
  // Desktop Ctrl+Shift+I: the browser opens its developer tools first.
  "insert-pages": [],
  // Desktop Ctrl+Shift+C: the developer tools' element picker takes the key first.
  "comments-list": [],
};
