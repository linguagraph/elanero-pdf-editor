# Privacy policy: Elanero - PDF Editor

_Applies to every version of Elanero: the Microsoft Store app, the installer and the portable
`Elanero.exe`._

**Elanero collects no personal data.** It has no accounts, no telemetry, no analytics, no
advertising and no crash reporting to us. Your documents never leave your computer, except
text you choose to translate.

## What stays on your computer

Elanero keeps a few things on your PC so it can work. None of it is sent anywhere:

- your preferences, recent files list and window layout;
- recovery copies of documents with unsaved changes, deleted once the document is saved or
  closed;
- a log file and, if Elanero closes unexpectedly, a crash report you can choose to share;
- OCR languages you download, custom stamps you create, and a list of the fonts installed on
  your PC.

Uninstalling the Microsoft Store app deletes all of this. With the installer or the portable
version, it stays in `%LOCALAPPDATA%\pdfeditor` until you delete that folder.

## When Elanero uses the internet

Elanero works offline. It connects to the internet only when you ask it to:

- **Downloading an OCR language.** Elanero downloads the language file from GitHub
  (`github.com/tesseract-ocr/tessdata_fast`). GitHub sees your IP address, as with any
  download; see [GitHub's privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement).
- **Translating selected text.** Translation is off until you agree to it once. After that,
  when you select text and choose Translate, Elanero sends only that selected text to the
  service you picked: MyMemory (Translated.net), DeepL, Microsoft Azure AI Translator, or a
  LibreTranslate server you enter.
  The service sees the text and your IP address. With MyMemory you can add an email address,
  which is sent with each request for a higher daily limit. Each service's privacy policy is
  linked from the notice and from Preferences ▸ Translation. Your DeepL, Azure or LibreTranslate key
  is stored encrypted for your Windows account, and is sent only to that service. The Azure
  region, if you enter one, is stored as plain text. Nothing is
  sent in the background, and you can turn translation off in Preferences.
- **Opening a link.** When you click a web link in a document or in Elanero, it opens in your
  web browser.
- **Adding a timestamp to a signature.** If you turn on "Add a trusted timestamp" when signing
  and enter a timestamp server, Elanero sends that server a hash of the signature (not the
  document or your certificate). The server you pick sees your IP address. It's off by default,
  and no server is preset.
- **Checking signatures.** Elanero checks the signatures in a document offline. It never
  fetches certificates, revocation lists or timestamp data to do this, so a check doesn't tell
  anyone you opened the file. (On Windows it reads the certificates your PC already trusts,
  from the Windows certificate stores, and doesn't open any key.)

## Contact

Questions about this policy: open an issue at
<https://github.com/linguagraph/elanero-pdf-editor/issues>.

Elanero is open source (AGPL-3.0-or-later). Its full source code, including everything above,
is at <https://github.com/linguagraph/elanero-pdf-editor>.
