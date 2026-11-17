# web/spike: PyMuPDF on Pyodide (W0.1) and translation CORS (W0.3)

Spike code for the go/no-go decision in `docs/web/design/W0.1.md`. Nothing here is imported by the
app, and nothing under `src/` or `tests/` is changed for it. The results are in
`docs/web/spikes/W0.1-results.md`.

## Translation CORS (W0.3)

`docs/web/design/W0.3.md` asks which translation services a page on `https://linguagraph.github.io`
can call with `fetch`. `cors/services.mjs` mirrors what the desktop clients send. Run it with:

```sh
cd web/spike
npm ci
npx playwright install chromium firefox webkit
npm run cors-probe     # out/cors-raw.json, out/cors-browser-*.json, out/cors-report.md
```

It sends the word "Hello", one request per service, endpoint and origin, with fake keys. The
optional real-key path is for the maintainer only: set `ELANERO_PROBE_REAL_SERVICES` to the services
to test (`deepl`, `azure`, `libretranslate`) and their variables (`ELANERO_PROBE_DEEPL_KEY`,
`ELANERO_PROBE_AZURE_KEY`, `ELANERO_PROBE_AZURE_REGION`, `ELANERO_PROBE_LIBRE_KEY`). It is disabled
when `CI` or `GITHUB_ACTIONS` is set. Every output is redacted (`cors/redact.mjs`). CI runs it from
`.github/workflows/web-cors.yml` (manual dispatch only).

## Pins

`versions.json` is the single source for the spike: Pyodide, PyMuPDF and MuPDF, the wheel route,
the host Python and the MuPDF tarball (URL, sha256 and directory). `package.json` and
`package-lock.json` pin the npm packages. Two versions must be bumped together:

- `versions.json` `pyodide` and `package.json` `devDependencies.pyodide`. The harness refuses to run
  when they differ, or when the installed `node_modules/pyodide` is not the pinned one.
- `versions.json` `pypiWheel.pyodide` must equal `pyodide` when the route is `pypi`; the workflow
  fails otherwise.

## What runs where

| Step | File | Where |
|---|---|---|
| Build the PyMuPDF wasm wheel (route 3) | `.github/workflows/web-spike.yml` | Linux only (CI) |
| Stage wheel, package closure, sources, fixture | `web/test/pyodide/run_engine_tests.mjs prepare` | Node |
| Contract tests under Pyodide | `web/test/pyodide/run_engine_tests.mjs run`, `web/test/pyodide/pyodide_conftest.py` | Node |
| Browser smoke (worker, Chromium) | `smoke/`, `smoke.spec.ts`, `playwright.config.ts` | Playwright |
| Host check of the saved PDF | `verify_host.py` | CPython (pikepdf, pypdfium2) |

## Running it

The wasm wheel can only be built on Linux (Emscripten). On Windows, the easiest route is the CI
run's artifact (`w0.1-pyodide-spike`, `dist/wheel-build/*.whl`).

```sh
# once, in the repo root: the generated fixtures
uv run python scripts/make_fixtures.py

cd web/spike
npm ci
npx playwright install chromium            # browser for the smoke test

node ../test/pyodide/run_engine_tests.mjs prepare --wheel /path/to/pymupdf-1.28.2-*.whl
node ../test/pyodide/run_engine_tests.mjs run              # out/engine.xml, out/engine-summary.json, out/run.json
npx playwright test                        # out/smoke.pdf, out/smoke-summary.json
python verify_host.py out/smoke.pdf out/host-verify.json   # needs pikepdf and pypdfium2
```

`prepare` is the only step that touches the network (the Pyodide package closure, from the CDN,
each file checked against the sha256 in `pyodide-lock.json`). `run` and `playwright test` fetch
nothing: a package that was not staged fails instead.

`run` exits 0 when engine tests fail. A failing test is a result, and the go/no-go gate is the
report (`docs/web/spikes/W0.1-results.md`), not the exit status. `run` exits 2 only when the
harness itself cannot run pytest (exit code 2 or more from pytest).

## Route 2 (a PyPI wheel) instead of a build

`versions.json` `wheelRoute` is `build` (route 3) for Pyodide 314. To use route 2, set
`wheelRoute` to `pypi`, and set `pyodide` and `package.json` to the Pyodide version recorded in
`pypiWheel.pyodide` (0.29.5 for the wheel pinned today, which is `cp313`, Python 3.13). The
workflow refuses a `pypi` route whose `pypiWheel` fields are empty or whose Pyodide version does not
match. The pinned wheel's sha256 was checked against the PyPI file.

## Stub modules (`web/test/pyodide/pyodide_conftest.py`)

The spike cannot run `pikepdf` or `pypdfium2` (C/C++ extensions with no Pyodide build), so the
plugin puts lazy stubs for them in `sys.modules` before collection:

- Importing them, `from pikepdf import Name` and using their names in annotations work, so the
  test modules import.
- A test skips with `needs host-side verification: <name>` at the first call, index, iteration,
  comparison or truth test on a stub. The engine calls before that point still run.
- The summary separates tests that passed, tests that skipped after engine code had returned
  ("engine passed, host check pending"), tests that skipped before any engine code returned, and
  other skips. Engine returns are counted with `sys.monitoring` PY_RETURN, so a frame that unwinds
  with an exception is not counted.

`tests/conftest.py` imports `pdfeditor.ui.settings` (PySide6, absent in Pyodide); the plugin stubs
the one name it reads (`_SESSION_KEYS`). Nothing under `tests/` is changed.

## Known unpinned build dependencies (route 3)

The build pins what it can, but these are not pinned to a hash and can change between runs:

- **pyodide-build 0.39.3's own dependencies** (listed in its wheel metadata: `pyodide-cli`,
  `pyodide-lock`, `auditwheel-emscripten`, `build`, `virtualenv` and others). Only the top-level
  version is pinned.
- **The Pyodide xbuildenv download.** `pyodide xbuildenv install 314.0.8` fetches the cross-build
  environment from the jsdelivr CDN; its hash is not checked.
- **Emscripten.** pyodide-build installs the Emscripten version named by the xbuildenv (5.0.3) itself,
  from upstream emsdk, so the toolchain is not pinned by hash.
- **SWIG** comes from the build tooling's own PyPI dependency, not from a pinned version here.
- **Host pins' transitive dependencies.** `hostPins` pins five packages exactly
  (`versions.json`); whatever those packages depend on is not pinned.
- **`npx playwright install --with-deps chromium`** installs Chromium and system packages with apt
  on the runner. The Chromium build and the apt packages are not pinned.

What is pinned and checked: the MuPDF tarball (sha256), the PyMuPDF tag commit, the wheel
(`wheel.sha256`, re-checked on every cache restore), the Pyodide package closure (`pyodide-lock.json`
sha256 per file), the npm lockfile, and every GitHub action (commit SHA).

## Load and render measurements (W0.2)

The W0.2 harness (`docs/web/design/W0.2.md`) lives in `perf/` and `perf.spec.ts`. It measures the
W0.1 stack (wheel, Pyodide, the trimmed `pdfeditor` zip from `web_package.py`) on the `perf_mixed_*`
fixtures; the tables are in `docs/web/spikes/W0.2-results.md`.

```sh
# the W0.1 wheel (CI artifact, or a local build) and the generated fixtures
uv run python scripts/make_fixtures.py
cd web/spike
node perf/stage.mjs --wheel /path/to/pymupdf-1.28.2-*.whl --python /path/to/python

PERF_ENV=laptop npx playwright test -c playwright.perf.config.ts          # Chromium, 5 runs
PERF_ENV=laptop PERF_BROWSERS=chromium,firefox,webkit PERF_FIXTURES=perf_mixed_10.pdf \
  npx playwright test -c playwright.perf.config.ts                       # the 10-page cross-browser check
python perf/sizes.py                                                      # M1 -> out/sizes.json
python perf/report.py out                                                 # Markdown tables
```

`perf/shim_zip.py` adds one stub module (`engine/mupdf/ocr_worker.py`) to the zip, because the
web set leaves it out but `engine/mupdf/ocr.py` imports it. The Playwright config is separate from
`playwright.config.ts` (W0.1) so the two runs cannot clash.
