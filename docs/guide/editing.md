# Editing text and images

Elanero edits the content of the page itself: the words, pictures and shapes that are part of the
document. Comments and markup, which sit on top of the page, are covered in
[Comments and review](comments.md).

Editing works best on PDFs made by a word processor or design tool. A PDF that was printed from a
scanner has no editable text; run [OCR](ocr.md) on it first, or edit only its images.

## Edit existing text and images

1. Open the **Edit** ribbon tab and click **Edit** (**Edit ▸ Edit Text & Images**, **Ctrl+Shift+E**).
   The mode banner appears above the page: "Editing text & images".
2. Double-click a paragraph to edit it, then type to change the text. Elanero uses the font of the
   original where it can.
3. Click a picture to select it, then drag it to move it, or drag its handles to resize it.
4. Press **Esc**, or click **Done** in the banner, to finish. Changes are undoable with **Ctrl+Z**.

Some text can't be edited, for example text whose font is not in the file and can't be replaced.
Elanero then says why in a message rather than changing the text.

!!! note
    Text is edited a paragraph at a time. To fix one word, double-click its paragraph and change the
    word in place.

In the web version, double-click a paragraph, or click it and press **Enter**, to edit it in place.
The box shows the document's own font when your browser can use it, and a similar font otherwise.
**Ctrl+Enter** (**Cmd+Enter** on a Mac), or a click on another part of the app, applies the change,
and **Esc** cancels it. One change is one undo step. A paragraph is set in its main style, so a
paragraph with several fonts or sizes takes one style when it is applied, and its lines can wrap a
little differently from the box you typed in. If the document's font has no character for something
you typed, a notice names the font that was used instead. If a change can't be applied, for example
because the page changed in the meantime, the box closes and the message has a **Copy text** button
that puts your text on the clipboard. When Elanero is busy with another task, the box stays open so
you can apply the change again.

### Fonts

When you edit text, the font picker lists the document's own fonts first, then recent fonts,
standard fonts and the fonts installed on your PC. It takes into account whether a font may be
embedded and whether it has the characters you type. Where the original font can't be used, Elanero
uses a substitute and tells you so. Exact font reuse is not always possible.

In the web version, the picker can't use the fonts installed on your computer. You can upload fonts
under **Preferences ▸ Fonts** ([Fonts on the web](web.md#fonts)), and the picker offers them once it
lists uploaded fonts.

To see the fonts a document uses, open **File ▸ Document Properties…** or use the **Space Usage**
report in [Optimize and compare](optimize-compare.md#see-what-takes-up-space).

## Add new text

1. Click **Add ▸ Text** on the **Edit** tab (**Edit ▸ Add Text**).
2. Click the page where the line should start, and type.
3. Set the font, size, color, alignment and line spacing for the new text, as offered while you
   work on it.
4. Press **Esc** to finish.

New text becomes part of the page content, like the text around it. (To add a note that sits on
top of the page, use the **Comment** tab instead.)

In the web version, choose **Add Text** on the **Edit** tab, then click the page where the text should
start, or drag out the box it goes in (a click makes a box 200 by 40 points). A box opens for typing:
type, then press **Ctrl+Enter** (**Cmd+Enter** on a Mac), or click elsewhere, to add the text. A box
left empty adds nothing. **Esc** closes the box without adding text, and the tool stays on for
another box; with no box open, **Esc** turns the tool off. The new text is set in Helvetica 12
point, black, left aligned, because the style controls come later. It is one undo step, and the
tool returns to Select once the text is added. Clicking a paragraph that is already on the page
with this tool edits that paragraph instead. On a signed document, Elanero asks first, as it does for
the other editing tools.

## Add images

1. Click **Add ▸ Image** (**Edit ▸ Add Image**).
2. Choose a PNG or JPEG file.
3. Click the page to place it, then drag to move or resize it.

In the web version, choose the file first, then click or drag on the page to place it. The picture
keeps its proportions inside the box you drew, and is centred in it. The web version adds PNG and
JPEG files up to 50 MB and 25 megapixels.

To swap an existing picture for another, select it and click **Objects ▸ Replace** (**Replace
Image**). To save a picture to a file, select it and click **Objects ▸ Export** (**Export Image**).

In the web version, select exactly one picture with **Edit Text & Images** on, then choose **Replace
Image** or **Export Image** from the Objects group. Replace asks for a PNG or JPEG file and puts it in
the picture's box, so a picture with a different shape is stretched to fit. The change is one undo
step. A picture that appears in several places (for example, a logo on every page) is replaced in
all of them, as on the desktop. Export Image downloads the picture as it is stored in the file, named
after the document, the page and the picture, and changes nothing in the document.

## Add shapes

**Shapes ▸ Rectangle**, **Ellipse** and **Line** draw shapes into the page content. Drag on the page
to draw; a shape stays in the page content, so it prints and displays like the rest of the page.

Click instead of dragging for a default-size shape (120 by 80 points). With the keyboard, Tab to the
page and press Enter for a default-size shape in the middle of the page; Esc stops the tool. The
tool turns off after one shape. Undo removes a shape in one step.

In the desktop and web versions, **Shapes ▸ Shape Style…** sets the outline colour, the fill and the line width of
the shapes you draw next. The default is a black outline of 1.5 points with no fill. A line is never
filled, and a shape needs an outline or a fill. The style lasts for the session only, and a shape
already on the page keeps its style.

Do not confuse these with the **Drawing** comments on the **Comment** tab, which are review marks
that sit on top of the page. See [Comments and review](comments.md).

## Select, move and delete objects

- Click an object to select it, or drag a box around several objects to select them together.
- Drag a selected object to move it.
- Press **Delete**, or click **Objects ▸ Delete**, to remove the selected text or images.

In the web version, the same gestures work with **Edit Text & Images** on, and a selected single
object shows eight handles to resize it. A move or a resize is saved when you release the mouse,
and a delete when you press **Delete** or **Backspace**. Each one is one undo step on the same
history as the desktop. A signed document asks once per tab before the first edit, because any
change to its content invalidates its signatures. Moving or resizing the text of a rotated or
vertical paragraph is not possible yet, as on the desktop.

Every edit is one undo step. Use **Ctrl+Z** to undo and **Ctrl+Y** or **Ctrl+Shift+Z** to redo.

## Scanned pages

A scanned page has no text to edit. By default, **Edit Text & Images** runs OCR on a scanned page first,
so its text can be changed. To turn this off, clear **Recognize text when editing scanned pages** under
**Tools** in [Preferences](preferences.md#tools). You can also run **Tools ▸ Recognize Text (OCR)** yourself
(see [OCR](ocr.md)).

## Limits

- Results depend on the source document. Text in unusual fonts, text inside pictures and text in
  complex layouts can't always be edited cleanly.
- Existing images have no rotation handle in the interface.
- Pictures stored inside the page content (inline images) can be moved and deleted, but not replaced
  or exported. The web version says so when you try.
- On a page that is both rotated and cropped, a new shape or picture can appear offset from where
  you drew it, by the crop box's offset. This is a known engine issue, to be fixed separately.
- Text added as a comment (a FreeText annotation) uses standard fonts.
- Elanero does not create or edit interactive form fields. Existing forms still display and are
  kept when you save.
