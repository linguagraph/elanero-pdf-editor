# Export and conversion

Elanero can save a PDF as a Word document, an Excel workbook, a web page, Markdown, plain text or
images, and can extract the images and fonts a file contains. Creating a PDF from an Office file
needs LibreOffice, which you install separately.

Exports never change the open document. They write a new file.

## Export to Word, Excel, text and images

Use **File ▸ Export To** and pick the format. Or click **Export** (**Export PDF…**) in the **Export**
group of the **Tools** ribbon tab, which opens the export dialog where you choose the format.

| Format | Menu item | What it does |
| --- | --- | --- |
| Word (`.docx`) | Word Document… | Keeps the page layout, or writes flowing text. Includes styled text, tables and pictures. |
| Excel (`.xlsx`) | Excel Workbook (tables)… | Finds the tables on the pages you choose; each table you pick becomes a worksheet. |
| HTML | HTML Web Page… | Structured text with headings, tables and pictures. |
| Markdown | Markdown… | Structured text with headings, tables and pictures. |
| Plain text | Plain Text… | The text only. |
| PNG, JPEG | PNG Images… / JPEG Images… | One image per page. |
| TIFF | TIFF Image… | Images of the pages, in one multi-page file or as numbered files. |

### Word

- **Layout**: **Keep page layout** places text, pictures and tables where they are on the page.
  **Flowing text** reflows the text into paragraphs, which is easier to edit.
- **Keep page breaks** (flowing text): keeps the original page breaks in the text.
- **Include pictures**: leaves pictures out when off.

### Excel

**Detect tables** looks for tables on the chosen pages. Tick the tables you want; each one becomes
its own worksheet. The list shows each table's first row as a preview, next to its size.

### HTML, Markdown and text

Pictures are saved in a folder next to the file. **Include pictures** controls whether they are
exported at all.

### Images

- **Pages**: all pages, the current page, the selected pages or a custom range.
- **Resolution**: in dots per inch. Higher values are larger and sharper.
- **Grayscale**, for black-and-white output.
- **JPEG quality** (JPEG only).
- **Include comments**: draws the comments and markups into the images.
- For TIFF, choose **All pages in one TIFF file**, or one numbered file per page.

!!! note "Reconstructed content"
    A PDF is a fixed layout, so converting it to Word or Excel rebuilds the content. Check the
    result, especially complex layouts, columns, tables and text inside pictures.

## Export on the web

In the web version, **Export** (in the **Tools** group, or from the command palette) opens the export
dialog. Choose:

- **Format**: plain text, Markdown, HTML, Word (`.docx`), PNG, JPEG or TIFF.
- **Pages**: all pages, the current page, or a page range such as `1-3, 5`. A range is checked
  before anything is exported; an empty range or a page outside the document is refused.
- **Resolution** (images only): 150 dpi, or 300 dpi for sharper images.

The export runs in the background, with a progress bar and a **Cancel** button. When it finishes,
download the file. Several page images come together in one ZIP file.

## Extract images and fonts

- **Images** in the **Export** group of the **Tools** tab (**File ▸ Extract Images…**) saves every image in
  the document as a file.
- **Fonts** in the same group (**File ▸ Extract Fonts…**) saves the fonts embedded in the document.

## Create a PDF from an Office file

**From Office** in the **Create** group of the **Tools** tab (**File ▸ Create PDF from Office File…**)
converts a Word, Excel,
PowerPoint or OpenDocument file to PDF. It is also one of the **Quick actions** on the start page,
as **Create from Office**.

The conversion uses LibreOffice, which Elanero does not include. Install LibreOffice from
[libreoffice.org](https://www.libreoffice.org/), then try again. If Elanero can't find LibreOffice,
it says so and doesn't start the conversion. Everything else in this guide works without it.

## Limits

- Exports from scanned pages contain no text until you run [OCR](ocr.md).
- Complex layouts, text in pictures, and unusual fonts may not convert exactly.
- Exports are written to new files; to replace the open document, use **Save As…** instead.
