# Preferences

Open **Edit ▸ Preferences…** or press **Ctrl+K**. The dialog has a list of categories on the left and
the settings for the chosen category on the right: **General**, **Appearance**, **Tools**,
**Translation**, **Performance** and **Shortcuts**. Click **OK** to save your changes.

## General

- **Author name**: shown on the comments you add. Set it once so reviewers know who wrote each comment.
- **Language**: the interface language, or **System default** to follow Windows. The change takes
  effect after you restart Elanero. English is the only language in this version; any other
  languages installed with the app appear in this list.
- **Save recovery copies every**: how often unsaved changes are copied to a recovery file, in
  minutes (2 by default; **Off** turns this off). See [Troubleshooting](troubleshooting.md#recovery-copies).
- **Open files in the window that's already running**: off by default, so each file you open from
  File Explorer gets its own window. When on, the file opens as a new tab in the window that is
  already running. This applies to windows opened after the change.
- **Show the splash screen at startup**: on by default. Turn it off to open straight into the
  window; the change applies from the next start.
- **Check the Microsoft Store for updates**: only in the Microsoft Store version of Elanero, where
  it is on by default. Once a day Elanero asks the Store whether a new version is out, and shows an
  **Update available** button when one is. Turn it off and the button stays hidden; **Help ▸ Check
  for Updates** still asks on demand. See [Interface](interface.md#updates).
- **PDF files**: **Register as PDF Editor** adds Elanero to the apps that can open PDFs. When it is
  registered, the button becomes **Remove PDF Registration**. **Choose Default App…** opens Windows
  Settings at **Default apps**. See [Getting started](getting-started.md#make-elanero-the-default-pdf-app).

## Appearance

- **Theme**: **Same as Windows** (the default), **Light** or **Dark**. Windows high-contrast settings
  are followed automatically.
- **Accent color**: **Windows accent color**, or **Custom…** to pick another color.
- **Always show the menu bar**: when off, the menus sit behind the **☰** button, and **Alt** opens
  them. See [Interface](interface.md#menu-bar-and-the-button).
- **Default zoom**: **Fit Width** (the default), **Fit Page** or **100%**. It applies when a document
  is opened.

## Tools

- **Default tool**: the tool that is active when a document opens: **Select** (the default) or **Hand**.
- **Keep tools selected after use**: off by default, so a comment or drawing tool returns to **Select**
  after one use. Turn it on to keep drawing with the same tool.
- **Show mini toolbars**: the small toolbars that appear beside a selection, with copy, translate and
  markup buttons.
- **Recognize text when editing scanned pages**: on by default. **Edit Text & Images** runs OCR on a
  scanned page and replaces the scanned text with real text, so you can double-click a paragraph to
  edit it. See [OCR](ocr.md).

## Translation

The settings for online translation of selected text: whether it is on, which service to use, the
service keys and the default language. See [Translation](translation.md) for each option and what it
sends.

## Performance

- **Page image cache**: the memory used for rendered pages, in MB. The change takes effect after a
  restart.
- **Undo history disk space**: the disk space, in MB (2048 by default), that keeps copies of the
  document so large edits (redaction, OCR and text editing) can be undone.

## Shortcuts

Click **Customize Keyboard Shortcuts…** to open the shortcut editor. Select a command, press the new
keys, and click **Assign**. **Remove** clears a command's shortcut, **Default** restores its default
shortcut, and **Reset All** restores all of them. Elanero warns you if the shortcut is already used
by another command. A shortcut is one key, not a sequence of keys (such as Ctrl+K, then Ctrl+S),
and it can't be Alt with a letter that opens a menu (such as Alt+F for File). The defaults are
listed in [Keyboard shortcuts](keyboard-shortcuts.md).

You can also find a command by name with **Ctrl+Shift+P** (the command palette).
