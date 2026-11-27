# Organize pages: Replace pages from the ribbon (issue #772)

**Status: proposed, for owner approval; no production code in this change.**

Slice 2 of the disabled Organize commands. Slice 1 (Page labels, #771) merged in #775 (`f814713`).
This note covers the web's **Replace** command: pick a PDF in the browser, choose its source pages,
and replace the selected pages in one undo step.

## 1. Verified status on `origin/main` (`4e0f1b1`)

What already exists:

| Part | Evidence |
| --- | --- |
| Action `pages.replace` | `src/pdfeditor/actions/pages.py:80` (`ReplacePages`: `pages`, `data`, `source_pages`, `password`), `:259-283` (the action). It opens the source through `_open_source` (`:195-220`), inserts the source pages at the first selected page, then drops the selected pages, all in one `snapshot(...)` (`SnapshotCommand`), label `Replace N Pages`. It is registered with `requires=("page_ops",)` (`:259`). |
| Engine operations | `Document.insert_pages` and `Document.select_pages` in `src/pdfeditor/engine/base.py:530-541`; MuPDF backend `src/pdfeditor/engine/mupdf/document.py:975`. No new engine method is needed. |
| Desktop UI | `src/pdfeditor/ui/organize.py:104` (the action), `:335-358` (`replace_pages`: file dialog, then source pages `1-min(count, selected)`, no range dialog). |
| Action test | `tests/actions/test_pages.py:256-266` (replace swaps the pages; undo restores). Registry: `tests/actions/test_registry.py:42`. |
| Web catalog entry | `web/app/src/commands/catalog.ts:238`: `replace-pages` has no enable rule, and `App.tsx` gives it no handler (the handlers are at `App.tsx:865-895`), so it reports `notAvailableYet`. `web/app/src/commands/commands.test.ts:746-750` pins that. |
| Page count of a source PDF | `combine.probe` (`src/pdfeditor/webapi/combine.py:34`): read-only page count and encryption from bytes, up to `limits.MAX_PROBE_BYTES` (64 MB, `webapi/limits.py:57`), with `PASSWORD_REQUIRED` / `WRONG_PASSWORD`. Used by Combine (`web/app/src/combine/probe.ts:119`). |
| Password loop | `web/app/src/organizer/insertFile.ts:34-55` (Insert from file; `PASSWORD_ATTEMPTS = 5`, the engine's `_PASSWORD_ATTEMPTS`). |
| Organizer bridge | `web/app/src/organizer/organizerBridge.ts:9-15` (command ids), `:102-133` (`runOrganizerCommand`, `runOrganizerAction`). |

What is missing (none of slice 2 exists on main): no web dialog, no `replace-pages` handler or
bridge entry, no webapi test of `pages.replace` through `actions.run`, and no guide text (the
table row at `docs/guide/web.md:475` says "Replace is not available yet").

Gaps found in the existing action (`actions/pages.py:259-283`):

1. An empty `pages` raises `IndexError` at `chosen[0]` (`:274`), which the web reports as an
   internal error instead of a refusal.
2. Target pages outside the document, and source pages outside the source, are not checked
   before the change; the failure comes from inside the engine, mid-snapshot.
3. An empty `source_pages` would delete the selected pages under the label "Replace", which is a
   delete in disguise.

No open PR touches these files (`gh api .../pulls?state=open` returned none).

## 2. Design

### 2.1 Engine and action (Python)

- **No new Protocol method and no new capability flag.** The action already uses the Protocols
  (`Document.insert_pages`, `select_pages`) and the existing `page_ops` capability (`requires=`),
  which the registry checks before running. The web UI does not check `page_ops` for any page
  command today; Replace follows the same rule.
- **Validation before the change**, in `replace`, raising `Refused` (mapped to `REFUSED` by
  `webapi/errors.py:124-137`):
  - `pages` empty or any page outside `0..page_count-1`: `reason="invalid_pages"` (the reason the
    crop and labels checks use, `actions/pages.py:301`, `:393`; the web already maps it,
    `web/app/src/rpc/errors.ts:75`).
  - `source_pages` empty or any page outside the source: new `reason="invalid_source_pages"`,
    checked after the source opens and before `snapshot(...)`.
- **Undo:** unchanged. The change stays one `SnapshotCommand` (disk-backed), because page
  replacement is destructive (annotations, links and structure on the removed pages). One undo
  step on both the desktop and the web.
- **Semantics kept from the desktop:** the source pages go in front of the first selected page,
  and every selected page is removed. A non-contiguous selection therefore leaves the source
  pages at the first selected position. The counts need not match (3 pages can be replaced by 5).
  A repeated source page is allowed (an independent copy, per `select_pages`' contract).

### 2.2 Web (TypeScript)

- **Command.** `replace-pages` gets the `PAGES_SELECTED` rule (`commands/registry.ts:209`), as
  Extract has, and the handler `runOrganizerCommand('replace-pages', openOrganizerPanel)`. The
  bridge gets the id and a `replace()` panel action.
- **Why a dialog, not the file chooser.** A ribbon press that opens the panel first cannot open a
  file chooser (no user activation; see the Insert hint, `docs/guide/web.md:270-272`). The panel
  action therefore opens a **Replace Pages** dialog (on the Overlay shell, like
  `PageLabelsDialog`), and the dialog has its own **Choose file…** button, so the chooser always
  opens from a press inside the dialog. A queued command works the same way.
- **Dialog contents:** the pages being replaced ("Pages 3–5 of 12", read-only, from the
  selection); Choose file… (PDF only, `accept=".pdf,application/pdf"`); the file's name and page
  count; a **Source pages** range field (default `1-min(count, selected)`, the desktop's default),
  checked with `parsePageRanges` (`web/app/src/pages/pageRanges.ts:76`); a summary line
  ("Replace 3 pages with 5 pages"); Replace and Cancel.
- **Counting the source.** On choosing a file, the dialog calls `combine.probe` (added to the
  `PageRpc` method list, `engine/engineConnection.ts:238`). It is read-only and keeps nothing.
  `PASSWORD_REQUIRED` or `WRONG_PASSWORD` asks for the password through the shared loop (below).
  A file over 64 MB (`FILE_TOO_LARGE`) shows no count; the range field then accepts a range
  without an upper check, and the action's `invalid_source_pages` refusal is the check.
- **Shared password loop.** The loop in `insertFile.ts:34-55` moves to one helper,
  `withPassword(name, prompt, attempt)` (in `web/app/src/documents/`), used by Insert from file
  and Replace. Same limit (`PASSWORD_ATTEMPTS`), same `PasswordGaveUp`, same cancel. The password
  that unlocked the probe is kept only in the dialog's state until the one `pages.replace` call,
  then dropped; it is never logged or stored, and it goes to the engine once per call.
- **Run.** Replace sends `actions.run` `pages.replace` with `pages` (the selection, 0-based),
  `data` (a fresh `file.arrayBuffer()`, since sending detaches the buffer), `source_pages`
  (0-based) and `password`. The panel then reloads with the new pages selected
  (`[min(pages), min(pages) + n)`) and offers the change's Undo notice, as Insert from file does
  (`OrganizerPanel.tsx:297-312`).
- **Errors.** `invalid_source_pages` gets a message in `rpc/errors.ts` and `i18n/en.ts`. A refusal
  shows inside the dialog, which stays open. Every string goes through `t()`.
- **No engine work on the main thread**: the probe and the action run in the engine worker.

### 2.3 Desktop

No UI change. The desktop gains the new refusals for free (its range parser already keeps the
source pages in range, so a user never sees them there).

## 3. Slice plan

Each slice is one PR, at most 400 production lines (tests, generated files and docs not counted).
Slice 1 of this feature was estimated at 320 lines and landed at 428, so the web work is kept in
its own PR with room to spare.

| Slice | Branch | Content | Estimate |
| --- | --- | --- | --- |
| **R1** Action checks | `fix-replace-pages-checks` | The three checks in `actions/pages.py` (`invalid_pages`, `invalid_source_pages`). Tests in §4 (R1). No web UI. | ~30 lines |
| **R2** Web dialog | `phase-w-organize-replace-pages` (or the owner's preferred name) | `ReplacePagesDialog.tsx` (~200) and CSS (~25); shared `withPassword` helper (~35, with `insertFile.ts` reduced); bridge id and panel action (~30); command rule and handler (~5); `PageRpc` adds `combine.probe` (1); `errors.ts` and `en.ts` (~25); guide `docs/guide/web.md` (Organize pages bullet and table row 475). Depends on R1. | ~320 lines |

If R2 measures over 400 before review, the stop rule applies: report it, and the fallback split is
R2a (shared password helper and bridge wiring, Insert from file unchanged in behaviour) and R2b
(the dialog).

## 4. Tests and where each runs

| Test | Slice | Runs in |
| --- | --- | --- |
| `tests/actions/test_pages.py`: empty `pages`, a target past the end, an empty `source_pages` and a source page past the source each refuse with their reason and change nothing (page count, history). | R1 | Desktop pytest (`test-windows`) and Pyodide `web-pytest` |
| `tests/unit/test_webapi_replace.py` (new, modelled on `test_webapi_actions.py:384-436`): `actions.run` `pages.replace` with the bytes as `$bin`; the texts of the replaced pages are the source's; `save.save_bytes` verifies; **round trip** recorded with `tests.hostcheck.record` (`page_count_pikepdf`, `page_count_pdfium`), no module-level pikepdf or pypdfium2 import; reopen and assert the page count and texts; one `actions.undo` restores the original. Encrypted source: no password and a wrong one give `PASSWORD_REQUIRED` and change nothing; the right one replaces. Refusals come back as `REFUSED` with the reason. | R1 | Desktop pytest, and Pyodide `web-pytest` with `scripts/web_host_verify.py` checking the host records |
| `tests/actions/test_pages.py:256` (existing) keeps passing; the desktop UI test for `replace_pages`, if present, unchanged. | R1 | Desktop pytest |
| Vitest `withPassword` helper: asks on `PASSWORD_REQUIRED` and `WRONG_PASSWORD`, stops after 5, cancel returns null, other errors pass through. Existing `OrganizerPanel.test.tsx` insert tests keep passing (the refactor changes no behaviour). | R2 | `npm test` (web CI job `web`) |
| Vitest `ReplacePagesDialog.test.tsx`: default range from the count and the selection; a bad range blocks Replace; a locked file asks once per attempt; one `actions.run` call with 0-based pages and the password; a refusal shows in the dialog; a large file (no count) still runs; Cancel sends nothing. | R2 | `npm test` |
| Vitest `commands.test.ts`: `replace-pages` follows `PAGES_SELECTED` and runs its handler; the test at `:746` drops `replace-pages` from its list. `organizerBridge.test.ts`: a queued `replace-pages` opens the dialog, not a file chooser. | R2 | `npm test` |
| Playwright feature spec (W8.1 set): open a fixture, select pages, Replace with a second fixture, check the page count and Undo. | R2 (see Q4) | `npm run e2e:features:chromium` by hand on the PR branch; nightly `web-e2e` (not a required check) |

## 5. Risks

- **Signed documents.** Removing pages breaks any signature that covers them, as Delete already
  does. Replace adds nothing new here; the save path (incremental save when signed) is unchanged.
- **Memory.** The source bytes cross to the worker twice (probe, then replace), each a fresh copy
  that is transferred, so the page keeps none. A file over 64 MB is not probed.
- **Password handling.** The password lives in dialog state between the probe and the replace.
  Mitigation: cleared on close, Cancel and after the call; covered by the dialog test.
- **Non-contiguous selections** may surprise users (source pages land at the first selected
  position). Mitigation: the dialog's pages line names the selection, and the guide says it.
- **Line cap.** R2 is the larger slice; see the fallback split in §3.

## 6. Questions for the owner (each with a recommended answer)

1. **Should the web dialog let the user choose the source pages, or take the desktop's fixed
   default (the first N pages of the file)?** Recommended: a Source pages field, defaulting to the
   desktop's `1-min(count, selected)`. The issue asks for it, and it costs one field.
2. **May the source and target counts differ (replace 3 pages with 5)?** Recommended: yes, as on
   the desktop, with a summary line that shows both counts.
3. **A source over 64 MB cannot be counted in the browser. Refuse it, or allow it with an
   unchecked range?** Recommended: allow it, with an unchecked range and the engine's refusal as
   the check, matching Combine, which also handles large files without a count.
4. **Include a Playwright feature spec in R2?** Recommended: yes, one Chromium spec. Tests do not
   count toward the cap. This makes the hand-checked web-e2e run on the PR branch part of R2's
   auto-merge gate.
5. **Ship R1 (the Python checks) as its own PR first?** Recommended: yes. It is small, it fixes
   the internal-error path on its own, and it keeps R2 under the cap.
6. **Should Replace accept an image as the source, as Insert from file does?** Recommended: no.
   The desktop's Replace takes PDFs only (`ui/organize.py:340`), and `pages.replace` has no image
   path. An image source can be a later issue if wanted.

No question blocks R1. R2 needs answers to Q1-Q4 (the recommended answers are assumed if the
owner approves this note without changes).
