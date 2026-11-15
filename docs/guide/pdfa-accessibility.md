# PDF/A and accessibility

PDF/A is an ISO standard for long-term archiving: a self-contained file with no features that may
stop working later, such as missing fonts or encryption. Accessibility checks look at whether a
document works with screen readers and other assistive technology. Both are on the **Tools** ribbon
tab, in the **Standards** group, and in the **Tools** menu.

## Check PDF/A conformance

1. Click **Preflight** (**Tools ▸ PDF/A Preflight…**).
2. Read the report. **Issues** lists the problems Elanero found. Items that a conversion would fix are
   listed under **Fixed**, and items that would still block PDF/A are listed under **Still blocking
   PDF/A**.
3. To validate more fully, click **Validate with veraPDF**, if veraPDF is installed on your computer.
   veraPDF is a separate, optional program; Elanero finds it when it is installed and does not
   include it.

## Save a PDF/A copy

1. Click **Save as PDF/A** (**Tools ▸ Save as PDF/A…**).
2. Choose a new file name. Elanero writes a PDF/A-2b copy and leaves the open document unchanged.
3. Elanero reports the problems that remain, if any. The copy includes an sRGB output intent and the
   XMP identification that PDF/A requires, embeds the fonts it can, and removes features that PDF/A
   does not allow.

If the report still lists problems, the copy is not fully conformant. Fix them in the original, then
save the PDF/A copy again.

## Accessibility check

Click **Accessibility** (**Tools ▸ Accessibility Check**). The **Accessibility** panel opens and checks
the document for:

- **Tagging**: whether the document has a structure that screen readers can follow.
- **Document language and title**: a language and a title in the file's properties.
- **Image alternative text**: a short description for each picture.
- **Heading structure**: headings in a logical order.
- **Reading order**: the order in which the content is read.
- **Tab order**: the order in which the focus moves between links and fields on each page.
- **Text and annotation contrast**: whether text is readable against its background.

Elanero can fix some findings: document properties (language, title) and image alternative text
can be set from the panel. Others need your judgment, such as a meaningful description of a chart.

The **Tags** panel shows the document's structure tags. You can inspect, rename and reorder them there.

## Auto-tag (experimental)

**Tools ▸ Auto-Tag Document (experimental)** adds tags for paragraphs, headings and figures, based on
the page layout. Use the **Tags** panel to review the result.

!!! warning "Experimental"
    Auto-tagging does not yet create complete list, table or link structures, and it does not write
    image alternative text. Check the result with the accessibility check, and add the rest by hand.

## Limits

- The built-in PDF/A checks cover common rules but are not a complete validator. Use veraPDF for a full
  validation.
- Passing the accessibility check does not guarantee that a document is accessible or meets a legal
  standard. Review important documents with people who use assistive technology.
