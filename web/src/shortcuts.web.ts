// The web's shortcut overrides (W1.6 section 9, W4.3b). The shared table (generated/shortcuts.json)
// lists the desktop keys; a browser keeps some of them for itself before the page sees the key
// (Ctrl+W closes the tab, Ctrl+Shift+T reopens a closed tab, Ctrl+Shift+I opens the developer
// tools), so the web binds the command to a replacement or to nothing. A key here replaces the
// shared keys of that command entirely; a command that is not listed keeps the shared keys.
//
// Every id must be a command in the registry (web/app/src/commands/catalog.ts), and a test checks
// it. Go to Page, Next and Previous Document, New Window and Exit are not in the registry yet, so
// their overrides (Alt+G, Alt+PgDn, dropped) wait until those commands exist.
export const WEB_SHORTCUT_OVERRIDES: Readonly<
  Record<string, readonly string[]>
> = {
  // Desktop Ctrl+W and Ctrl+F4: the browser closes its own tab first.
  close: ["Alt+W"],
  // Desktop Ctrl+Shift+T: the browser reopens its last closed tab first.
  "crop-pages": [],
  // Desktop Ctrl+Shift+I: the browser opens its developer tools first.
  "insert-pages": [],
  // Desktop Ctrl+Shift+C: the developer tools' element picker takes the key first.
  "comments-list": [],
};
