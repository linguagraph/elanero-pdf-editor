# Privacy policy: Elanero - PDF Editor

_Covers the web version (below) and the Windows versions: the Microsoft Store app, the installer
and the portable `Elanero.exe`._

**Elanero collects no personal data.** It has no accounts, no telemetry, no analytics, no
advertising and no crash reporting to us. Your documents never leave your computer, except
text you choose to translate.

## The web version (in your browser)

The web version runs entirely in your browser tab. It is served from the project's GitHub Pages
site, and your documents are not uploaded to any server.

**What the web version stores in your browser**

- **Your documents** are held only in the memory of the browser tab while they are open. The app
  writes no document to disk and keeps nothing after the tab closes.
- **Your colour theme** (system, light or dark) is stored in the browser's `localStorage` under the
  key `elanero.theme`. It holds only that one word and no document content.
- **The app itself** is kept in the browser's offline cache (the service worker's cache), so it can
  open without a connection. Documents are never put in this cache.

**What leaves your device**

- **Nothing from your documents.** The app loads only its own files from the site where it is
  hosted. Its security policy allows the page to connect only to that site and to the three
  translation services listed below.
- **Translation (planned, not in this build).** When translation is built and you turn it on, the
  text you select is sent to one of these services, and only these:
  - MyMemory (Translated.net): `https://api.mymemory.translated.net`. If you enter an email address,
    it is sent with each request to raise the daily limit.
  - Microsoft Azure AI Translator: `https://api.cognitive.microsofttranslator.com`.
  - LibreTranslate: `https://libretranslate.com`.

  DeepL and other LibreTranslate servers are not available in the web version. Until translation is
  built, this build sends no translation requests.
- **The hosting site.** GitHub Pages serves the app's files, and, as with any website, it sees the
  IP address of the request.

**What the web version never does**

- It has no analytics, no advertising and no crash reporting.
- It has no accounts and no sign-in, and it sets no cookies.
- It does not upload your documents, or any part of them, anywhere.
- Background (job) workers have their network access removed before they run.

**How to clear your data**

Clear the site's data in your browser's settings (site data for the Elanero web address). That
removes the theme setting and the offline copy of the app. Closing the tab discards open
documents. The app has no separate "clear data" button yet.

## Desktop app (Windows)

_This section is the existing policy for the Microsoft Store app, the installer and the portable
`Elanero.exe`. It was not re-checked when the web version section was written._

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

Elanero works offline. It connects to the internet only when you ask it to, with one exception: the
Microsoft Store version checks for updates by itself (see below).

- **Checking for updates in the Microsoft Store (Store version only).** Once a day, and when you
  choose Help > Check for Updates, Elanero asks the Microsoft Store (Microsoft) whether a newer
  version is out. Elanero sends no document, text or file name; the request goes through Windows'
  Microsoft Store service and is handled under Microsoft's privacy statement. Your IP address is
  seen by that service, as with any Store request. You can turn the daily check off in Preferences > General;
  the Help command still works. The installer and the portable version never check.
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

<!--
How the web version section was checked (repository paths):

- Theme key `elanero.theme` is the only `localStorage` use: web/app/src/theme/theme.ts.
- Documents are not written to disk; no OPFS, IndexedDB or cookies in web/app/src, web/app/public
  or web/app/index.html (grep). Documents live in the engine's in-memory file system:
  web/app/src/engine/loader.ts (unpacks into /home/pyodide) and docs/web/design/W1.1.md section 6.
- Offline cache and documents never cached: web/app/public/sw.js (header comment and fetch
  handler); the cached file list is written by web/app/src/pwa/build.ts.
- Network allow-list: web/app/src/csp.ts `connect-src`; web/app/index.html carries the same
  policy (web/app/src/csp.test.ts checks they match). The app's own file load is same-origin:
  web/app/src/engine/loader.ts (defaultFetch).
- Translation origins: web/app/src/csp.ts; src/pdfeditor/services/translation/web_http.py
  (WEB_ENDPOINT_ORIGINS); MyMemory endpoint and optional `de` email field in
  src/pdfeditor/services/translation/mymemory.py; Azure in azure.py; LibreTranslate in
  libretranslate.py. DeepL is absent from the web set (web_http.py, csp.ts; docs/web/plan.md R4).
- Translation is not in this build: no translation UI in web/app/src (only error strings in
  web/app/src/i18n/en.ts); W6.6 is unticked in PLAN.md.
- Job workers lose fetch, XMLHttpRequest and WebSocket: web/app/src/engine/jobworker.ts
  (FORBIDDEN_GLOBALS).
- GitHub Pages hosting: docs/web/plan.md (intro) and docs/web/design/W1.1.md section 9.
- "Clear your data" uses browser site-data settings, which is browser behaviour, not code. The
  in-app clear button is W4.5 (docs/web/plan.md), not built.
- No analytics, telemetry, sign-in or accounts: grep of web/app/src, web/app/public and
  web/app/index.html finds none.

The desktop section was carried over from the earlier policy and is not covered by this check.
-->

