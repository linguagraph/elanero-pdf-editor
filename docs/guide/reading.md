# Reading and navigation

## Move through a document

- Scroll with the mouse wheel, or drag the scroll bar.
- **Go ▸ First Page** and **Go ▸ Last Page** jump to the ends (**Home** and **End** in the page view).
- **Go ▸ Previous Page** and **Go ▸ Next Page** step one page at a time.
- **Go ▸ Go to Page…** (**Ctrl+Shift+N**) opens a box where you type a page number.
- **Go ▸ Back** and **Go ▸ Forward** (**Alt+Left** and **Alt+Right**) return to where you were
  before the last jump, like a browser's back button.
- The **Pages** panel (left) shows thumbnails; click one to go to that page.
- The **Bookmarks** panel lists the document's outline. Click an entry to go to its page.

Click a link in the document to follow it. Links to other pages jump there; links to web addresses
open in your browser.

## Page layouts

**View ▸ Page Display** (or the **Page Display** group on the **View** ribbon tab) chooses how
pages are arranged:

- **Single Page**: one page at a time.
- **Single Page Continuous**: pages one under another, scrolled as one column.
- **Two-Up Continuous**: two pages side by side, continuously.
- **Two-Up with Cover Page**: two pages side by side, with the first page alone, as in a book.

## Zoom

| Command | Shortcut |
| --- | --- |
| Zoom In | Ctrl++ |
| Zoom Out | Ctrl+- |
| Actual Size (100%) | Ctrl+1 |
| Fit Page | Ctrl+0 |
| Fit Width | Ctrl+2 |

Hold **Ctrl** and turn the mouse wheel to zoom. The zoom box shows the current level. The default zoom for a newly opened document is set in
[Preferences](preferences.md#appearance) (Fit Width by default).

## Rotate the view

**View ▸ Rotate View Clockwise** (**Ctrl+Shift+=**) and **Rotate View Counterclockwise**
(**Ctrl+Shift+-**) turn the pages on screen. This changes only how the document is displayed. To turn
the pages in the file itself, use [Pages](pages.md#insert-delete-duplicate-and-rotate).

## Night reading

**View ▸ Night Reading** (**Ctrl+Alt+N**) shows dark pages with light text, which is easier on the
eyes in a dim room. It changes the display only.

To change Elanero's own colors, choose **View ▸ Theme ▸ System**, **Light** or **Dark**.

## Search the document

1. Press **Ctrl+F** (**Edit ▸ Find…**). The **Search** panel opens with a box for the text.
2. Type the words and press **Enter**. Every match is listed, with the text around it. Click a
   result to go to it.
3. Use the options under the box:
   - **Match case**: only exact capitalization matches.
   - **Whole words**: `cat` does not match `category`.
   - **Regular expression**: the text is a pattern, for example `\d{3}-\d{4}`.
4. Press **F3** for the next match and **Shift+F3** for the previous one.

If nothing matches, the panel says so. Try other words, or turn off **Match case** and **Whole
words**.

Search works on text. A scanned page has no text until you run [OCR](ocr.md).

## Copy and select text

With the **Select Tool** active (press **V**, or **Esc** to return to it), drag across text to
select it. A press that starts off the text pans the page instead, as with the Hand tool.
**Ctrl+C** copies the selection, and **Ctrl+A** selects everything on the page. Right-click
selected text for **Copy** and **Translate…** (see [Translation](translation.md)).

## Attachments and layers

- The **Attachments** panel lists files embedded in the PDF, and lets you save them.
- The **Layers** panel lists the optional content (layers) in the document, such as a layer for
  notes or for a language. Turn a layer on or off to change what is displayed.

## Print

Press **Ctrl+P** (**File ▸ Print…** or the **Print** button on the **Home** ribbon tab).

The print dialog has the settings on the left and a live preview of the sheets on the right:

- **Printer** and its **Properties…** (paper size, quality, trays).
- **Pages**: all pages, the current page, or a range such as `1-3, 5`.
- **Copies** and **Collate**, which prints complete copies one after another.
- **Orientation**, **Page sizing** (for example Fit to printable area or Shrink oversized pages).
- **Print in grayscale**, **Print comments and markups**, and **Print as image**. Print as image
  helps with pages that print incorrectly, but it is slower.

Choose **Save as PDF** as the printer to write the printed result to a new PDF file instead.

## Document properties

**File ▸ Document Properties…** (**Ctrl+D**) shows the title, author and other metadata, the fonts
used, the PDF version and the security settings of the file.
