# Privacy

Elanero has no accounts, no telemetry, no analytics, no advertising and no automatic crash-report
uploads. Your documents stay on your computer.

The full policy is in the project's
[privacy policy](https://github.com/linguagraph/elanero-pdf-editor/blob/main/PRIVACY.md). This page is a
summary of it.

## What stays on your computer

Elanero keeps a few things on your PC so that it can work. None of them is sent anywhere:

- your preferences, the recent files list and the window layout;
- recovery copies of documents with unsaved changes (deleted once the document is saved or closed);
- a log file and, after an unexpected close, a crash report that you may choose to share;
- OCR languages you download, custom stamps you create, and a list of the fonts installed on your PC.

Where these are kept is described in [Troubleshooting](troubleshooting.md#where-elanero-keeps-its-files).

## When Elanero uses the internet

Elanero works offline. It connects to the internet only when you ask it to, with one exception: the
Microsoft Store version checks for updates by itself (see below).

- **Checking for Store updates** (Microsoft Store version only). Once a day, and when you choose
  **Help ▸ Check for Updates**, Elanero asks the Microsoft Store (Microsoft) whether a newer version
  of Elanero is out. Nothing else is sent: no document, no text and no file name. Microsoft sees
  your IP address, as with any Store request. Turn the daily check off in
  [Preferences](preferences.md#general); the Help command still works then. The installer and the
  portable version never check.
- **Downloading an OCR language**, from GitHub. GitHub sees your IP address, as it does for any
  download.
- **Translating selected text**, once you have turned translation on. Only the text you selected is
  sent, to the service you chose. See [Translation](translation.md).
- **Opening a link**. Links to web pages open in your browser.
- **Adding a timestamp to a signature**, if you turn it on and enter a timestamp server. Elanero sends
  that server a hash of the signature, not the document or your certificate. See
  [Digital signatures](signing.md).
- **Checking signatures** does not use the internet. Elanero reads the certificates your PC already
  trusts and never fetches certificates, revocation lists or timestamps to do this.

Apart from the daily Store check described above, nothing is sent in the background. When you open
the **Help** guide, your browser opens this website.
