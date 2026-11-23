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

- **Your documents** are held in the memory of the browser tab while they are open. While a document
  has unsaved changes, the app keeps an autosave copy of it in the browser's private storage (the
  origin private file system, which other websites cannot read). The copy is deleted when the
  document is closed in Elanero, and when it is saved and has no unsaved changes. Closing or
  reloading the browser tab does not delete it, so the copy survives a reload or a crash. The copy
  stays on your device and is never uploaded.
- **Password-protected documents.** When you open one, Elanero asks for its password in a dialog.
  The password is kept only in the memory of the app's engine while that document is open, so the
  app can reopen it to save. It is never written to browser storage, never put in an autosave copy,
  and never sent anywhere. A password-protected document is never autosaved.
  Combine uses the password of a protected file once, in the engine, to make an unprotected copy of
  that file. The copy is held in the tab's memory until the Combine dialog closes, and is never saved.
- **Preferences and recent items** are stored in the browser's `localStorage`, under keys that start
  with `elanero.`:
  - `elanero.theme`: your colour theme (system, light or dark), one word.
  - `elanero.prefs`: your other preferences, such as zoom, accent colour and language. It never holds
    a password, token or key.
  - `elanero.recentFiles`: the names and opening times of up to ten recent files. No file bytes and
    no file paths.
  - `elanero.recentCommands`: the ids of the commands you ran from the command palette.
  - `elanero.layout.panelWidths`: the widths of the side panels.

  A notice you dismiss is remembered for the browser tab only, in `sessionStorage`.
- **Fonts you upload** (Preferences, Fonts) are kept in the browser's private storage, in a folder
  named `fonts`: each font's file and a small record beside it. They stay until you remove them, so
  they are there after you reload, and **Clear all local data** removes them. Open Elanero tabs in
  the same browser hear the id of a font you add or remove over the browser's `elanero.fonts`
  channel; the ids are not names or file contents and never leave your device. Where the browser
  cannot keep fonts, they last only until the tab closes. After the first font is kept, the app asks
  the browser to keep the storage; the browser decides, and the app does not see its answer.
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
- Once the engine has started, its worker and the background (job) workers have their network
  access removed (`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` and `importScripts`), so PDF
  processing code cannot reach the network.

**How to clear your data**

- Preferences has a **Clear all local data** button (Privacy). It removes the `elanero.` settings and
  recent items listed above, and the app's private storage folders for fonts and secrets. It is
  disabled while a document is open in the tab. It does not remove autosave copies.
- To remove autosave copies, including any left by a browser tab you closed with a document still
  open, clear the site's data for the Elanero web address in your browser's settings. Closing the
  browser tab does not remove them by itself.

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

Elanero works offline, except when you ask for a translation. Then, and only then, the text you
selected is sent to the translation service you chose (see below). Otherwise it connects to the
internet only when you ask it to, with one exception: the Microsoft Store version checks for
updates by itself (see below).

- **Checking for updates in the Microsoft Store (Store version only).** Once a day, and when you
  choose Help > Check for Updates, Elanero asks the Microsoft Store (Microsoft) whether a newer
  version is out. Elanero sends no document, text or file name; the request goes through Windows'
  Microsoft Store service and is handled under Microsoft's privacy statement. Your IP address is
  seen by that service, as with any Store request. You can turn the daily check off in Preferences > General;
  the Help command still works. The installer and the portable version never check.
- **Downloading an OCR language.** Elanero downloads the language file from GitHub
  (`github.com/tesseract-ocr/tessdata_fast`). GitHub sees your IP address, as with any
  download; see [GitHub's privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement).
- **Translating selected text.** Translation is off until you agree to it for the service you
  pick. When you select text and choose Translate, Elanero sends only that selected text to that
  service. Nothing is sent in the background. The services are:
  - **MyMemory (Translated.net)**, the default. It is free and needs no key.
  - **DeepL**, **Microsoft Azure AI Translator**, and **a LibreTranslate server you enter**. Each
    needs your own key or server address.

  The service sees the text and your IP address. With MyMemory you can enter an email address,
  which is sent with each request for a higher daily limit. Each service's privacy policy is
  linked from the notice and from Preferences ▸ Translation. Your DeepL, Azure or LibreTranslate
  key is stored encrypted for your Windows account, and is sent only to that service. The Azure
  region and the MyMemory email, if you enter them, are stored as plain text. You can turn
  translation off in Preferences.
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

- localStorage keys: `elanero.theme` (web/app/src/theme/theme.ts), `elanero.prefs`
  (web/app/src/prefs/store.ts), `elanero.recentFiles` (web/app/src/recent/recentFiles.ts),
  `elanero.recentCommands` (web/app/src/palette/recentCommands.ts), `elanero.layout.panelWidths`
  (web/app/src/layout/panelWidths.ts); sessionStorage `elanero.layout.narrowNoticeDismissed`
  (web/app/src/layout/NarrowNotice.tsx). The password is held only in the engine registry
  (src/pdfeditor/webapi/registry.py), cleared on close.
- Autosave copies are not deleted on pagehide (web/app/src/storage/autosaver.ts); no code calls
  `removeTab` (web/app/src/storage/autosaveStore.ts), so copies of a closed tab stay until its
  documents close or the site data is cleared.
- Clear all local data: web/app/src/storage/clearLocalData.ts (keys with prefix `elanero.`, OPFS
  folders fonts and secrets, not autosave/); button in web/app/src/prefs/PreferencesDialog.tsx.
- OPFS use is autosave copies and uploaded fonts only: web/app/src/storage/ (folder autosave/<tab-id>,
  deleted in autosaver.ts and autosaveStore.ts; never a password-protected document, save.autosave_bytes
  in src/pdfeditor/webapi/save.py); folder fonts/ (font files and one record per font, web/app/src/storage/
  fontStore.ts, written by web/app/src/fonts/fontLibrary.ts, removed by Clear all local data). The
  `elanero.fonts` BroadcastChannel carries font ids only (fontLibrary.ts, CHANNEL and parseFontMessage).
  Persistent storage is requested once, its answer unused (storage/fontStore.ts, requestPersistence). No IndexedDB or cookies in web/app/src, web/app/public or
  web/app/index.html (grep). Documents otherwise live in the engine's in-memory file system:
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
  in-app button is W4.5 (docs/web/plan.md), built in web/app/src/prefs/PreferencesDialog.tsx.
- No analytics, telemetry, sign-in or accounts: grep of web/app/src, web/app/public and
  web/app/index.html finds none.

The desktop section was carried over from the earlier policy and is not covered by this check.
-->

