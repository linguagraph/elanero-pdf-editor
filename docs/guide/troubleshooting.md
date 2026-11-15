# Troubleshooting

This page covers recovering unsaved work, where Elanero keeps its files, the known limits of this
version, and how to report a problem.

## Recovery copies

While you work, Elanero saves a recovery copy of each document that has unsaved changes, every few
minutes. The interval is set by **Save recovery copies every** in
[Preferences](preferences.md#general) (2 minutes by default; **Off** turns recovery copies off).

If Elanero closes unexpectedly, the next time it starts it offers to recover the unsaved changes.
Choose to recover them, then **Save As…** the recovered document. A recovery copy is deleted once
its document is saved or closed.

Recovery copies are only a safety net. Save your work with **Ctrl+S** as you go.

## Where Elanero keeps its files

Elanero keeps its own files in one folder per user:

| Version | Location |
| --- | --- |
| Installer and portable `Elanero.exe` | `%LOCALAPPDATA%\pdfeditor` |
| Microsoft Store | The app's own package storage, which Windows removes when you uninstall the app |

In that folder you will find:

- `logs\pdfeditor.log`: the log file. Its older copies are kept beside it, and the log is trimmed
  automatically.
- `crashes\`: a crash report for each unexpected close. Elanero shows the report and you choose
  whether to share it.
- `recovery\`: recovery copies of unsaved documents.

Your preferences, recent files, custom stamps, downloaded OCR languages and the font list are also
stored on your computer. The [Privacy](privacy.md) page explains what is stored and when Elanero uses
the internet.

To remove everything Elanero stored, uninstall the app and delete the `%LOCALAPPDATA%\pdfeditor`
folder if it is still there.

## Common problems

**A file won't open.** Check that it is a PDF, and that you have the password if it is protected. If
Elanero says the file can't be read, it may be damaged. Try another PDF reader to confirm.

**PDF files still open in another app.** Set Elanero as the default app: see
[Getting started](getting-started.md#make-elanero-the-default-pdf-app).

**Text can't be found in a scanned page.** The page has no text until you run [OCR](ocr.md).

**OCR language download fails.** Check your internet connection and try again. Downloads come from
GitHub.

**Translation doesn't work.** Open **Preferences ▸ Translation**, check that the service is selected
and that its key and address are right, and click **Test Connection**.

**Converting Office files fails.** The conversion needs LibreOffice, installed separately. See
[Export and conversion](export.md#create-a-pdf-from-an-office-file).

**A signature PIN prompt doesn't go away.** Answer it on the device or in the vendor's software, or
dismiss it. Closing Elanero does not close that prompt. See [Digital signatures](signing.md#pin-safety).

## Known limits

This version has known limits, listed in full in the
[project's README](https://github.com/linguagraph/elanero-pdf-editor/blob/main/README.md#limitations-and-feature-status):

- General form creation and editing are not supported. Existing forms display and are kept on save.
- Text editing depends on the source document's content and fonts, and exact font reuse is not always
  possible.
- OCR can make mistakes.
- Built-in PDF/A checks are not a complete validator.
- Signature checks don't check certificate revocation, and some signing features are still being
  verified. See [Digital signatures](signing.md#limits).

## Report a problem

Report bugs and request features on the project's
[issue tracker](https://github.com/linguagraph/elanero-pdf-editor/issues). Include:

- the Elanero version and channel (**Help ▸ About Elanero** shows them),
- your Windows version,
- the steps that reproduce the problem, what you expected and what happened,
- a sample PDF, if you can share one without private content.

Review the log and any crash report before you attach them, because they can contain file names and
paths from your computer.

To check an installed portable copy, run `Elanero.exe --self-test --self-test-report report.txt` in a
command prompt in the folder that holds it. The report lists whether the app's components work.
