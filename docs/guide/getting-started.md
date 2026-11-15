# Getting started

## What you need

Elanero runs on **Windows 10** (version 1809 or later) or **Windows 11**, on a 64-bit (x64) PC.
Allow about 250 MB of free disk space. A keyboard and mouse or a touchpad are recommended.
macOS and Linux packages are not provided.

The packaged app includes everything it needs: you do not install Python, Tesseract or any other
tool. Converting Office files to PDF is the one optional extra; it uses a LibreOffice copy you
already have (see [Export and conversion](export.md#create-a-pdf-from-an-office-file)).

## Install Elanero

There are three ways to get it:

- **Microsoft Store.** Search for **Elanero - PDF Editor** (published by SGN Solutions) and
  choose **Get**. Store updates are installed for you.
- **Installer.** On the project's
  [releases page](https://github.com/linguagraph/elanero-pdf-editor/releases), download
  `pdfeditor-<version>-setup.exe` and run it.
- **Portable.** From the same releases page, download `Elanero.exe` and run it from any folder.
  Nothing is installed; the program keeps its settings in your user profile.

!!! tip
    The Store version, the installer and the portable version keep their data in different
    places. See [Troubleshooting](troubleshooting.md#where-elanero-keeps-its-files) for details.

## First launch

When no document is open, Elanero shows the **start page**: a large **Open File…** button, a
drop zone, the **Quick actions** (Combine files, Create from Office, Compare files, OCR a scan), a
**Read the user guide** link, and your **Recent files** with a preview of each first page.

## Open a PDF

Any of these works:

- Click **Open File…** on the start page, or press **Ctrl+O** (**File ▸ Open…**).
- Drag a PDF from File Explorer onto the start page or the Elanero window.
- Right-click a PDF in File Explorer, choose **Open with**, and pick Elanero.
- Click a file in **Recent files** on the start page.

Each document opens in its own tab. To open a second, separate window, choose **File ▸ New Window**
(**Ctrl+N**). By default, every file you open from File Explorer gets its own window. To send
those files to the window that is already running, as new tabs, turn on **Open files in the window
that's already running** in [Preferences](preferences.md#general).

Password-protected files ask for the password before they open.

## Make Elanero the default PDF app

Open **Edit ▸ Preferences…** (**Ctrl+K**), go to **General**, and find **PDF files**:

- **Register as PDF Editor** adds Elanero to the list of apps for PDF files. Click it again to
  remove the registration.
- **Choose Default App…** opens Windows Settings at **Default apps**, where you can pick
  Elanero for `.pdf` files.

## Save your work

- **Save** (**Ctrl+S**) writes your changes to the same file.
- **Save As…** (**Ctrl+Shift+S**) writes a copy under a new name and leaves the original alone.

Elanero writes to a temporary file first, checks that it opens, and only then replaces your file.
Unsaved changes are also kept as recovery copies; see [Troubleshooting](troubleshooting.md).

## Next steps

- Learn the screen: [Interface](interface.md).
- Read and search: [Reading and navigation](reading.md).
- Find any command quickly with **Ctrl+Shift+P** (the command palette).
