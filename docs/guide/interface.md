# Interface

Elanero's window has five parts, from top to bottom: the **menu bar**, the **ribbon**, the
**document tabs**, the **page** with its side panels, and the **status bar**.

## Menu bar and the ☰ button

The menu bar has these menus: **File**, **Edit**, **View**, **Pages**, **Go**, **Tools** and
**Help**. Most commands are in one of them, with their shortcuts shown beside them; the rest are on the ribbon.

If you hide the menu bar (**View ▸ Menu Bar**, or **Always show the menu bar** off in
[Preferences](preferences.md#appearance)), the same menus sit behind the **☰** button at the far
left of the ribbon. Press **Alt** and a menu letter (for example **Alt+F** for File) to open a menu
without showing the bar.

## The ribbon

The ribbon is the row of buttons below the menu bar. Its tabs are:

| Tab | What it holds |
| --- | --- |
| **Home** | File (Open, Save, Print, Properties), History (Undo, Redo), Tools (Select, Hand), Search (Find), Navigate (Back, Forward, Previous, Next) |
| **Edit** | Edit (Edit Text & Images), Add (Text, Image), Shapes (Rectangle, Ellipse, Line), Objects (Replace, Export, Delete) |
| **Organize** | Organize (Organize Pages), Pages (Insert, Delete, Duplicate, Rotate Left, Rotate Right), Assemble (Extract, Replace, Split, Combine), Page Setup (Crop, Labels), Marks (Header & Footer, Bates, Watermark, Background) |
| **Protect** | Redact (Redact, Find Text, Mark Pages, Properties, Apply), Clean Up (Sanitize), Security (Encrypt, Remove), Sign (Place, Sign, Request) |
| **Comment** | Text Markup, Comments, Drawing and Manage groups; see [Comments and review](comments.md) |
| **View** | Zoom, Page Display, Reading (rotate view, Night) |
| **Tools** | Recognize Text (OCR, Batch OCR), Export (Export, Images, Fonts), Create (From Office), Optimize (Reduce Size, Space Usage), Compare, Standards (Preflight, Save PDF/A, Accessibility, Auto-Tag) |

Click a tab to show its buttons. Double-click a tab, or click the collapse button at the right of
the tab row, to **collapse** the ribbon to its tab row; **Ctrl+F1** (**View ▸ Collapse Ribbon**)
does the same from the keyboard. While the ribbon is collapsed, clicking a tab shows its buttons
again.

Under **View ▸ Compact Ribbon** the buttons show icons only, which saves room on small screens.

Many buttons are disabled until a document is open. In a window too narrow for every button, the
buttons that don't fit move into a **»** menu at the end of the group row.

### Quick actions

Just left of the tabs are the quick actions: **Select Tool**, **Hand Tool**, **Undo**, **Redo** and
**Save**. They are always visible.

### Search tools

At the right of the tab row is the **Search tools…** box. Type part of a command name and choose
the result to run it; the same search is in the command palette (**Ctrl+Shift+P**). In a narrow
window the box shrinks to a button.

### Help

The **?** button, between the search box and the chevron, opens this user guide (**F1**).

## Side panels

Two columns of panel buttons sit beside the page.

- **Navigation panels (left):** Pages (thumbnails), Bookmarks, Comments, Search, Attachments,
  Layers, Signatures, Redactions, Accessibility and Tags. Click an icon to open its panel; click it
  again to close the panel. **F4** (**View ▸ Navigation Pane**) shows or hides the whole column.
- **Properties (right):** the properties of the selected object or comment. **Ctrl+E**
  (**View ▸ Properties Panel**) opens or closes it.

## Document tabs

Each open document has a tab above the page. Click a tab to switch to it, or press **Ctrl+Tab** and
**Ctrl+Shift+Tab** (**Go ▸ Next Document** and **Previous Document**). Click the **×** on a tab to
close that document; Elanero asks before discarding unsaved changes.

## The start page

With no document open, the start page shows the open button, the quick actions for the tools that
work without a document, and the recent files. Right-click a recent file to pin it to the top of
the list or remove it from the list. See [Getting started](getting-started.md).

## Modes and the status bar

Some tools stay active after you use them, such as **Edit Text & Images**. A banner above the pages
names the active mode and says how to finish: press **Esc** or click **Done**. **Esc** always returns
to the **Select** tool. Preferences decide whether comment and drawing tools go back to Select
after one use; see [Preferences](preferences.md#tools).

The status bar at the bottom shows the active tool. Long-running work such as OCR runs in the
background; its progress appears at the right of the status bar, and you can keep working.

## Moving between regions with the keyboard

**F6** moves the focus through the ribbon, the side panels, the page, the status bar and the
notifications, one region at a time. **Shift+F6** goes the other way. Within the ribbon, **Left**
and **Right** switch tabs, and **Tab** moves through the buttons of the current tab.
