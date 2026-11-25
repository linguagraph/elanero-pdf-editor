# Translation

!!! info "New in version 0.3.0"
    Translating selected text arrived in version 0.3.0.

Select some text in a document and Elanero can translate it. Translation uses an online service that
you choose. It is off until you agree, and Elanero sends only the text you selected, and only when
you ask for a translation.

## Turn translation on

The first time you translate, Elanero shows a notice before it sends anything. Read it, then choose
one of:

- **Translate**: sends the selected text to the service for this request.
- **Cancel**: sends nothing.
- **Privacy Policy**: opens the service's privacy policy in your browser. The notice stays open.

You can also turn translation on or off in **Edit ▸ Preferences…** (**Ctrl+K**), on the **Translation**
page, with **Translate selected text online**. It stays off until you agree. See
[Preferences](preferences.md#translation).

## Translate a selection

1. With the **Select Tool** active, drag across the text.
2. Translate it in one of two ways:
   - Click **Translate** in the mini toolbar that appears beside the selection.
   - Right-click the selected text and choose **Translate…**.
3. A bubble appears next to the selection with the translation. Use the **From** and **To** boxes to
   change the languages; the translation runs again when you change them. **From** starts at
   **Detect language**.
4. Use the buttons under the translation:
   - **Copy** copies the translation to the clipboard.
   - **Add as note** highlights the selected text and stores the translation as the highlight's note.
     Select the text again first if the selection has changed.

Press **Esc**, click outside the bubble, or select other text to close it. A request still running
is cancelled, and its answer is ignored.

The bubble says which service translated the text. It also tells you when only part of the selection
was translated.

## Choose a service

Elanero offers four services. Choose one under **Service** on the **Translation** page of
Preferences.

| Service | What you need |
| --- | --- |
| **MyMemory** (Translated.net) | Nothing. This is the default. Optionally enter an **Email** address: it is sent with each request for a higher daily limit. |
| **DeepL** | A DeepL API key. |
| **LibreTranslate** | The address of a LibreTranslate server (you enter it), and an API key if that server needs one. |
| **Microsoft Azure AI Translator** | An Azure key, and the **Region** of your Azure resource if it has one. |

Enter the keys in Preferences. Elanero stores a DeepL, Azure or LibreTranslate key encrypted for your
Windows account, and sends it only to that service. An Azure region is stored as plain text.

Click **Test Connection** to send a short test text to the service and check that the key and address
work. The result appears next to the button.

Under **Default language**, choose the language that the **To** box starts with. **Same as the app**
follows the interface language.

## Privacy

When you translate, the service receives:

- the text you selected, and
- your IP address, as with any internet request.

Nothing else from the document is sent, and nothing is sent in the background. Each service's privacy
policy is linked from the consent notice and from Preferences ▸ Translation. Translation can be turned
off at any time in Preferences. See [Privacy](privacy.md).

## In the web version

The web version translates with MyMemory (Translated.net) only. Its settings (an on/off switch and a
default language) are under Preferences, Translation; it has no keys, accounts or email address.

- Select the text, then click **Translate** in the mini toolbar beside it, or run **Translate
  selection** from the command palette (**Ctrl+K**). Copy is in the same toolbar.
- **From** cannot detect the language. It starts at the language you chose last time, or English, so
  check it and choose the language of the selected text yourself.
- A selection can be up to 2,000 characters long per translation. For a longer passage, select less.
- Translation needs a connection. The rest of the app keeps working offline.
- MyMemory keeps a daily limit for each visitor, and the web version cannot raise it. When the limit
  is reached, try again later.
- Do not translate confidential text. MyMemory receives the text you select and may keep it.
- For DeepL, Microsoft Azure or your own LibreTranslate server, use Elanero for Windows.

## Limits

- Translation quality depends on the service. Check important text with a person who speaks the
  language.
- Services may limit the number of requests. When a service refuses a request, Elanero says so, and
  you can try again later or choose another service.
- Translating text in a scanned page needs [OCR](ocr.md) first; there is no text to select otherwise.
