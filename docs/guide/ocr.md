# OCR and scanned documents

A scanned page is a picture of text. You can see the words, but you can't search, select or copy
them. **OCR** (optical character recognition) reads the picture and adds the text to the page, so
the document becomes searchable and selectable.

Elanero's OCR runs inside the app, using the Tesseract engine that is built in. You don't need to
install anything. English is included; other languages can be downloaded.

## Recognize one document

1. Open the scanned PDF.
2. Open the **Tools** ribbon tab and click **OCR** (**Tools ▸ Recognize Text (OCR)…**).
3. In the dialog, choose:
   - **Pages**: all pages, the current page, the selected pages or a custom range.
   - **Languages**: the languages the text is in. Choose at least one. For more languages, pick one
     under **Get more** and click **Download**; a progress bar shows the download, and **Cancel**
     stops it.
   - **Output**, one of (the list is labelled **OCR output**):
     - **Searchable: keep the scan, add invisible text.** The page looks the same, and its text
       can be searched and selected. This is the usual choice.
     - **Editable: replace the scanned text with real text.** The text becomes real page text that
       you can edit with [Editing text and images](editing.md).
     - **Text only: real text, remove the scanned image.** Use this only when the picture is not
       needed, because the scan is removed.
   - **Scan quality** is a section you expand to reach these settings:
     - **Resolution**: in dots per inch. A higher value is slower but reads small print better.
     - **Clean up the image first (grayscale, denoise, binarize)**: a cleanup for poor scans. Used for
       recognition only; the visible scan is kept unless you chose **Text only**.
     - **Straighten skewed scans (deskew)**: for pages that were scanned at an angle.
   - **Skip pages that already have text**: leaves pages alone if they are already searchable.
4. Click **Recognize**.

Recognition runs in the background, and you can keep working. Its progress is shown in the status
bar. When it finishes, the text is added as one undo step.

!!! tip
    Start with **Searchable** at the default resolution. Check a few pages with search (**Ctrl+F**).
    If the text is wrong, try a higher resolution and turn on the cleanup options.

## Recognize many files at once

**Tools ▸ Batch OCR…** runs OCR on several files.

1. Click **Add Files…** and choose the PDFs.
2. Choose the languages and the output, as above.
3. Choose the folder in **Save copies to:** (with **Browse…**). The recognized copies are written
   there; your original files are not changed.
4. Click **Start**.

## Languages

English is bundled. Downloaded languages are kept on your computer, so you only download each
language once. The download comes from the Tesseract project's data on GitHub; see
[Privacy](privacy.md#when-elanero-uses-the-internet).

If a download fails, check your internet connection and try again.

## Limits

- OCR can make mistakes, especially with low-resolution scans, unusual fonts, handwriting, or text
  that is skewed or in tables. Check the results before you rely on them.
- The recognized text is set in a standard font, not the scanned one, so the text can look different
  from the scan when you select it.
