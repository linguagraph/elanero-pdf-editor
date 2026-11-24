# Web version: accessibility

The web version of Elanero is built to meet WCAG 2.2 AA. This page lists the features that help
people who use the keyboard, a screen reader, high-contrast colours or a touch screen, and says
where they stop. It covers the web version only; for the desktop app, see [Interface](interface.md)
and [PDF/A and accessibility](pdfa-accessibility.md).

## Use the keyboard

- **Tab** and **Shift+Tab** move between the controls of the screen you are on.
- **Skip to document.** This link is the first stop on the page. Press Enter on it to jump past the
  header, the side rails and the panels straight to the document.
- **F6** and **Shift+F6** move the focus between the main areas of the window, one at a time: the
  ribbon, the side panels, the page, the right-hand panel, the status bar and the notifications.
  Each area remembers where the focus was, so F6 returns you to the same control. An area with
  nothing to focus is skipped. F6 does nothing while a dialog is open, so the dialog keeps the focus
  until you close it.
- **Esc** closes a side panel or a dialog. When a panel closes, the focus goes back to the button
  that opened it. When a dialog closes, the focus returns to the control that was focused before it.
- Within the ribbon, **Left** and **Right** switch tabs, and **Tab** moves through the buttons of the
  current tab (see [Interface](interface.md#moving-between-regions-with-the-keyboard)).

Most controls show an outline when they have the focus.

## Screen readers

The ribbon is a set of tabs, and each tab's buttons are grouped in toolbars. A button that switches
a tool on or off says whether it is on. The side rails are labelled, the document area is named
**Document**, and each page is announced as **Page N of M**. A link to a page of the document is in
the Tab order of its page and has a name that says where it goes, such as "Go to page iv". A web
or mail link is in the Tab order too, and its name gives the host or the address. Enter follows a
link, and a message says when a link does nothing.

Some limits apply. A PDF page is drawn as an image, so a screen reader reads only the text layer
over it. A scanned page with no text is announced by its page number alone. The web version does
not check or add PDF tags; use the desktop app for the accessibility checks of a document (see
[PDF/A and accessibility](pdfa-accessibility.md)).

## High-contrast colours (Windows)

When Windows high-contrast mode is on, the web version uses the system's colours for its text,
borders, buttons and focus outlines, so they keep their contrast. The document view and the ribbon
keep the borders and outlines that show which tab, button or page is selected.

In this mode the accent colour you chose in Preferences is replaced by the system's highlight
colours, so the accent shows again only when high contrast is off.

## Reduced motion

When Windows is set to reduce animations, the web version turns off its transitions and animations
in the app frame, the feedback messages and the canvas controls.

The **Reduce motion** switch in **Preferences** turns the same animations off, whether or not your
system's setting is on. Its change shows at once; **Cancel** puts back the saved choice.

## Touch screens

On a touch screen, the ribbon buttons and tabs and the buttons of the document view toolbar are at
least 44 × 44 pixels, and the document tabs are at least 44 pixels high. Other controls are not
yet held to that size.

When you select text, the size of the selection (its characters, and its pages when it covers more
than one) is announced to a screen reader, politely, after each selection is made.

## Known limits

- The page image has no accessible content of its own; a screen reader reads only its text layer
  and its page number.
- Keyboard and screen-reader checks are done by hand before each release, and the automated checks
  cover the start page, the dialogs and colour contrast. Passing them does not mean every screen
  has been tested.
- To report an accessibility problem, use the steps in [Troubleshooting](troubleshooting.md), and
  say which browser and screen reader you used.
