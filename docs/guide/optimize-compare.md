# Optimize and compare

Two sets of tools on the **Tools** ribbon tab make files smaller and show what changed between two
versions: **Optimize** (Reduce Size, Space Usage) and **Compare** (Compare Files).

## Reduce file size

Use **Tools ▸ Reduce File Size…**. The dialog saves a smaller copy;
the open document is left unchanged.

1. Choose a **Preset**:
   - **Smallest (screen)**: images at 72 dpi and JPEG quality 50, for reading on screen and email.
   - **Balanced (ebook)**: images at 150 dpi and JPEG quality 70; good on screen and fine for
     office printing.
   - **High quality (print)**: images at 300 dpi and JPEG quality 85; keeps print quality.
   - **Lossless**: images untouched. Fonts are subset, unused and duplicate objects are removed, and
     the file is compressed.
   - **Custom**: your own settings.
2. Adjust the settings if you chose **Custom**, or to fine-tune a preset:
   - **Images**: **Image resolution** (in dpi), **JPEG quality**, **Convert images to grayscale**,
     and **Keep image resolution** to leave the images' resolution alone.
   - **Fonts and structure**: **Subset embedded fonts** (keeps only the characters the document
     uses), and **Compress document structure (object streams)**.
   - **Remove document information and XMP metadata**, and **Remove page thumbnails**.
   - **Optimize for fast web view**: prepares the file for showing a page before it has finished
     downloading. It works only on files without a password.
3. Click **Estimate Size** to see the result before you write anything. The dialog shows the current
   size and the estimated new size.
4. Click **Save Reduced Copy** and choose a new file name.

!!! warning
    The Smallest, Balanced and High quality presets compress and resize images, so some detail is
    lost, and converting to grayscale is lossy too. Keep the original, and use **Lossless** when
    quality matters.

Removing document information or thumbnails removes that data from the copy only.

In the web version, **Tools ▸ Reduce File Size** offers the four presets (Smallest, Balanced, High
quality and Lossless) and no custom settings. **Compress** runs in the background with a progress
bar and **Cancel**. The result shows the size before and after, and **Download reduced.pdf** saves
the copy. If the preset does not make the file smaller, the dialog says so and offers no download:
keep the original.

### See what takes up space

**Tools ▸ Space Usage…** shows what the file is made of: the total size,
and the space taken by each category, such as images, fonts, page content, comments and forms,
tags, attachments and metadata. Use it to decide which **Reduce Size** settings will help most. It
only reads the file; it changes nothing.

## Compare two versions

Use **Tools ▸ Compare Files** (**Compare Files…**) to see what changed between an older and a newer
version of a document.

1. Choose the **Old version** and the **New version**. Both are PDFs.
2. Under **Options**, choose how to compare:
   - **Compare text (word by word)**: finds added, deleted and changed words.
   - **Compare appearance where the text is the same**: finds changed pictures, drawings and colors,
     which text comparison can't see.
3. Click **Compare**.

The two documents are shown side by side, and scrolling one moves the other. Pages are matched to
each other, so an inserted or deleted page shows its nearest counterpart on the other side. When
nothing differs, the result says **No differences found.**

To share the result, click **Export Report…**. It writes a PDF report of the comparison.

In the web version, the dialog takes the newer document from a file picker, and the report lists
the changed pages. Each changed page links to its page in the open view. **Save report as text**
writes the report as a text file.

## Limits

- Reducing a file can lower image quality. Always check the copy before you replace the original.
- Appearance comparison works on scanned pages. Word-by-word comparison needs text, so run
  [OCR](ocr.md) on scanned pages first.
