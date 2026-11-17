# Phase W: Elanero Web, a WebAssembly version that runs fully in the browser

Tracking issue: [#132](https://github.com/linguagraph/elanero-pdf-editor/issues/132). One sub-issue per stage: W0 [#133](https://github.com/linguagraph/elanero-pdf-editor/issues/133), W1 [#134](https://github.com/linguagraph/elanero-pdf-editor/issues/134), W2 [#135](https://github.com/linguagraph/elanero-pdf-editor/issues/135), W3 [#136](https://github.com/linguagraph/elanero-pdf-editor/issues/136), W4 [#137](https://github.com/linguagraph/elanero-pdf-editor/issues/137), W5 [#138](https://github.com/linguagraph/elanero-pdf-editor/issues/138), W6 [#139](https://github.com/linguagraph/elanero-pdf-editor/issues/139), W7 [#140](https://github.com/linguagraph/elanero-pdf-editor/issues/140), W8 [#141](https://github.com/linguagraph/elanero-pdf-editor/issues/141), W9 [#142](https://github.com/linguagraph/elanero-pdf-editor/issues/142). Design notes go in `docs/web/design/` (created in W1).

## Goal

A web version of Elanero that runs **entirely in the browser**. The existing Python PDF stack (`model`, `engine`, `core`, `services`) runs in **Pyodide (CPython compiled to WebAssembly)** inside a Web Worker. A new TypeScript front end replaces the PySide6 `ui` layer. Documents never leave the user's device. The only network traffic is loading the static app and, if the user opts in, sending selected text to a translation service.

Hosting is static (GitHub Pages, under `https://linguagraph.github.io/elanero-pdf-editor/app/`). There is no backend, no account and no telemetry, which keeps the promise in `PRIVACY.md`.

**Out of scope:** OCR, digital signing, Office-to-PDF import (LibreOffice), PDF/A conversion (needs pikepdf), linearization (needs pikepdf), installed system fonts, file association, Store updates, accessibility tagging (Phase 15 tag editor), and forms authoring. As on desktop, existing forms and signatures must still render and survive saving.

**Reuse principle.** Python code is shared, not forked. Anything the web needs that today lives in `pdfeditor.ui` and doesn't need Qt (deciding which Command to build, its label and its arguments) moves *down* into a Qt-free layer that both front ends call (task W2.1). The TypeScript front end holds only presentation and input handling. A web feature that needs Python logic not already below `ui` gets that logic extracted first, with tests, and the desktop then uses the extracted version too. The desktop app's behaviour must not change.

## Feature scope

### Required (from the request)

| # | Feature | Reuses | Notes |
|---|---|---|---|
| R1 | **PDF editing**: edit existing text at paragraph level, add text, move/resize/replace/delete images, add shapes, undo/redo | `engine/mupdf/content.py`, `engine/contentstream/`, `core/commands/`, `services/fonts.py` (`FontCatalog` pointed at an upload folder) | Fonts: the document's own fonts, the bundled standard fonts, and font files the user uploads. No system font enumeration (`system_font_dirs()` returns `[]` when `platform.capabilities.system_fonts` is off). |
| R2 | **Page reordering**: drag-and-drop thumbnails, rotate, delete, insert blank page, duplicate, extract, insert pages from another PDF | `services/pages.py` (`move_order`, `parse_page_ranges`), `engine/mupdf/pages.py`, `services/assembly.py` | |
| R3 | **Document splitting**: by page ranges, every N pages, by top-level bookmarks, by maximum size | `services/assembly.py` (`SplitMode`, `plan_split`, `write_split`, `safe_name`) | Output as several downloads or one ZIP (`zipfile`, stdlib, runs in Pyodide). |
| R4 | **Translation** of selected text (MyMemory, Azure AI Translator, LibreTranslate; DeepL Free is dropped, since W0.3 found its CORS preflight blocked) | `services/translation/` | In Pyodide the import of `urllib` works, `urlopen` fails (no sockets), and the client reports that as offline, so the web HTTP transport is injected (W2.4). Every endpoint must be listed in the static CSP, so **custom LibreTranslate servers and custom Azure endpoints aren't supported on the web** (a meta-tag CSP can't change at run time). Each service's CORS support is checked in W0.3 (`docs/web/spikes/W0.3-results.md`). |
| R5 | **Compressing**: presets, image downsampling and quality, removing unused objects, space audit | `services/optimize.py` (`reduce_size`, `audit`), `engine/mupdf/optimize.py`, `engine/mupdf/prune.py` | `linearize()` needs pikepdf. On the web it's hidden (capability off), and `optimize.py` must import pikepdf lazily (W2.2). |
| R6 | **Combining documents**: merge PDFs and images (PNG/JPEG), reorder sources, page ranges per source, keep bookmarks | `services/assembly.py` (`merge`, `describe_source`) | |
| R7 | **Printing** | `Page.render` (`RenderRequest.annotations` gives "include comments") | The browser's print dialog, through a hidden iframe of rendered pages, with page range. Printing is raster only (no vector printing in the browser). Pages render one at a time to blob URLs, which are revoked afterwards, so memory stays bounded. |

### Added: achievable from the desktop version

| # | Feature | Reuses |
|---|---|---|
| A1 | Viewer: single, continuous, two-page and two-page-cover layouts, zoom presets, fit page/width, Ctrl+wheel zoom | `core/layout.py` (layout maths run in the worker or are ported 1:1 with shared test vectors) |
| A2 | Thumbnails, bookmarks (view **and edit**), page labels (view and edit), internal links, navigation history | `services/thumbnails.py`, `model/outline.py`, `SetOutlineCommand`, `SetPageLabelsCommand` |
| A3 | Text selection, copying and full-document search (case, whole word, regex) | `services/search.py`, `services/text.py` |
| A4 | Comments and review: highlight, underline, strikeout, squiggly, sticky notes, text boxes, callouts, ink, lines, arrows, shapes; comments panel with replies and status | `engine/mupdf/annots.py`, `services/comments.py`, `core/commands/annotation_cmds.py` |
| A5 | Comment summary (CSV/HTML) and XFDF import/export | `services/comments.py`, `services/xfdf.py` |
| A6 | Stamps, watermarks, headers/footers, Bates numbering, backgrounds | `services/stamping.py`, `services/custom_stamps.py` |
| A7 | Redaction (mark, apply) and sanitizing (metadata, hidden content) | `services/redaction.py`, `engine/mupdf/sanitize.py` |
| A8 | Password protection and removing it (AES-256), permissions | `engine/mupdf/document.py`, `SetSecurityCommand` |
| A9 | Document properties: view and edit metadata, fonts list, PDF version, security | `model/metadata.py`, `core/xmp.py`, `SetMetadataCommand` |
| A10 | Export: pages to PNG/JPEG, text to TXT, and DOCX as a stretch goal if `services/export/ooxml.py` runs unchanged in Pyodide | `services/export/` (not `office.py`, which needs LibreOffice) |
| A11 | Compare two documents (text differences) | `services/compare.py` |
| A12 | Flatten annotations | `engine/mupdf/flatten.py` |
| A13 | Attachments: list and extract; optional-content layers on/off | engine |
| A14 | Light/dark theme, night-reading inversion, command palette, keyboard shortcuts | `ui/style/tokens.py` (already Qt-free: generate CSS variables from it), the shortcut table from `ui/shortcuts.py` (moved to a Qt-free module, W2.1) |
| A15 | Installable PWA that works offline after the first load; "Open with" via the File Handling API in Chromium | front end |

## Architecture

```
Browser main thread (TypeScript, React, Vite)
  web/src  views, tools, panels, dialogs, print, PWA shell
     |  typed RPC (postMessage, structured clone, Transferable ArrayBuffers)
     v
Engine worker (long-lived, one per open document set)
  Pyodide + PyMuPDF wasm wheel + fontTools + Pillow
  pdfeditor.webapi    <- NEW: RPC facade, JSON-serializable DTOs only
  pdfeditor.actions   <- NEW, shared with desktop: named operations -> Commands
  pdfeditor.services / core / engine / model   <- reused unchanged where possible
     |
     v  (for long, cancellable jobs only)
Job worker (disposable; same Pyodide image)
  receives a copy of the document bytes, runs optimize/compare/redact-apply/split...,
  returns result bytes; "Cancel" terminates the worker
```

Layer contract after this phase (import-linter `|` marks independent siblings):

```
pdfeditor.ui | pdfeditor.webapi
pdfeditor.actions
pdfeditor.services
pdfeditor.core
pdfeditor.engine
pdfeditor.model
```

Decisions (confirmed or refined in W1.1):

1. **One engine, no PDF.js.** Pages are rendered by MuPDF in the worker (`Page.render`) and sent as `ImageBitmap`/RGBA bytes. The text layer for selection comes from the engine's text model. This keeps rendering identical to desktop and avoids a second PDF parser in the attack surface.
2. **New shared layer `pdfeditor.actions`** (W2.1). Qt-free functions such as `actions.redaction.apply(session, ...)` or `actions.pages.rotate(session, pages, angle)`, which build and execute the right Command (including `SnapshotCommand` labels and Macro grouping that the desktop controllers build today). A registry maps a stable action name to a typed argument dataclass. Desktop controllers are refactored to call it, so the logic exists once.
3. **New top layer `pdfeditor.webapi`**, a sibling of `pdfeditor.ui`. It never imports `pdfeditor.ui` or PySide6. It exposes coarse-grained calls (open, render tile, run action, undo, save, split, merge, optimize, translate...) and returns plain dicts and bytes. Errors cross the boundary as `{code, message, details}`, with stable codes, so the front end can translate them.
4. **Engine isolation stays.** PyMuPDF is still imported only in `engine/mupdf/`. Platform differences go through capability flags (`engine.capabilities`, plus a new `pdfeditor.core.platform.capabilities`: `linearize`, `ocr`, `signing`, `system_fonts`, `office_import`, `threads`, `pdfa`, all false on the web; refined in [design/W1.1.md](design/W1.1.md) §3).
5. **Concurrency and cancellation without SharedArrayBuffer.** GitHub Pages can't set COOP/COEP headers, so there's no SharedArrayBuffer and no Pyodide interrupt buffer. A worker that is running Python synchronously can't receive a "cancel" message, though it can still *post* progress. So:
   - short calls (render, hit test, small commands) run in the engine worker;
   - read-only work that splits by page (search, thumbnails, comment list, space audit) runs as **chunked calls** in the engine worker: the front end asks for one slice at a time, and cancel means "stop asking" (W1.1 §1);
   - long jobs (optimize, compare, redaction apply, sanitize, split/merge of large files, export, print rendering) run in a **disposable job worker** on a copy of the bytes. One job worker per tab, kept warm, one job at a time. Cancel terminates it. The result is applied in the engine worker as a `SnapshotCommand` via `Document.load_state`, so it's undoable exactly like on desktop. A mutating job blocks edits for its duration (`DocumentSession.begin_task`); a read-only job doesn't;
   - `CancelToken` and progress callbacks are unchanged; in the job worker, progress is posted and cancellation is "terminate".
   - The `coi-serviceworker` trick (cross-origin isolation through a service worker) is noted as a later option, not a dependency.
6. **Files.** Open via file picker, drag and drop, and the File Handling API. Save via the File System Access API where supported (Chromium), otherwise download. Documents live in worker memory (`Document.open(bytes)`, `Document.to_bytes()`).
7. **Storage.** Pyodide's in-memory file system (MEMFS) makes `tempfile`, `SnapshotCommand` and `data_path()` work unchanged, at the cost of wasm memory. Those roots are not persistent: `data_dir()` resolves under `/home/pyodide` on MEMFS, so anything that must survive a reload goes to OPFS (W2.3). W2.3 adds a snapshot memory budget (oldest snapshots dropped, with "undo history shortened" shown). Crash-safe autosave goes to OPFS from the front end (bytes posted by the worker on idle; the main thread writes OPFS, the workers don't), deleted on close. Uploaded fonts are kept in OPFS until the user removes them (W1.1 §6). Moving snapshots themselves to OPFS is a later optimisation.
8. **Saving.** `DocumentSession` gains `save_bytes()`, sharing the incremental-vs-full decision with `save()` (signed documents saved "in place" stay incremental). It's verified by reopening the bytes in the engine before they're handed to the browser. Desktop `save()` is refactored onto the same code.
9. **Packages.** Pyodide pinned to one version. PyMuPDF wasm wheel built in CI from **the same PyMuPDF version the desktop uses** (version skew between the two engines is a bug source; if the wasm build forces a different version, the contract tests decide). `pdfeditor` is shipped as a web-only wheel or zip built from the same source tree, **installed without dependencies** (its `pyproject` dependencies include PySide6, pikepdf, pyhanko and winrt). It excludes `ui/`, `services/signing/`, `services/ocr.py`, `services/pdfa.py`, `services/store_updates.py`, `services/file_association.py`, `services/export/office.py` and `data/tessdata`.
10. **Size and start-up budget** (restated after W0.2, [spikes/W0.2-results.md](spikes/W0.2-results.md)). First load ≤ 40 MB compressed (Pyodide core plus wheels), cached by the service worker; measured 32.26 MB gzip. **First visit:** a progress screen with the load stages, and no hard time budget, since it depends on the network (at 50 Mbit/s the download alone is 5.2 s). **Repeat visit (cached):** page 1 within **4 s** on a mid-range laptop (gate). The old 6 s cold / 2 s warm figures stay as **targets**: W0.2 measured 8.0 s cold (2.8 s + download) and 2.6 s warm on a fast desktop, where about 2 s of the warm start is Pyodide start-up plus the PyMuPDF import. The measured savings are must-do items in W2.6, W3.1 and W4.6. The job worker reuses the cached assets and costs about 2.6 s and 181 MiB to start (W0.2), so it is started once per tab, after page 1 of the first document is shown, and kept warm, not per operation (W1.1 §1).
11. **Python version.** Pyodide 314.0.8's CPython 3.14 is newer than the desktop's 3.11, so shared code must run on both. The Pyodide CI job covers the newer one.

## Agent workflow and roles

Every task below has a role:

- **Design (Opus 5.5).** Writes a design note in `docs/web/design/<task-id>.md`: interfaces, data flow, file list, edge cases, test plan and acceptance criteria, small enough that each implementation task is unambiguous. Design notes are approved by the maintainer before implementation starts.
- **Implement (Haiku 5.5 subagent).** Implements exactly one task from its design note, with tests, following `AGENTS.md`. If the note is ambiguous or wrong, Haiku stops and reports instead of improvising. Haiku tasks are kept small (about one PR, ≤ ~400 changed lines excluding tests); tasks that are bigger are split below.
- **Review (Sonnet 5.5 subagent).** Reviews every implementation PR against the checklist below and posts findings as a PR review. Findings are fixed on the branch, and Sonnet re-reviews until no blocking findings remain. Then the PR merges with auto-merge after owner approval.

Loop per task: `Opus design → maintainer approves → Haiku implements → CI green → Sonnet review → fixes → Sonnet re-review → merge → tick in PLAN.md`.

**Branches.** Phase W is too big for AGENTS.md's "one branch per phase". W0.0 updates AGENTS.md to allow one branch per task for Phase W: `phase-w-<task-id>-<short-name>`, e.g. `phase-w-w2.1-actions-layer`.

### Code review checklist (Sonnet 5.5)

**Architecture and reuse**
- Layer contract respected (`lint-imports` passes; `webapi` never imports `ui` or Qt; PyMuPDF only in `engine/mupdf`).
- No Python feature logic duplicated in TypeScript or in `webapi`: if the change needs logic that lives in `ui/`, it was moved to `actions`/`services` first and the desktop uses it too.
- Capability flags used, not platform checks scattered through code.
- Every mutation is a Command and is undoable; round-trip test present (edit → save → reopen → verify).
- RPC messages are typed on both sides, versioned and validated; no Python objects leak over the boundary.
- Desktop app behaviour unchanged (desktop tests still pass; `build_exe.py --test` still ends with `RESULT: OK` and the exe doesn't grow).

**Security**
- PDFs are untrusted input: all parsing happens in the worker. No PDF-derived string reaches `innerHTML`, `eval`, `new Function` or a URL without escaping/validation. Annotation contents, bookmark titles, metadata, attachment names and link URIs are treated as untrusted.
- Links from PDFs: only `http`, `https` and `mailto` open, after a confirmation that shows the target; `javascript:`, `file:` and `data:` are blocked. PDF JavaScript is never executed. Launch actions and embedded files are never opened automatically.
- Strict Content Security Policy (meta tag): `default-src 'self'`; `script-src 'self' 'wasm-unsafe-eval'`; `worker-src 'self' blob:` (workers start from a `blob:` URL so they inherit this CSP, W1.1 §10); `connect-src 'self'` plus the fixed list of translation endpoints (the three origins in `spikes/W0.3-results.md`); `object-src 'none'`; `base-uri 'none'`; `require-trusted-types-for 'script'`; no third-party scripts, fonts or analytics. A meta-tag CSP can't set `frame-ancestors`, so clickjacking defence is a frame-busting check in the app (documented). `<meta name="referrer" content="no-referrer">`.
- Translation: opt-in with the one-time consent, only the selected text is sent, keys are never logged, never put in URLs and never persisted in plain text (kept in memory by default; optional persistence encrypted with WebCrypto using a user passphrase). This replaces `core/secrets.py` (DPAPI) through an injected secret store.
- No secrets, tokens or documents in `localStorage`; OPFS data deleted on close.
- Resource limits: maximum file size, page count, decompressed image size and render size, so a crafted PDF can't freeze the tab or exhaust wasm memory (graceful error instead).
- Downloads get safe file names (`services/assembly.safe_name`).

**Vulnerabilities and supply chain**
- Every dependency (npm, Pyodide, PyMuPDF/MuPDF, Python wheels) pinned with lockfiles and hashes; Subresource Integrity for any asset not served from our origin (preferably none).
- `npm audit`, `pip-audit` and GitHub Dependabot/CodeQL alerts clean or documented.
- MuPDF version tracked against its CVEs; an upgrade path documented (same version as desktop).
- No `postMessage` handler without a source and schema check; no wildcard target origins.
- Service worker caches only versioned app assets, never user documents.

**Also checked:** correctness and edge cases, test coverage and quality, performance (main thread never blocked > 50 ms; large documents), memory leaks (documents, bitmaps, blob URLs and workers freed on close), accessibility (keyboard, screen reader labels, contrast), i18n readiness, error messages, licence headers (AGPL), and docs updated.

## Tasks

This list defines the tasks. Progress is ticked in [PLAN.md](../../PLAN.md) (Phase W) and in the stage's sub-issue.

Legend: **[D]** design by Opus 5.5 · **[I]** implementation by a Haiku 5.5 subagent · **[D+I]** both · **[D+review]** design plus a whole-app Sonnet 5.5 review · every [I] task gets a Sonnet 5.5 review.

### W0: Tracking and feasibility spikes (these decide go/no-go)
- **W0.0 [I] Tracking.** Commit this plan (`docs/web/plan.md`); add Phase W (task list with checkboxes) to `PLAN.md`; AGENTS.md: the Phase W branch rule. Docs only.
- **W0.1 [D+I] PyMuPDF on Pyodide.** First check PyPI for a `pyemscripten` PyMuPDF wheel (PEP 783, Pyodide 314+). Otherwise build the wheel in CI with PyMuPDF's documented Pyodide route (its upstream `scripts/gh_release.py`) at the desktop's pinned version. In a headless browser: open, render, edit text, add an annotation, save and reopen a PDF. Run the `tests/engine` contract suite under Pyodide (Node or Playwright). Record what fails. **Go/no-go gate.**
- **W0.2 [I] Load size and speed.** Measure first-load size, cold/warm start (engine worker and job worker), render time per page and memory on 10, 200 and 1000-page fixtures. Compare against the budgets above. _(Done: see [spikes/W0.2-results.md](spikes/W0.2-results.md); budgets restated in decision 10.)_
- **W0.3 [I] Translation CORS check.** For MyMemory, Azure AI Translator (global endpoint), LibreTranslate (public instance) and DeepL Free, verify whether a browser `fetch` from our origin works. Services that block CORS are dropped from the web build (documented). _(Done: DeepL dropped; MyMemory, Azure and LibreTranslate allowed. See [spikes/W0.3-results.md](spikes/W0.3-results.md).)_
- **W0.4 [I] Import audit.** Import every module the web needs under Pyodide with the web package (no ui, no pikepdf, no PySide6); confirm fontTools, Pillow and `services/export` (except `office.py`) run. List anything that uses `ctypes`, `subprocess`, starts threads or reads OS paths. Done: see `docs/web/spikes/W0.4-results.md` (findings, the W2 work list, and the plan corrections).

### W1: Design (Opus 5.5)
- **W1.1 [D] Overall web architecture** note: engine and job workers, RPC protocol, layering (`actions`, `webapi`), capability flags, file handling, storage and memory budget, packaging of the web wheel, build and hosting. Includes a threat model (STRIDE) for untrusted PDFs, translation, RPC and the service worker.
- **W1.2 [D] RPC protocol spec**: message schema, versioning, error codes, progress, cancellation (job worker termination), binary transfer, and TypeScript types generated from the Python DTO dataclasses (single source of truth, checked in CI for drift).
- **W1.3 [D] Actions layer** (`pdfeditor.actions`): inventory of every Command construction in `ui/` (today: `main_window.py`, `protect_controller.py`, `tools_controller.py`, `tools/*.py`, `panels/*.py`, `page_ops.py`, `organize.py`, `contextual.py`, `dialogs/properties.py`, ...), the action names and argument dataclasses, and the order in which desktop controllers are migrated.
- **W1.4 [D] Rendering and viewport design**: tiles, zoom levels, cache sizes, prefetch, text layer, selection model, HiDPI. Which parts of `core/layout.py` and `core/render_cache.py` run in the worker and which are ported to TS with shared test vectors.
- **W1.5 [D] Editing tools design** in the browser: hit testing (in the worker, through the engine's object model), paragraph text editor (port of the input handling in `ui/view/text_editor.py`; layout and reflow stay in Python), image and shape handles, annotation tools.
- **W1.6 [D] UI/UX design**: layout (ribbon tabs Home, Edit, Comment, Organize, Protect, Tools, as on desktop), responsive behaviour down to tablet width, theming from `ui/style/tokens.py`, command palette, shortcuts, accessibility. Brand assets reused from `data/branding/elanero`.
- **W1.7 [D] Test strategy**: Python tests under Pyodide; round-trip checks split across the boundary (the edit and save run in Pyodide; the saved bytes are checked by pikepdf and pypdfium2 in host CPython, as AGENTS.md requires); TypeScript unit tests (Vitest); end-to-end tests (Playwright on Chromium, Firefox and WebKit); visual golden tests; performance budgets in CI.

### W2: Shared code made web-ready (Python, desktop keeps working)
- **W2.1 [I] `pdfeditor.actions` layer**, per W1.3, in slices of ≤ ~400 lines: (a) package, registry and import-linter contract update, plus page actions; (b) annotation and comment actions; (c) redaction, sanitize and security actions; (d) stamping, flatten, metadata and outline actions; (e) content-editing actions; (f) the web's shortcut table, `web/src/generated/shortcuts.json`, written by `scripts/make_shortcut_docs.py` from the desktop's commands and kept in step by its `--check` (W1.3 §5: `ACROBAT_DEFAULTS` holds only 5 entries, so moving it wouldn't carry the shortcuts). Each slice moves the desktop controllers onto the new functions, and the desktop tests stay green. The 42 actions are listed in [design/W1.3.md](design/W1.3.md) (41, plus `annotations.create` from W1.5); OCR, auto-tag, PDF/A and the tag editor stay in `ui/` (desktop-only).
- **W2.2 [I] Platform capabilities**: `core/platform.py` with `linearize`, `ocr`, `signing`, `system_fonts`, `office_import`, `threads`; `services/fonts.system_font_dirs` and the export registry respect the flags. From the W0.4 audit:
  - `engine/mupdf/ocr.py` imports the excluded `ocr_worker` at module level (L25), and `engine/mupdf/page.py` imports `ocr` (L14), so the whole engine can't import on the web. Move the `ocr_worker` import into `text_layer()`, with `ocr` off on the web.
  - `services/optimize.py`: `linearize` and `_is_encrypted` import pikepdf lazily (the encryption check goes through the engine); `Document.optimize` works without pikepdf.
  - TIFF on the web uses LZW: `services/export/images.py` takes its compression from the platform instead of hardcoding `tiff_deflate` (L56, L97). Deflate must never be tried on the web, because a failed deflate write aborts the Pyodide runtime.
- **W2.3 [I] Bytes and storage**: `DocumentSession.save_bytes()` sharing the incremental/full decision with `save()` (desktop refactored onto it); verify by reopening; a snapshot memory budget in `SnapshotStore`; an injectable secret store replacing the direct `core/secrets.py` calls. Named items: `core/paths.data_dir()` takes an injected root (its default is MEMFS, `/home/pyodide`); autosave recovery goes to OPFS, since MEMFS is lost on reload; the font source is bundled or user-uploaded files, because `system_font_dirs()` is `[]` on the web; the secret store has a web backend (no DPAPI there).
- **W2.4 [I]** `services/translation/http.py`: injectable HTTP transport; the default stays `urllib` (desktop unchanged). The web opener is a synchronous `js.XMLHttpRequest` with the existing `Opener` signature, injected via `TranslationConfig.opener` (update that field's "tests only" comment in W2.4). It omits `User-Agent` (a forbidden header in browsers), sets `timeout` and `withCredentials=false`, maps network and CORS failures to `OSError` (which the client reports as `OfflineError`), and maps the status and body to `Reply`. No client changes. It must be tested in a real browser, and the per-service CORS result comes from W0.3: no DeepL transport (blocked by CORS). Rejected: an async path (every client and `Translator` would change), a TypeScript-side fetch (restructures the clients), JSPI `run_sync` (not in all browsers), `pyodide-http` (an extra dependency, and it sends User-Agent), and `open_url` (GET only).
- **W2.5 [I]** `core/jobs.py` and `core/render_cache.py` start no threads (`Event` and `Lock` work in Pyodide). The thread starter is `ui/jobs.py` (QThreadPool, excluded), so the web needs an inline runner in its place, with the same `CancelToken` and progress API. `core/jobs.py` needs no `threads` flag.
- **W2.6 [I] Web package build**: `scripts/build_web_wheel.py` builds the trimmed `pdfeditor` wheel (exclusions in decision 9). A desktop-CI test imports every module of the web set (the list in `web/spike/web_package.py`, 95 modules) with `PySide6`, `pikepdf`, `pyhanko`, `pkcs11` and `numpy` blocked in `sys.modules`, and it imports `pdfeditor.engine.mupdf` itself (W0.4: one missed edge there cascades to 17 modules). It's a cheap guard that runs without a browser. Must-do from W0.2: leave the branding assets (5.46 MB gzip of `data/`) out of the web package or load them lazily; ship fonttools and Pillow (2.15 MB gzip) only when editing needs them.
- **W2.7 [I]** CI job running the engine, core, actions and services tests under Pyodide, plus the host-side round-trip verifier.

### W3: Engine worker and RPC (`pdfeditor.webapi` + `web/src/worker`)
- **W3.1 [I]** Worker bootstrap: load pinned Pyodide and wheels from our origin, report progress, handle load failure. The same bootstrap starts job workers. Must-do from W0.2: show a progress screen with the load stages on the first visit; start loading the document while packages load and render page 1 as early as possible; evaluate a Pyodide memory snapshot to cut the ~0.9 s Pyodide start-up and ~0.9 s PyMuPDF import; start the job worker once per tab, after page 1 is shown (decision 5). Workers are created from a `blob:` URL that imports the same-origin worker module, so the page's CSP applies inside them; the job worker removes `fetch`, `XMLHttpRequest`, `WebSocket` and `importScripts` before Pyodide loads, and the engine worker's `XMLHttpRequest` allows only the translation origins (W1.1 §10).
- **W3.2 [I]** `webapi.session`: open from bytes (with password prompt flow), close, document info, page sizes, capabilities.
- **W3.3 [I]** `webapi.render`: render page/tile at a scale to RGBA bytes, transferred without copying.
- **W3.4 [I]** `webapi.text`: text layer, selection to text, search with progress (large documents through the job worker).
- **W3.5 [I]** `webapi.actions`: run a named action with validated arguments, undo, redo, dirty state, page-revision events. Replies carry `changed`/`state` events with page revisions and `structure_version`, so the front end never polls ([design/W1.2.md](design/W1.2.md) §7).
- **W3.6 [I]** `webapi.save`: `save_bytes` (full, or incremental when signed), verified, returned as bytes.
- **W3.7 [I]** `webapi.jobs` + job worker protocol: send bytes and a job spec, stream progress, return result bytes, apply as `SnapshotCommand`; cancel = terminate. Protocol: `jobs.prepare` → `job.run` → `jobs.apply`/`jobs.abort` with a single-use token (W1.2 §13).
- **W3.8 [I]** TypeScript RPC client with generated types, timeouts, cancellation and error-code mapping. Types and reply validators are generated by `scripts/make_web_types.py`, with a `--check` drift test; no runtime schema library (W1.2 §14).
- **W3.9 [I]** Resource limits and guarded errors (file size, pages, render size, wasm out-of-memory recovery: restart the worker and reopen from the OPFS autosave).

### W4: Front-end shell (TypeScript, React, Vite)
- **W4.1 [I]** Project scaffold in `web/` (Vite, React, TypeScript strict, ESLint, Prettier, Vitest, Playwright), CSP meta tag, AGPL source link in About (exact commit).
- **W4.2 [I]** App shell: start page with open, drag and drop, recent files (names only, stored locally), tabs for several documents, a `beforeunload` warning for unsaved changes.
- **W4.3 [I]** Ribbon, command registry, command palette (Ctrl+Shift+P), shortcuts (from `web/src/generated/shortcuts.json`, W2.1 (f)).
- **W4.4 [I]** Theme (light/dark, CSS variables generated from `ui/style/tokens.py`), icons from `data/icons`, toasts, job progress centre.
- **W4.5 [I]** Preferences dialog (stored locally; no secrets in `localStorage`).
- **W4.6 [I]** PWA: manifest, service worker with versioned cache, offline after first load, update prompt, File Handling API. Must-do from W0.2: the service worker caches the versioned Pyodide core and wheels, so a repeat visit makes no network request before page 1 (W0.2 found the 18 MB wheel refetched when the browser cache dropped it).
- **W4.7 [I]** Message catalogue (i18n) and the mapping from RPC error codes to messages: one key per code (`error.<CODE>`), checked by a test against the generated `ErrorCode` union (W1.2 §4).

### W5: Viewer and navigation (A1–A3)
- **W5.1a [I]** Document view: virtualised page list, single and continuous layouts, zoom and fit modes. Layout maths ported to TS and checked against shared vectors from `scripts/make_web_vectors.py`; a scaled scroll space above 8 million CSS px ([design/W1.4.md](design/W1.4.md) §7, §12).
- **W5.1b [I]** HiDPI tiles, render cache and prefetch: whole page up to 4 MP, 1024-px tiles above; `ImageBitmap`s made in the worker; a main-thread render queue (2 in flight, priorities, stale requests dropped); `tile_grid` moved into `core/layout.py`; the backend's page and display-list caches bounded to 64 pages (desktop too) (W1.4 §4–§6).
- **W5.1c [I]** Two-page and two-page-cover layouts, Ctrl+wheel zoom, night-reading inversion (a CSS `invert(1)` filter, no re-render; W1.4 §8).
- **W5.2 [I]** Side panels: thumbnails, bookmarks (with editing), attachments, layers.
- **W5.3 [I]** Links (scheme allow-list and confirmation) and navigation history, page jump, page labels.
- **W5.4 [I]** Text selection and copy; search panel. The desktop selection model (`PageTextIndex` queries, `TextSelection`) ported to TS with shared vectors; hidden DOM text spans for screen readers; large copies and search as chunked worker calls (W1.4 §10).

### W6: Required features
- **W6.1 [I] R2 Page organizer**: grid of thumbnails, drag-and-drop reorder, multi-select, rotate, delete, insert blank, duplicate, extract, insert from file; all undoable.
- **W6.2 [I] R3 Split dialog**: modes from `SplitMode`, preview of the resulting files, download as files or ZIP.
- **W6.3 [I] R6 Combine dialog**: add PDFs and images, reorder, remove, page ranges per source, merged bookmarks.
- **W6.4 [I] R5 Compress dialog**: presets, custom options, space audit before and after, result size (job worker).
- **W6.5 [I] R7 Print**: page range, scale, include comments, print via iframe; progress for large documents. 150 dpi PNG pages (300 dpi option) encoded in the worker and streamed; job worker above 10 pages; warning above 200 pages (W1.4 §11).
- **W6.6 [I] R4 Translate**: bubble on selection, consent notice, service settings, From/To pickers, Copy, Add as note; Preferences → Translation. No DeepL row and no LibreTranslate server-address row (the public instance is fixed by the CSP).
- **W6.7a [I] R1a** Edit tool: object outlines, the per-revision object cache, hit testing in TS with shared test vectors, selection, move and resize handles, delete, `STALE_OBJECT` handling, the signed-document warning ([design/W1.5.md](design/W1.5.md) §2–3).
- **W6.7b [I] R1a** Add shapes; add, replace and export images (add text moved to W6.8a, since it needs the paragraph editor).
- **W6.8a [I] R1b** In-place paragraph editor: a native textarea over the block, previewing the document's own font (`content.preview_font`, CSS Font Loading API); typing, IME, clipboard and in-editor undo are the browser's; Python lays the text out on commit (`content.replace_text`/`content.add_text`), not per keystroke; Add Text tool; the substitution notice (W1.5 §5).
- **W6.8b [I] R1b** Style bar and font picker (document, standard, uploaded fonts; no installed-fonts section).
- **W6.9 [I] R1c Font upload**: load a TTF/OTF/TTC, validate with fontTools, respect embedding restrictions (reuses the `FontCatalog` checks; `INVALID_FONT`, `FONT_NOT_EMBEDDABLE`); kept in OPFS, loaded at start-up, removable (W1.5 §7).

### W7: Added features
- **W7.1a [I] A4** Comment tools: the shared Python builders and the `annotations.create` action (unless W2.1 (b) already has them), each tool's gesture and preview, comment selection, move and resize, note popup (W1.5 §6).
- **W7.1b [I] A4** Comments panel (replies, status, filter), contextual bar and inspector restyle.
- **W7.2 [I] A5** Comment summary export and XFDF import/export.
- **W7.3 [I] A6** Stamps, watermarks, headers/footers, Bates, backgrounds.
- **W7.4 [I] A7** Redaction and sanitize (apply runs in the job worker; leak test required).
- **W7.5 [I] A8** Password protection and permissions.
- **W7.6 [I] A9** Document properties and metadata editing.
- **W7.7 [I] A10** Export pages as images and text (DOCX if W0.4 allows).
- **W7.8 [I] A11** Compare documents.
- **W7.9 [I] A12–A13** Flatten annotations; attachments and layers.

### W8: Quality
- **W8.1 [I]** End-to-end tests (Playwright) for every required feature on Chromium, Firefox and WebKit, including round trips (edit → save → reopen, plus the host-side pikepdf/pypdfium2 check).
- **W8.2 [I]** Visual golden tests for rendering, comparing with desktop output (same MuPDF version, so near-identical; the desktop goldens' tolerance).
- **W8.3 [I]** Performance tests in CI with the budgets in decision 10 (repeat visit ≤ 4 s gate; the 6 s / 2 s targets tracked as trends; CI runners vary by up to ~40%, so compare against a pinned baseline, not absolute numbers) (load, first page, scroll on a 1000-page file, save, job-worker start; viewer budgets in W1.4 §14).
- **W8.4 [I]** Fuzz/robustness: open the malformed fixtures and a fuzzed corpus in the worker; the app must show an error, never hang the tab.
- **W8.5 [I]** Accessibility: keyboard-only walkthrough, axe-core checks in CI, screen reader labels, contrast in both themes.
- **W8.6 [D+review] Security review** by a Sonnet 5.5 subagent of the whole web app against the threat model in W1.1 (not just per PR): CSP, RPC, link handling, translation, storage, service worker, dependencies. Opus 5.5 designs fixes for anything structural.

### W9: Build, release and docs
- **W9.1 [I]** CI: build wheels (PyMuPDF wasm, pdfeditor web wheel), build the front end, run tests, check size budget; cache the PyMuPDF build. Extend `scripts/ci_changes.py` so desktop-only changes skip web jobs and the other way round. New jobs get new names (not `changes`, `checks`, `test-windows` or `build`); whether a web job becomes a required check is a ruleset change the owner makes.
- **W9.2 [I]** Deploy to GitHub Pages under `/app/` via `scripts/build_site.py`, next to the landing page and guide; versioned asset names. Must-check from W1.1 §9: measure the wire size of the wheels and `pyodide.asm.wasm` on the preview deployment; if Pages doesn't compress them, store them gzip-compressed and inflate them in the worker with `DecompressionStream`.
- **W9.3 [I]** User guide: a "Web version" page (what's different from desktop, browser support, privacy, offline use, desktop/web parity table) and updated pages for each feature.
- **W9.4 [I]** `PRIVACY.md` and landing page: the web version, what's stored locally, what translation sends.
- **W9.5 [I]** `AGENTS.md`: web commands and rules (web layer, RPC, CSP, no SharedArrayBuffer); third-party licence list includes Pyodide (MPL-2.0) and npm packages (`licenses.py` extended or a generated list).
- **W9.6 [I]** Release checklist in `RELEASING.md`: web versioning, cache busting, rollback.

## Other aspects

- **Browser support:** current Chrome, Edge, Firefox and Safari (desktop); iPad Safari best effort. Saving in place only where the File System Access API exists; elsewhere Save downloads a copy (explained in the UI).
- **Memory:** wasm32 is limited to about 2–4 GB, and each worker has its own heap (a job worker roughly doubles memory while it runs). Documents over a configurable size (start at 200 MB) get a warning. Render caches and the snapshot store are bounded.
- **Desktop exe unaffected:** `web/` and `pdfeditor.webapi` are excluded from the PyInstaller build. `pdfeditor.actions` is included (the desktop uses it). The 150 MB budget and `--self-test` still apply.
- **Licensing:** the app is AGPL-3.0-or-later, as is PyMuPDF/MuPDF. Pyodide is MPL-2.0 and React is MIT, both compatible. The web app must offer its source (AGPL §13): an About link to the exact commit.
- **Privacy:** no analytics, no CDN, no third-party requests; everything is served from our origin. Translation is the only outbound call and is opt-in.
- **Internationalisation:** front-end strings go through one message catalogue, ready for Bulgarian and other languages later. Python errors cross the RPC boundary as codes, so they can be translated too.
- **Error handling:** worker crash → restart and offer to reopen from the OPFS autosave; clear messages for password-protected, damaged and too-large files.
- **Desktop parity tracking:** a table in the guide marks each feature as available on desktop only or on both.

## Milestones

- **M-W0:** W0 spikes pass (go/no-go). If PyMuPDF on Pyodide fails the gate, stop and revisit (alternative: the MuPDF.js WASM build with a TypeScript service layer, a much larger rewrite that would reuse little Python).
- **M-W1:** Viewer MVP: W1–W5 (open, view, search, select, save), deployed as a preview.
- **M-W2:** Required features: W6 (R1–R7).
- **M-W3:** Added features: W7.
- **M-W4:** Release: W8 and W9.

## Rough effort

About 6–9 months part-time for one maintainer supervising the agents. W0 is about 2–3 weeks and decides the rest. The largest pieces are W2.1 (moving orchestration out of the desktop UI, which pays off for both apps), W1.5/W6.8 (in-browser text editing) and W5.1 (a smooth viewer on large files).

## Review notes (2026-11-16)

Gaps found when the first draft was checked against the code, and how this version fixes them:

1. **Orchestration lives in the desktop UI.** Controllers build Commands themselves (`SnapshotCommand(label, op, ...)` in `protect_controller.py`, `tools_controller.py`, `tools/edit.py`; Macro grouping in `main_window.py`). As drafted, a "run a named command" RPC would have needed that logic rewritten. Fix: the shared `pdfeditor.actions` layer (decision 2, W1.3, W2.1).
2. **The package can't be installed in Pyodide as is.** Its dependencies include PySide6, pikepdf, pyhanko, python-pkcs11 and winrt, and `services/optimize.py` imports pikepdf at module level, so `reduce_size` would fail to import. Fix: a trimmed web wheel installed without dependencies, a lazy pikepdf import and an import-guard test (decision 9, W2.2, W2.6).
3. **Cancellation was impossible as designed.** Without SharedArrayBuffer, a worker busy in synchronous Python can't receive a cancel message. Fix: a disposable job worker whose result is applied as a `SnapshotCommand` (decision 5, W3.7).
4. **CSP vs. configurable endpoints.** A meta-tag CSP is static, so "only the endpoints the user enabled" and custom LibreTranslate/Azure hosts can't work. Fix: a fixed endpoint list, with custom hosts out of scope on the web (R4).
5. **The round-trip rule couldn't run under Pyodide** (pikepdf and pypdfium2 aren't available there). Fix: host-side verification of bytes saved in Pyodide (W1.7, W2.7).
6. **Path-only saving and OS-specific code.** `DocumentSession.save` takes only a path; `core/secrets.py` uses DPAPI via ctypes; `services/fonts.system_font_dirs` reads `WINDIR`. Fix: W2.2, W2.3. MEMFS makes `tempfile` work, so OPFS-backed snapshots became an optimisation, not a prerequisite (decision 7).
7. **Engine version skew.** The wasm PyMuPDF must match the desktop pin (decision 9, W0.1). PyMuPDF still documents a self-built wheel for Pyodide; PEP 783 (Pyodide 314) now allows `pyemscripten` wheels on PyPI, so check there first.
8. **Task size and order.** W5.1, W6.7 and W6.8 exceeded the Haiku task size and were split. Tracking (PLAN.md, branch rule) moved to W0.0, since AGENTS.md requires PLAN.md to track progress from the start. CI job names must not collide with the required checks (W9.1). The desktop exe must not change (Other aspects).
9. **More reuse.** Bookmark and page-label editing (existing Commands), insert pages from a file, theme tokens from `ui/style/tokens.py` and the shortcut table added to scope.
