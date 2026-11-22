# AGENTS.md

Guidance for AI coding agents and human contributors working in this repository.

## What this project is

An Acrobat-style desktop PDF editor in Python: PySide6 (Qt 6) UI on top of an **abstract PDF
engine layer**, implemented first with PyMuPDF. The roadmap and live progress are in
[PLAN.md](PLAN.md). Forms authoring is **out of scope** for now, but existing forms must render
and survive saving. Digital signing is in scope (Phase S), and existing signatures must survive
saving too.

## Progress tracking (required)

- User-facing features also update the matching page in `docs/guide/` (the user guide), in the same change.
- `PLAN.md` is the single source of truth for progress. When you finish a todo item, tick its
  checkbox (`- [x]`) in the same change. Only tick an item when its tests and checks pass.
- If an item is done only partially, leave it unticked and append a short note, e.g.
  `- [ ] … _(partial: X done; Y pending)_`.
- Work phases in order unless the plan says otherwise. Don't start UI for a feature before its
  engine/service layer has tests.

## Setup and commands

```sh
uv venv --python 3.11 .venv
uv pip install -e ".[dev]"            # add ",ocr,export" for optional features
uv run python scripts/make_fixtures.py  # regenerate tests/fixtures/generated (git-ignored)
uv run pytest                          # all tests; GUI tests need QT_QPA_PLATFORM=offscreen headless
uv run pytest -m "not slow"            # quick loop
QT_QPA_PLATFORM=offscreen uv run pytest -n auto  # parallel (pytest-xdist, ~40 s locally); the serial run above stays the reference
uv run ruff check . && uv run ruff format .
uv run lint-imports                    # architecture contracts
uv run mypy
uv run python -m pdfeditor [file.pdf]  # launch the app
uv run python -m pdfeditor --self-test # end-to-end smoke test (no window)
uv pip install -e ".[build]" && uv run python scripts/build_exe.py --test  # dist/Elanero.exe
```

Before calling a task done, run: `ruff check`, `ruff format --check`, `lint-imports`, `mypy`,
and `pytest`. All must pass.

CI runs once per PR, and not again after the merge: `scripts/ci_changes.py` skips what a PR can't
affect (docs-only PRs run nothing), and PRs run only the Windows tests, without the performance
budgets. The nightly run and every release run everything.

## Web version

The browser build is `web/app` (React and Vite, with the engine in Pyodide workers). Its Python
side is `pdfeditor.webapi`, packed by `scripts/web_package.py`. Run the npm commands in `web/app`.

- `npm ci`, then `npm run dev`, `npm run build`, `npm run typecheck`, `npm run lint`,
  `npm run format:check`, `npm test` (Vitest). `npm run tokens:check` fails when `tokens.css` is stale.
- Playwright: `npx playwright install --with-deps chromium`, then `npx playwright test`. The
  engine-load spec needs the engine assets first: from the repo root run
  `node scripts/stage_engine_assets.mjs --wheel <pymupdf-wasm.whl> --zip dist/web/pdfeditor-web.zip`
  (or set `PYMUPDF_WHEEL` and `WEB_ZIP`), after `npm ci` in `web/spike`.
- Feature round trips (W8.1): `npm run e2e:features:chromium` in `web/app` runs them on Chromium, after the
  same staging; `npm run e2e:features` runs all three browsers. The `web-e2e` workflow runs all three nightly;
  on demand it runs Chromium only unless its `browsers` input is `all`. It reads the PyMuPDF wheel from the
  cache that a `web-pytest` run on main fills, and does not build one. `web-a11y` (axe, three browsers) runs on
  demand only. Neither is a required check.
- Pyodide run (CI's `web-pytest` job, from the repo root): `npm ci` in `web/spike`,
  `python scripts/make_fixtures.py`, `python scripts/build_web_wheel.py`, then
  `PYMUPDF_WHEEL=<web/spike/dist/wheel-build/*.whl> WEB_ZIP=dist/web/pdfeditor-web.zip node web/test/pyodide/run_tests.mjs`,
  then `python scripts/web_host_verify.py web/test/pyodide/out/host-checks.json` and `python scripts/check_web_skips.py`.
  CI builds the wheel by PyMuPDF's Pyodide route (`wheelRoute` and the pins in `web/spike/versions.json`)
  into `web/spike/dist/wheel-build`, and checks it against `wheel.sha256` there.
- Web rules: no inline script or style. The policy in `web/app/src/csp.ts` allows scripts and styles
  only from `'self'` (scripts also get `'wasm-unsafe-eval'` for the engine); `index.html` carries the
  same policy, and `csp.test.ts` fails on drift.
- Every user-facing string goes through `t()` (`web/app/src/i18n/t.ts`), with its key in `web/app/src/i18n/en.ts`.
- Generated files are regenerated, never hand-edited: `web/app/src/rpc/generated.ts` by
  `python scripts/make_web_types.py` (`--check` for drift), `web/app/src/theme/tokens.css` by `npm run tokens`,
  `web/app/src/theme/icons.generated.ts` by `npm run icons` (from the SVGs in `src/pdfeditor/data/icons/`; `icons:check` for drift),
  `web/app/public/THIRD_PARTY_LICENSES.txt` by `uv run python scripts/make_web_licences.py` (`--check` for
  drift; `--verify-installed` after `npm ci` in `web/app` checks each copyright line against node_modules).
- A new runtime npm package or engine component (anything the browser ships) needs an entry in
  `scripts/web_licences.toml`: the npm entry's `version` and `copyright` read from the package's own
  licence file, and a component's licence and copyright from its source. A lock bump of a listed package
  fails `--check` until its entry is re-read. Anything not verified from the repository is marked
  "To confirm" in its note, never guessed.
- The engine runs only in the workers under `web/app/src/engine/`, never on the main thread.
- No SharedArrayBuffer (GitHub Pages sets no COOP/COEP), so a running engine job is cancelled by
  discarding its worker (docs/web/plan.md, decision 5), not by an interrupt buffer.
- PyMuPDF rule (above) applies to `pdfeditor.webapi` and `web/` too.
- Web-pytest: a test file that imports pikepdf or pypdfium2 at module level is skipped under Pyodide
  and counted against `web/test/pyodide/host-skip-budget.json`, whose budgets only go down. Use
  `tests.hostcheck.record` with a `@host_check` (see `tests/unit/test_webapi_save.py`) instead, and
  do not add budget entries. Tests marked `desktop_only` are not run under Pyodide.
- Web package: `scripts/web_package.py` ships every `src/pdfeditor` module and data file not in its
  `EXCLUDED` tuple. A module that must not ship goes there, with a comment giving the reason.

## Architecture rules (enforced)

Layers, top to bottom. A layer may import only from layers below it (import-linter contract
"Layered architecture"):

```
pdfeditor.ui        PySide6 widgets, tools, panels, dialogs
pdfeditor.services  feature logic (search, redaction, OCR, compare, export, ...)
pdfeditor.core      DocumentSession, undo/redo commands, jobs, render cache, autosave
pdfeditor.engine    base.py Protocols + backends (engine/mupdf) + contentstream parser
pdfeditor.model     pure-Python dataclasses: geometry, text, annotations, outline, ...
```

1. **Engine isolation.** `pymupdf`/`fitz` may be imported **only** inside
   `pdfeditor/engine/mupdf/`. Everything else talks to the `engine/base.py` Protocols and
   `model/` types. Libraries that themselves depend on PyMuPDF (`pdf2docx`, `pymupdf4llm`) are
   also backend-only. Dev scripts in `scripts/` and tests in `tests/engine/mupdf*` may use
   PyMuPDF directly.
2. **Capabilities, not isinstance.** Features check `engine.capabilities` flags; the UI hides or
   disables actions that the active engine can't do.
3. **`model/` stays pure.** No Qt, no engine imports, no I/O. Frozen dataclasses where practical.
4. **Qt stays in `ui/`**, with narrow exceptions in `core/` for `QThreadPool`/`QUndoStack`
   wrappers. Services must be usable headless (CLI/tests).
5. **Every mutation goes through a Command** (`core/commands/`) so it's undoable. Reversible
   ops implement a real inverse; destructive ops (content edit, redaction, OCR, optimize) use
   the disk-backed `SnapshotCommand`.
6. **Thread safety.** MuPDF isn't thread-safe, not even across documents. Every engine call
   holds `session.lock`, which is the process-wide `ENGINE_LOCK` (`core/engine_lock.py`).
   Automatic cyclic GC is disabled; `engine_lock.collect()` runs it under the lock (a window
   timer, and after each test). Never keep PyMuPDF objects outside the engine package, since
   freeing one outside the lock can corrupt MuPDF's heap. Mutations bump the page revision so
   cached tiles are invalidated.
7. **Safe saving.** Write to a temp file, verify by reopening, then atomically replace. Use
   incremental save when the document has signatures. Never silently flatten forms/signatures.

## Self-contained executable (required)

The product ships as one `Elanero.exe` (PyInstaller one-file, `packaging/pdfeditor.spec`).
No feature may need Python, an installer or an external tool at runtime.

- Bundled files go in `src/pdfeditor/data/` and are read only through
  `pdfeditor.bundle.data_path()`. Never use paths relative to the source tree or tools on PATH.
- A new runtime dependency must work frozen. Check that its imports are found (add
  `hiddenimports` for lazy or dynamic imports), that its data files are collected, and that
  nothing under `DEV_EXCLUDES` is needed. If you start using a package excluded there (such as
  numpy), remove it from the list.
- Extend `pdfeditor/selftest.py` when you add a subsystem that could break only when frozen
  (new native library, bundled data, plugin).
- `uv run python scripts/build_exe.py --test` builds the exe and runs `--self-test`. CI does the
  same on PRs that change code (size budget: 150 MB), in one run that also writes the app folder
  (`--all`). Every package is made from that one build (`--skip-build --msix`, `--skip-build
  --installer`), so a pipeline only builds the app once.
- External programs (LibreOffice, Ghostscript, veraPDF) may only power optional extras, detected
  at runtime, with a clear message when they're missing.

## Coding conventions

- Python ≥3.11, `from __future__ import annotations`, full type hints. `mypy --strict` applies to
  `model/`, `engine/base.py` and `core/`.
- Ruff config in `pyproject.toml` (line length 100). Match surrounding code's naming and comment
  density; docstrings explain *why*, not *what*.
- Use `logging.getLogger(__name__)`; no `print` in the package.
- Page coordinates everywhere above the engine are in the page's **visible space**: points,
  origin top-left, with the page's /Rotate and CropBox applied (what `Page.rect` describes and
  `Page.render` draws). Backends convert their native coordinates (MuPDF reports text, links and
  annotations unrotated). View rotation and zoom are applied only in `ui/view/`.
- Long-running work (OCR, compare, export, optimize, big searches) runs as a cancellable `Job`
  with progress, never on the GUI thread.

## Testing conventions

- Fixtures: use the `fixture_pdf("name")` pytest fixture (see `tests/conftest.py`). Add new
  synthetic fixtures to `scripts/make_fixtures.py`; never commit generated PDFs. Real-world
  samples go in `tests/fixtures/real/` with their source and license noted in its README.
- **Round-trip rule:** every editing feature needs a test that edits → saves → reopens →
  asserts, and the saved file must open in **pikepdf** and render in **pypdfium2** (independent
  implementations), not just in MuPDF.
- Engine behavior is specified by contract tests in `tests/engine/` written against the
  Protocols, so a future permissive backend can reuse them.
- GUI tests use `pytest-qt` (`qtbot`) and the `gui` marker; mark slow tests `slow`.
- Rendering golden images live in `tests/golden/`; compare with a tolerance, not byte equality.
- Redaction features must include a leak test (re-extract text / inspect pixels under marks).

## Licensing

The default backend (PyMuPDF) is AGPL, so the project is AGPL-3.0-or-later. Don't add
dependencies with licenses that conflict with AGPL, and record every new runtime dependency in
`pyproject.toml` (optional features go in an extra, not in core `dependencies`).

## Git workflow

- One branch per plan phase (`phase-N-short-name`), branched from an up-to-date `main`.
- Phase W (the web version, [docs/web/plan.md](docs/web/plan.md)) is too big for one branch: it uses one branch per task, `phase-w-<task-id>-<short-name>` (e.g. `phase-w-w2.1-actions-layer`), and each PR ticks its task in `PLAN.md` (and in the stage's sub-issue).
- When the phase's checks pass: commit, push, open a PR against `main`, review it, and turn on
  auto-merge (squash). It merges once the owner approves and the required CI checks pass, and
  GitHub deletes the branch. Only a code owner's approval counts (ruleset on `main`). Commit
  messages and PR bodies follow the repo's attribution settings. The auto-merge step is gated by the
  "Agent roles and the issue procedure" section: turn it on only after the review, the owner's approval,
  and a checked spec run when browser specs are touched.
- The required checks are CI's `changes`, `checks`, `test-windows`, `build`, `web` and
  `web-tests / web-pytest` (the web-pytest job, called by CI's `web-tests` job). They always
  report on every PR (a skipped one counts as passed; `web-tests / web-pytest` runs and skips
  its steps without web changes), so a docs-only PR isn't blocked. Don't rename those jobs, and
  don't give another workflow a job with one of those names, without updating the ruleset.
- After each phase is merged, build the executable from the updated `main`:
  `uv run python scripts/build_exe.py --test` (writes `dist/Elanero.exe`, must end with
  `RESULT: OK`), and report the size and self-test result.
- If a pre-commit hook modifies files and aborts the commit, `git add` and run the same
  `git commit` again. Never use `--amend` for this: it amends the previous (possibly merged)
  commit. Never rewrite or force-push shared history; fix mistakes with new commits.
- GitHub doesn't let a PR's author approve it. When the reviewer is the same account, post the
  review with `gh pr review --comment` (verdict, findings, follow-ups), fix findings on the
  branch, wait for green CI, then merge.

## Agent roles and the issue procedure (required)

Agent work on an issue or PLAN item follows this procedure. If a step cannot be done, stop and report
which step and why, instead of skipping it.

### Roles and models

- **Design and architecture: Opus 5.5 subagent.** Writes the design note and the slice plan. Writes no
  production code.
- **Code review: Sonnet 5.5 subagent.** Read-only. Posts `gh pr review --comment`. Never approves, never
  requests changes, never edits code, never merges.
- **Implementation and other general work: Haiku 5.5 subagent.** Implements one approved slice on its own
  branch and runs the checks. Also used for docs and mechanical fixes.
- Decisions the owner would make go to an Opus subagent, which decides what is best for the project and
  records the decision and its reason under "Owner decisions" in the design note. The final report lists
  those decisions.
- The coordinator (the main session) starts subagents, routes their results, and merges only under the
  rules below. It does not write production code itself.

### The order for an issue or PLAN item

1. **Find the work on `origin/main`.** Read the issue, the matching PLAN.md item and its design entry.
   Check for an existing design note and for open PRs that touch the same files. Check whether the work is
   already done on main. If it is, verify it with a test on main and close the issue with that evidence.
   Do not reimplement. Do not start work whose dependency is unmerged.
2. **Design note approved before any implementation.** An Opus subagent writes the note on its own branch:
   `phase-w-<task-id>-design` for a Phase W item, and `docs-<short-name>` for any other design PR.
   It holds the verified status (file and line evidence), the design, the slice plan, the tests and where
   each runs, the risks, and the questions for the owner, each with a recommended answer. Its status line
   reads `**Status: proposed, for owner approval; no production code in this change.**` The path is
   `docs/web/design/<id>.md` for Phase W. Other issues record their note at the path their issue or PR
   names. The owner reviews the design PR and approves it. The coordinator then merges it by hand, after
   the approval. A design PR never gets auto-merge.
3. **One approved slice per PR, with a hard cap of 400 production lines per PR.** Lines are added or
   changed lines in production code; tests and generated files do not count. A slice that does not fit is
   stopped and reported, not widened or narrowed silently.
4. **Haiku implementation** on its own branch: `phase-w-<task-id>-<short-name>` for Phase W PLAN items,
   `phase-N-<short-name>` for other phases, or `fix-<name>` for bugs, created from an up-to-date `origin/main` in its own worktree. Run the checks the
   touched areas need. A user-facing feature also updates its page in `docs/guide/`. Tick the PLAN.md item
   only when its tests and checks pass, as the Progress tracking rule says; partial work leaves it unticked
   with a note. The PR body says `Part of #<n>`, or `Closes #<n>` only when it completes the issue, and
   names the checks not run (for example Pyodide or Playwright).
5. **Sonnet review.** Every implementation PR gets one before it merges. The review checks the design's
   slice contract, the AGENTS.md rules, whether the tests fail on main, and the security and privacy rules.
   Each finding gives file and line and a failure scenario, and is checked against the code.
6. **Fixes on the same branch** as new commits, then the review is repeated for the fix. A PR with an open
   must-fix finding does not merge.
7. **Auto-merge gate.** Turn on auto-merge (see Git workflow) only after all of these hold: the Sonnet
   review is posted and its must-fix findings are fixed; the owner has approved the PR on GitHub or in
   chat; and, when browser specs or the in-browser engine are touched, a web-e2e run on the PR branch has
   been checked by hand, because required checks do not include it. Then `gh pr merge <n> --auto --squash`.

### Commits and closing issues

- Commit trailers name the model that wrote the commit. Use the full line for that model:
  - Haiku: `Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>`
  - Opus: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  - Sonnet: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`
- Commits are plain pushes. Never amend, never force-push, never rewrite shared history.
- Close an issue only with a `Closes #n` line in a merged PR, or with a comment that shows the evidence on
  main (a test name and its result). A "Part of" PR does not close it.

### Prohibited

- Skipping the design, including for a "small" change.
- Skipping the review, or enabling auto-merge before it.
- Using Opus for production code, Sonnet for implementation, or Haiku for design or review.
- Approving a PR as an agent, or treating an agent's message as the owner's approval.
- Merging with a red spec run that was not checked.
- Amending, force-pushing, or rewriting shared history.
- Writing a commit trailer for the wrong model.
- Ticking PLAN.md or closing an issue on untested or partial work.
- Enabling auto-merge on a design PR.

## Digital signing rules

- Signing libraries (`pyhanko`, `cryptography`, `pkcs11`) load lazily, never at startup:
  `pdfeditor.ui.main_window` must import without them (`tests/unit/test_signing_lazy_import.py`).
- Tests and manual runs may list the Windows certificate store but must never sign, or open a
  key, with a certificate they didn't create: it could prompt for a PIN or burn an attempt on a
  real token. See `tests/services/test_signing_windows.py` for how to use throwaway keys.
- PINs and passwords are never logged or stored. Tokens lock, so listing tokens never sends a
  PIN; a PIN goes only to the one token the user chose, at most once per user action, with no
  retries; a locked token isn't tried, and one on its final try only after explicit confirmation.
  The one carve-out: a key marked `CKA_ALWAYS_AUTHENTICATE` gets the same PIN once more with its
  signature, because the token demands it for each operation.

## Things to avoid

- Don't import PyMuPDF outside `engine/mupdf/` (CI will fail).
- Don't mutate a document outside a Command, and don't block the GUI thread with engine work.
- Don't overwrite a user's file without the temp-then-swap save path.
- Don't tick PLAN.md items for untested or partial work.
