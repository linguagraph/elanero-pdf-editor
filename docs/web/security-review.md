# W8.6 Security review: threat model status and findings

**Checked against main at 86477f9, 2026-11-24.** The review was first run at `54d41d0` (Merge PR
#430). Section 4 ends with the status of every finding on main as of the check above; the
controls and W1.1 rows in sections 1 and 2 are the review-time snapshot, with the changes since
then noted under each. Finding IDs (F1 to F16) and control IDs (C1 to C16) are unchanged.

Reviewed tree: `origin/main` at `54d41d0` (Merge PR #430), checked out as a detached worktree in the
scratchpad. Paths below are relative to the repo root, and line numbers refer to `54d41d0` unless
a status note says otherwise.

Method: the brief's decisions and the S1 slice definition (brief-w8.6-security.md), the W1.1 §10 STRIDE
table (docs/web/design/W1.1.md:199-225), then the code and tests behind each listed control, checked
with grep. For each control, the review asks three questions: what it protects against, how it is
tested, and whether that test fails if the control is removed.

Severity bar (brief decision 2): high and critical findings block the W8.6 tick. Medium and low ones
may be deferred to a named PLAN.md item.

**Result: no critical or high findings. 3 medium and 13 low. Nothing blocks the tick.**

---

## 1. Controls on main

| # | Control | What it protects against (W1.1 §10) | How it is tested | Does a test fail if the control is removed? |
|---|---|---|---|---|
| C1 | CSP meta, `web/app/src/csp.ts:3`, copied into `web/app/index.html:8`: `script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self' blob:`, `connect-src` = self plus 3 translation origins, `object-src 'none'`, `base-uri 'none'`, `require-trusted-types-for 'script'` | E: XSS and script injection. I: exfiltration (`connect-src`). T: injected `<base>` or `<object>` | `src/csp.test.ts:17-32` (exactly one meta equal to `CSP_POLICY`, no inline script, no `on*=`). `src/build.test.ts:13-32` (the built `index.html` carries `CSP_POLICY` with no `'unsafe-inline'` or `'unsafe-eval'`). `e2e/engine-load.spec.ts:26-31` (the served page carries `CSP_POLICY`) plus a console scan for CSP violations | **Partly.** Deleting the meta tag fails csp.test, build.test and engine-load. Loosening `csp.ts` and `index.html` together fails only for `'unsafe-inline'` or `'unsafe-eval'`. Dropping `require-trusted-types-for`, `object-src 'none'` or `base-uri 'none'`, or widening `connect-src`, fails nothing (F6) |
| C2 | Referrer meta `no-referrer` (`index.html:11`, `csp.ts:5`) | I: referrer leaks | `csp.test.ts:24-27` | Yes |
| C3 | Workers are started from a `blob:` URL that imports a same-origin module, behind the Trusted Types policy `elanero-worker-url` (`src/engine/start.ts:35-60, 85-90`) | I: the worker inherits the page CSP, since GitHub Pages sends no headers. E: a worker started from an arbitrary URL | `src/engine/start.test.ts:75-93` (blob URL whose body is `import "<abs url>"`; another origin is refused). The TT policy has no unit test. Under Chromium's TT enforcement, `e2e/engine-load.spec.ts` would fail if the policy were removed | Yes for the blob URL and the origin check (unit). TT is covered only indirectly (e2e). **No test checks that the CSP is actually inherited inside a worker** (F4) |
| C4 | The job worker removes `fetch`, `XMLHttpRequest`, `WebSocket` and `importScripts` after the packages load and before the adapter runs, and fails closed (`src/engine/jobworker.ts:6-32`, `src/engine/loader.ts:285`) | I: a compromised job worker sends document bytes out | `src/engine/jobworker.test.ts:35-75` (order across stages, each global undefined, fail-closed). `src/engine/loader.test.ts:140-150` (`beforeEngine` runs after unpack and before the adapter) | Yes (unit, with stubbed globals). No real-browser check (F4). `EventSource` and `WebTransport` stay available, but they are bound by `connect-src` |
| C5 | Engine worker network: **no control.** `src/engine/engine.worker.ts:5-7` calls `serveEngine` without `beforeEngine`. The XHR allow-list wrapper W1.1 §10 asks for does not exist: `XMLHttpRequest` appears only in jobworker.ts:6 | I | — | — (F1) |
| C6 | Frame refusal (`src/frame.ts:11-13`, `src/main.tsx:42-43`) | E: clickjacking | `src/frame.test.ts` (pure `shouldRefuse` only) | **No** for the wiring. Deleting the check in main.tsx fails nothing (F10) |
| C7 | Client size checks: `MAX_FILE_BYTES = 1024**3` (`src/documents/openFile.ts:9,31`, also combine/run.ts:37 and CompareDialog.tsx:97); `MAX_XFDF_BYTES = 8 MiB` (`src/commentsImport/xfdfImport.ts:8,25`) | D: huge inputs reaching the worker | `openFile.test.ts:103-111`, `combine/run.test.ts:95`, `CompareDialog.test.tsx:166`, `xfdfImport.test.ts:20-28` | Yes. **Drift between client and engine is not tested.** The constants are linked only by comments (F12) |
| C8 | Engine limits (`src/pdfeditor/webapi/limits.py`): file size (session.py:36-42), pages, render pixels and scale, tile (render.py:127), save (save.py:46,73), job bytes, prepared jobs (jobs.py:854), JSON depth (`webapi/__init__.py:186-206`), snapshots | D | `tests/unit/test_webapi_limits.py` (file size and pages, at the limit and one over), `tests/unit/test_webapi_limits_guards.py` (pages, scale, pixels, query, save, job bytes: inclusive), `test_webapi_render_tile.py` (tile), `test_webapi_fuzz.py:453-472` (depth) | Mostly yes. Gaps: `MAX_PREPARED_JOBS` has no test of a second prepare (F12). On host CPython the JSON depth scan can be removed without a failure, because `RecursionError` is still caught (`__init__.py:212`); only the Pyodide run (`web/test/pyodide/run_tests.mjs:48` runs `tests/` under "not slow") would crash (F13) |
| C9 | Service-worker precache: each listed file is checked against the build's SHA-256 before `cache.put`. Only GET, same origin. Documents are never cached (`public/sw.js:35-96, 118-131`). The SW URL goes through the TT policy `elanero-sw-url` (`src/pwa/register.ts:25-37`) | T: tampered or stale assets in the cache. I: documents left on a shared computer | `src/pwa/sw.test.ts:163-217` runs the real `public/sw.js` in node:vm (SHA mismatch fails the install and removes the new cache; HTTP-cache refetch). `:237-241` (no interception of a non-GET or cross-origin request). `e2e/pwa.spec.ts` (offline) | Yes for the SHA check. **"Never caches documents" has no test.** It holds structurally, since `cache.put` appears only in `precache()` at sw.js:51 (F15) |
| C10 | XFDF: 8 MiB cap, then DOCTYPE or ENTITY refused before `ET.fromstring` (`src/pdfeditor/services/xfdf.py:54-61, 221-225`) | D: billion laughs and amplification. I: external entities | `tests/services/test_xfdf_comments.py:256-264` (DOCTYPE and bare ENTITY raise "not XFDF"), `:281-295` (size, including multi-byte), `tests/unit/test_webapi_comments_xfdf.py:171,199,208` | Yes: without the guard, the first hostile case parses and the service test fails. The substring check is sound because `ET.fromstring(str)` makes expat parse as UTF-8 and ignore the declared encoding, and XML requires a literal `<!DOCTYPE`. **There is a second untrusted XML path with no guard: XMP** (F8) |
| C11 | W8.4 fuzz (`tests/unit/test_webapi_fuzz.py`): mutated and truncated fixtures through `session.open`, malformed and random envelopes, render/tile/text argument grids, damaged-open reproducers, depth | D, T (no `INTERNAL`, no crash, bounded time) | Short counts on PRs. Long counts are marked `slow` (nightly). Also runs under Pyodide | Indirectly: a regression in error mapping turns up as `INTERNAL` through `robustness_helpers.check_reply`. XFDF and save are not fuzzed (brief S5) |
| C12 | Reply schema checks: generated decoders (`src/rpc/shape.ts`, `src/rpc/client.ts:180-199`) reject unknown fields. Job replies are checked by hand (`src/files/fileJob.ts:76-117`, and likewise actionJob, merge, compareJob, printWorker) | T, E: a compromised worker's replies | `rpc/client.test.ts`, `generated.test.ts`, per-job tests | Yes for the generated path |
| C13 | Secrets: `prefs/store.ts:83-111` refuses secret-looking keys. The webapi keeps the open password out of replies and logs (`webapi/session.py:5-6, 52-56`). The job worker never gets a password, because the job copy is written decrypted (`webapi/jobs.py:761-763`) | I | `prefs/store.test.ts:226-238`, `tests/unit/test_webapi_security.py:405-437` (caplog plus every reply checked for 4 passwords), `test_webapi_jobs.py:192,265` and `test_webapi_job_types.py:249,389,780` (`"password" not in prepared`), `test_webapi_session.py:174` | Yes. Note for the brief: brief §1 item 4 says the password is "passed to the job worker in `jobs.prepare`". The code and its tests say the opposite: the job gets a decrypted copy and no password. S3's Python half largely exists already (test_webapi_security.py:405) |
| C14 | Autosave hygiene: protected documents are never copied, and copies are removed on clean or close (`src/storage/autosaver.ts`); `storage.estimate()` is checked (`autosaveStore.ts`) | I, D | `autosaver.test.ts:163,228,237,258`, `autosaveStore.test.ts:113,159,210`, `clearLocalData.test.ts:102` | Yes |
| C15 | Signing is not shipped: `"services/signing/"` is in `scripts/web_package.py:20` | E: PIN or key handling on the web | `tests/unit/test_web_package.py:157` checks that the zip has no **listed** excluded path (it reads `wp.EXCLUDED`) | **No.** Removing the entry fails nothing, because the signing libraries load lazily and the import check (test_web_package.py:91-95) still passes (F11). A signed document is saved incrementally (`webapi/save.py:3-10, 84`, tested in `tests/unit/test_webapi_save.py`) |
| C16 | XSS sinks: grep of `web/app/src` (non-test) for `innerHTML\|outerHTML\|insertAdjacentHTML\|dangerouslySetInnerHTML\|document.write\|eval(\|new Function\|setTimeout('…'\|srcdoc\|createContextualFragment\|DOMParser` finds **0 hits**. No `window` `message` listener (only the worker's own, at start.ts:109). Outgoing links use `noopener noreferrer` (about.tsx:15, help/guide.ts:29) | E, S | None. Convention only (F2). Trusted Types blocks string sinks at runtime in browsers that enforce it | No |

---

## 2. W1.1 §10 rows: status

| Row | Mitigation status on main | Gap |
|---|---|---|
| S: link spoofing | **Not built.** No PDF link activation exists. No code opens a PDF-derived URL (grep for `window.open`, `location.*`, `href={`: only the fixed About link, guide.ts:29 and download anchors). PLAN.md:594 W5.3 is partial ("links… pending") | F5 |
| S: RPC lookalike messages | Holds: no `window` message listener, dedicated workers only, replies schema-checked (C12) | — |
| S: lookalike site | Out of scope (W4.1 About) | — |
| T: tampered assets | SW SHA-256 (C9), `npm ci` everywhere | The self-built PyMuPDF wheel is no longer pinned (F14). No `--ignore-scripts` (F3) |
| T: memory corruption | Worker isolation plus schema checks (C12) plus fuzz (C11) | — |
| T: saved file differs | Save verifies by reopening (webapi/save.py) | XFDF and save fuzz pending (brief S5, not a finding) |
| R | N/A | — |
| I: documents leave the device | Job worker locked (C4). **The engine worker is not locked, and `connect-src` admits 3 third-party origins although translation (W6.6) is not built** | F1, F4 |
| I: translation | Not built (PLAN.md:604 W6.6 unticked) | Precondition for W6.6 |
| I: leftovers | C14, C9, blob URLs revoked (`files/downloads.ts:29-31,43`, `print/printPages.ts:80`, `engine/start.ts:92-97`) | F15 |
| I: referrer | C2, noopener | — |
| D: bombs and limits | C8, C11, watchdog | F12, F13 |
| D: OPFS fill | C14 | — |
| E: XSS | React text rendering, Trusted Types in the CSP, 0 sinks today | F2, F6, F7 |
| E: PDF JavaScript, launch | Launch: no link or action activation exists. JS: the fixture `sensitive.pdf` carries `/OpenAction` JavaScript (`scripts/make_fixtures.py:792-794`) and is opened by webapi tests, but **no test asserts that the JavaScript does not run** under the wasm build | F9 |
| E: clickjacking | C6 | F10 |
| E: malicious dependency | **Not built:** no `npm audit`, no `pip-audit`, no Dependabot, no `--ignore-scripts` | F3, F14 |

---

## 3. Gaps listed in the brief: confirmed or refuted

| Gap | Verdict | Evidence |
|---|---|---|
| G1: no ESLint ban on innerHTML, eval, dangerouslySetInnerHTML | **Confirmed** | `web/app/eslint.config.js:19-26`: only `js.configs.recommended`, `tseslint.configs.recommended`, `reactHooks…recommended` and `no-unused-vars`. None of these sets includes `no-eval`, `no-implied-eval` or `no-new-func`, and there is no `no-restricted-syntax`/`no-restricted-properties` and no `eslint-plugin-react`. Mitigating fact: 0 sinks exist today (C16) |
| G2: no npm audit, pip-audit or Dependabot | **Confirmed** | `.github/` holds only `CODEOWNERS` and `workflows/`, with no `dependabot.yml`. `grep -rn "audit\|dependabot"` over `.github` finds only the W0.4 *import* audit (`web-spike.yml:226-231`). No `pip-audit` in `pyproject.toml`. Every install is plain `npm ci` (ci.yml:76, web-deploy.yml:85,212, web-e2e.yml:55,105, web-pytest.yml:78, …), never `--ignore-scripts` |
| G3: the engine worker keeps fetch after boot | **Confirmed** | `src/engine/engine.worker.ts:5-7` (no `beforeEngine`). The only removal list is `jobworker.ts:6`. No XHR wrapper exists anywhere in `web/app/src` |
| G4: no Playwright security specs | **Confirmed** | `web/app/e2e/` has no `security.spec.ts`. The only security-adjacent e2e checks are `engine-load.spec.ts:26-31` (CSP string) and violation scans. No spec issues a blocked `fetch` from the page or a worker, frames the app, guards against third-party requests, or opens a JS or Launch fixture |
| G5: link handling partly built | **Confirmed** (and narrower than "partly": there is **no** link activation surface at all yet) | PLAN.md:594. grep finds no PDF-derived URL being opened (C16, §2 row S) |

---

## 4. Findings

None is high or critical, so **no finding blocks the W8.6 tick**. Every row below may be deferred to
the slice or PLAN.md item named.

| ID | Sev | Boundary | Finding | Evidence (file:line) | Fix slice / deferred item | Blocks tick |
|---|---|---|---|---|---|---|
| F1 | **Medium** | B2→B1 (I) | The engine worker keeps `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` and `importScripts` for its whole life, and the CSP `connect-src` already lists `api.mymemory.translated.net`, `api.cognitive.microsofttranslator.com` and `libretranslate.com`, although translation (W6.6) is not built and the XHR allow-list wrapper W1.1 §10 asks for does not exist. A PDF that gains code execution inside the engine worker (a MuPDF bug reaching Pyodide's `js` FFI) could send document text to those third-party origins. MyMemory's public translation memory is a plausible way for the attacker to read it back. Exploitation needs a full memory-corruption chain, hence medium | `web/app/src/engine/engine.worker.ts:5-7`; `web/app/src/csp.ts:3`; `web/app/index.html:8`; contrast `jobworker.ts:6,31` | S8 (brief decision 3): lock the engine worker's network globals after the loader, as the job worker does, **and** drop the three translation origins from `connect-src` until W6.6 adds them with its wrapper. Regression: a jobworker-style unit test, plus the S6 spec | No |
| F2 | Low | B3 (E) | No lint rule enforces the "no HTML/eval sinks" rule of W1.1 §10 E. Today it holds by convention (0 sinks), backed at runtime by Trusted Types where the browser enforces it | `web/app/eslint.config.js:19-26` | S2 | No |
| F3 | **Medium** | B1 (T, E) | No dependency-advisory monitoring at all (no Dependabot, `npm audit` or `pip-audit`), and no `npm ci --ignore-scripts`, although W1.1 §10 E assigns all of them. A vulnerable or hijacked runtime package would go unnoticed. Install scripts run in CI jobs, including the deploy job | `.github/` (no dependabot.yml); `.github/workflows/*.yml` `npm ci` lines (e.g. `ci.yml:76`, `web-deploy.yml:85,212`); `pyproject.toml` (no pip-audit) | S7 (also add `--ignore-scripts` where the packages allow, or record why not); PLAN.md W9.1 | No |
| F4 | **Medium** | B2, B3 (I) | The W1.1 §10 "Workers and the CSP" control, that a `blob:`-started worker inherits the page's `connect-src`, is the main exfiltration defence, and nothing verifies it in a real browser. Nor is the job worker lockdown checked in a real worker, the frame refusal, or the absence of third-party requests. All of these are unit-tested with fakes at most | `web/app/e2e/` (no security spec); W1.1.md:225 requires "A Playwright test (W8.1) checks from inside each worker that a `fetch` to a non-listed origin is blocked" | S6; PLAN.md W8.1 | No |
| F5 | Low | B7 (S) | There is no PDF link activation yet, so the scheme allow-list, confirmation and `noopener` rules for PDF links cannot be checked. There is no exposure today | PLAN.md:594; grep in §2 row S | Deferred to W5.3, with the S6 link specs as a precondition of its tick | No |
| F6 | Low | B1 (E, I) | The CSP tests pin the two copies to each other, not to the policy. Removing `require-trusted-types-for 'script'`, `object-src 'none'` or `base-uri 'none'`, or adding a `connect-src` origin, in both `csp.ts` and `index.html` passes every test | `web/app/src/csp.test.ts:17-22`; `web/app/src/build.test.ts:22-25` (checks only `unsafe-inline`/`unsafe-eval`) | S2: assert the required directives (and the exact `connect-src` set) in the dist scan | No |
| F7 | Low | B3 (E) | The CSP requires Trusted Types but sets no `trusted-types` directive, so any script (a dependency included) may create a permissive policy under any name. The two app policies are `elanero-worker-url` and `elanero-sw-url` | `web/app/src/csp.ts:3`; `engine/start.ts:53`; `pwa/register.ts:28` | S2 (add `trusted-types elanero-worker-url elanero-sw-url`; check WebKit and Firefox first) | No |
| F8 | Low | B2 (D) | The XMP packet from the PDF is parsed with `ET.fromstring`, with no DOCTYPE or ENTITY refusal and no size cap, whenever metadata is edited. Expat (≥2.4, as in CPython 3.11 and 3.14) limits amplification and ET resolves no external entities, so the realistic outcome is a `ParseError`, after which `_parse` returns `None` and a fresh packet replaces the original (silent loss of XMP content such as PDF/A identification). The DOCTYPE rule (brief decision 5) is applied to XFDF only | `src/pdfeditor/core/xmp.py:55-62, 96-100`; called from `core/commands/document_cmds.py:31` | S5 (fuzz XMP the same way), or a small fix slice applying the XFDF guard and a size cap | No |
| F9 | Low | B2 (E) | W1.1 §10 says W3.2 verifies, with a fixture, that the wasm build does not run PDF JavaScript. No test asserts it, although `sensitive.pdf` (with `/OpenAction` JavaScript) is opened by several webapi tests. Any execution would be confined to MuPDF's JS engine inside wasm, without DOM access | `scripts/make_fixtures.py:574,583,792-794`; no `JavaScript`/`OpenAction` assertion in `tests/unit/test_webapi*.py` (before the engine-half test) | S6 (the brief's `/OpenAction` + `/Launch` fixture spec), plus a webapi test that opens it and checks that nothing changes | No |
| F10 | Low | B7 (E) | The frame refusal's wiring is untested. Deleting `if (shouldRefuse(window))` in main.tsx fails no test | `web/app/src/main.tsx:42-43`; `web/app/src/frame.test.ts` (pure function only) | S6 | No |
| F11 | Low | B2 (E) | The exclusion of signing from the web package is not pinned by a test. Removing `"services/signing/"` from `EXCLUDED` fails nothing, because test_web_package reads `wp.EXCLUDED` and the signing libraries are imported lazily. Precondition for signing ever reaching the web | `scripts/web_package.py:20`; `tests/unit/test_web_package.py:27-31,157` | Small test slice (assert that `services/signing/` and `ui/` are in `EXCLUDED` and absent from the zip), in S4 or S8 | No |
| F12 | Low | B2/B3 (D) | (a) There is no test of a second `jobs.prepare` against `MAX_PREPARED_JOBS`. (b) The client and engine constants (`MAX_FILE_BYTES`/`FILE_REFUSE_BYTES`, `MAX_XFDF_BYTES` on both sides) are linked only by comments. The other limits already have at-limit and over-limit tests | `src/pdfeditor/webapi/jobs.py:854-856`; `web/app/src/documents/openFile.ts:8-9` vs `webapi/limits.py:9`; `commentsImport/xfdfImport.ts:7-8` vs `services/xfdf.py:46` | S4 (smaller than planned: most of the per-limit tests exist in `test_webapi_limits.py` and `test_webapi_limits_guards.py`) | No |
| F13 | Low | B3→B2 (D) | The JSON depth scan is regression-tested only under Pyodide. On host CPython, `_load` catches `RecursionError` and still answers `INVALID_REQUEST`, so `test_robust_fifty_thousand_levels…` passes without the scan. Also, `webapi/__init__.py` imports `MAX_JSON_DEPTH` by value, contrary to `limits.py`'s "read at call time" note, so it cannot be monkeypatched | `src/pdfeditor/webapi/__init__.py:23, 186-213`; `tests/unit/test_webapi_fuzz.py:453-463`; `limits.py:3` | S4 (assert the scan's own message, "nested too deeply", and read the limit as `limits.MAX_JSON_DEPTH`) | No |
| F14 | Low | B1 (T) | Build provenance weakened: the self-built PyMuPDF wheel's sha256 is no longer pinned (commit ebf208b). `wheel.sha256` lives in the same cache entry as the wheel, so it checks consistency, not provenance. PyMuPDF is cloned by a mutable tag. The deploy job (`pages: write`, `id-token: write`) uses tag-pinned, not SHA-pinned, actions | `web/spike/versions.json` `builtWheel`; `scripts/stage_engine_assets.mjs:65-69`; `.github/workflows/web-deploy.yml:119,160-187,243,247,268` | Deferred to W9.1 / W9.2 (pin actions by SHA, clone by commit, record the built wheel's sha in the release notes) | No |
| F15 | Low | B5 (I) | "The service worker never caches documents" is structural (only `precache()` calls `cache.put`), but no test asserts that an unlisted same-origin GET leaves the cache unchanged | `web/app/public/sw.js:51,118-131`; `src/pwa/sw.test.ts:220-241` | S2 or S4 (one sw.test case) | No |
| F16 | Low | B1 (E) | On WebKit, 4 e2e specs skip their CSP check (`test.fixme`, "style-src CSP refuses a stylesheet… needs an issue"), with no tracking issue. Per brief §5, a WebKit gap is recorded as a finding | `web/app/e2e/features/crop.spec.ts:38`, `print.spec.ts:27`, `save-as.spec.ts:38,72` | Open an issue and link it from the fixme; deferred to W8.1 | No |

**Counts:** critical 0 · high 0 · medium 3 (F1, F3, F4) · low 13 (F2, F5–F16).

### 4.1 Status on main (checked 86477f9, 2026-11-24)

Fixes are listed with the PR that made them. "Closed by other work" means a later feature removed
the exposure or added the test. Fixes made after the review, which the review did not find, are
listed separately; they get no new finding ID.

| ID | Sev | Status on main | Where |
|---|---|---|---|
| F1 | Medium | **Fixed** by #438 (engine worker network locked after boot). The second half, dropping the translation origins from `connect-src`, closed with W6.6: `connect-src` now lists only MyMemory | `web/app/src/engine/engine.worker.ts`, `networkLock.ts`, `csp.ts:3` |
| F2 | Low | **Fixed** by #475 (ESLint bans on DOM sinks; built-output inline check) | `web/app/eslint.config.js`, `build.test.ts` |
| F3 | Medium | **Fixed** (second half, W8.6 S7c, this PR). The first half is done by #437 (Dependabot, nightly `npm audit` and `pip-audit`). Every `npm ci` in `.github/workflows/` now passes `--ignore-scripts`; `web-a11y.yml:56` and `web-pytest.yml:215` were the two that did not. `tests/unit/test_workflow_npm_ci.py` fails any new plain `npm ci` or `npm install` line, unless the line above is `# install scripts needed: <reason>` | `.github/workflows/*.yml`, `tests/unit/test_workflow_npm_ci.py` |
| F4 | Medium | **Fixed** by #439: the Playwright security spec checks the CSP inside the page, engine and job worker. It runs in `web-e2e` (nightly) only, not on PRs; the PR gate is W8.1 | `web/app/e2e/features/security.spec.ts` |
| F5 | Low | **Closed by other work**: W5.3 shipped. `links.spec.ts` checks that `javascript:` and Launch links are refused | `links.spec.ts:172-196` |
| F6 | Low | **Open**. `csp.test.ts` still pins the two copies to each other; no test asserts `object-src`, `base-uri`, `require-trusted-types-for` or the exact `connect-src` set. Slice S2b | `web/app/src/csp.test.ts` |
| F7 | Low | **Fixed in the S2b PR** (`trusted-types elanero-worker-url elanero-sw-url` in `csp.ts` and `index.html`; dev policy adds `'allow-duplicates'`). Checked by `csp.test.ts` (list, and a source scan of `createPolicy` names) and `build.test.ts` (bundle scan). Browser specs were **not run** for this change: Chromium through `web-e2e` or by hand, Firefox and WebKit by hand (the PR body lists the gate). | `web/app/src/csp.ts:3`; `web/app/src/csp.test.ts`; `web/app/src/build.test.ts` |
| F8 | Low | **Open**. `core/xmp.py` is unchanged: no DOCTYPE or ENTITY refusal, no size cap. Slice S8 | `src/pdfeditor/core/xmp.py` |
| F9 | Low | **Fixed** (engine #749, browser #706 and #758). Engine: `tests/unit/test_webapi_pdf_javascript.py` opens `sensitive` and `xref_gap`, renders and copy-saves them with MuPDF's `pdf_js_supported` at 0 and the `/OpenAction` JavaScript kept. Browser: `web/app/e2e/features/security.spec.ts` (no dialog, console message or new page; the spec was not run in the PR that closed this) | `scripts/make_fixtures.py:574,583,792-794` |
| F10 | Low | **Open**. `main.tsx:55` calls `shouldRefuse`, but no test frames the app. Slice S6b | `web/app/src/main.tsx` |
| F11 | Low | **Open**. `"services/signing/"` is not pinned by a test. Slice S9 | `scripts/web_package.py:20` |
| F12 | Low | (a) **Closed by other work**: `tests/unit/test_webapi_jobs.py` checks `BUSY` on a second prepare. (b) **Open**: client and engine limits are still linked only by comments; no drift test. Slice S4b | `web/app/src/documents/openFile.ts`, `webapi/limits.py` |
| F13 | Low | **Open**. `webapi/__init__.py` still imports `MAX_JSON_DEPTH` by value; no test asserts "nested too deeply". Slice S4b | `src/pdfeditor/webapi/__init__.py:38, 237` |
| F14 | Low | **Partly fixed** (W8.6). The three Pages actions in `web-deploy.yml` are pinned by commit SHA (`tests/unit/test_workflow_action_pins.py`). **Fixed** (wheel provenance): the release notes record the web engine wheel's file name and sha256 (`release.yml`, from `web-perf.yml`'s outputs); each Pages deploy records it in its step summary. Other workflows' actions are still tag-pinned (follow-up issue) | `web/spike/versions.json`, `.github/workflows/web-deploy.yml`, `tests/unit/test_workflow_action_pins.py` |
| F15 | Low | **Open**. No `sw.test.ts` case for an unlisted same-origin GET. Slice S9 | `web/app/src/pwa/sw.test.ts` |
| F16 | Low | **Open**. The five WebKit `test.fixme` messages still say "needs an issue", although #420 tracks it. Slice S6b | `web/app/e2e/features/crop.spec.ts:38` and four others |

**Totals on main:** critical 0 · high 0 · medium 3 · low 13. Fixed: F1, F2, F4, and F3 once this PR
merges. Closed by other work: F5, F12 (a). Fixed in the F9 PRs (#749, #706, #758): F9. Fixed in the S2b
PR: F7 (browser specs pending, see §4.1). Open: F6, F8, F10, F11, F12 (b), F13, F14, F15, F16 (9 items).

**Fixed after the review (not findings in the original report):**

- **#544**: `actions.run` refuses a `FILE` font reference outside `/fonts/<64 hex>.(ttf|otf|ttc)`, or
  one not in the catalogue. Tests: `tests/unit/test_webapi_font_refs.py`.
- **#619**: the native XHR never leaves the translation closure (`translationNet.ts`). Tests:
  `translationNet.test.ts`.

**Not in the report, changed since the review:** the "Controls on main" table (section 1) is the
snapshot at `54d41d0`. C5 (engine worker network) is now locked by #438, and C1 (`connect-src`) lists
only MyMemory. The W1.1 rows in section 2 for "I: documents leave the device" and "E: malicious
dependency" are partly fixed as shown in the table above.

---

## 5. Notes for the brief and for Opus triage

1. The brief §1 item 4 wording ("passed to the job worker in `jobs.prepare`") is outdated. The job
   worker never receives the password (`webapi/jobs.py:761-763`, tests listed in C13).
2. S3's Python half and most of S4 already exist (`test_webapi_security.py:405-437`,
   `test_webapi_limits*.py`), so those slices can shrink to the gaps in F12 and F13 and the Vitest
   storage and console half.
3. F1 is the only structural item. It touches the loader, so `loader.test.ts` and
   `engine-load.spec.ts` must pass (brief §5). Dropping the translation origins from `connect-src`
   costs nothing today: grep finds them only in `csp.ts` and `index.html`.

## 6. Review checklist for future web PRs (S1 deliverable draft)

- No `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `dangerouslySetInnerHTML`, `document.write`,
  `eval`, `new Function`, string `setTimeout`, `srcdoc` or `DOMParser`. PDF-derived strings render
  as React text only.
- No new `window` `message` listener. Every new reply or notice type is shape-checked
  (generated decoder or `shape.ts` helpers).
- No CSP change without an Opus decision. A new `connect-src` origin needs a worker-side allow-list
  and a Playwright check.
- No PDF-derived URL is opened without the W5.3 scheme allow-list, a confirmation and
  `noopener,noreferrer`.
- No secret, password or document content goes to `localStorage`, `sessionStorage`, OPFS (except
  autosave of unprotected documents), logs or error `details`.
- A new resource has a limit in `limits.py`, a test at the limit and one over it, and a client mirror
  with a drift test.
- New untrusted XML refuses DOCTYPE and ENTITY and has a size cap (XFDF pattern).
- A new runtime dependency gets a `web_licences.toml` entry, and the audit job stays green.
- Workers start only through `engine/start.ts` (blob URL plus TT policy). A worker that does not
  need the network removes it, as `jobworker.ts` does.
- Signing stays in `web_package.EXCLUDED` until the PIN rules are designed for the web.
