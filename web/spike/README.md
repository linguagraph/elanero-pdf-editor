# web/spike: PyMuPDF on Pyodide (W0.1)

Spike code for the go/no-go decision in `docs/web/design/W0.1.md`. Nothing here is imported by the
app, and nothing under `src/` or `tests/` is changed for it. The results are in
`docs/web/spikes/W0.1-results.md`.

Versions are pinned in `versions.json` (Pyodide, PyMuPDF, the wheel route, host Python) and in
`package.json` / `package-lock.json` (npm). The `pyodide` npm version must match `versions.json`;
the harness refuses to run otherwise.

## What runs where

| Step | File | Where |
|---|---|---|
| Build the PyMuPDF wasm wheel (route 3) | `.github/workflows/web-spike.yml` | Linux only (CI) |
| Stage wheel, package closure, sources, fixture | `run_engine_tests.mjs prepare` | Node |
| Contract tests under Pyodide | `run_engine_tests.mjs run`, `pyodide_conftest.py` | Node |
| Browser smoke (worker, Chromium) | `smoke/`, `smoke.spec.ts`, `playwright.config.ts` | Playwright |
| Host check of the saved PDF | `verify_host.py` | CPython (pikepdf, pypdfium2) |

## Running it

The wasm wheel can only be built on Linux (Emscripten). On Windows, use the CI run's artifact or
the PyPI route in `versions.json` (`wheelRoute: "pypi"`, Pyodide 0.29.x).

```sh
# once, in the repo root: the generated fixtures
uv run python scripts/make_fixtures.py

cd web/spike
npm ci
npx playwright install chromium            # browser for the smoke test

node run_engine_tests.mjs prepare --wheel /path/to/pymupdf-1.28.2-*.whl
node run_engine_tests.mjs run              # out/engine.xml, out/engine-summary.json, out/run.json
npx playwright test                        # out/smoke.pdf, out/smoke-summary.json
python verify_host.py out/smoke.pdf out/host-verify.json   # needs pikepdf and pypdfium2
```

`prepare` is the only step that touches the network (the Pyodide package closure, from the CDN,
each file checked against the sha256 in `pyodide-lock.json`). `run` and `playwright test` fetch
nothing: a package that was not staged fails instead.

## Spike-only shims (see `pyodide_conftest.py`)

- Modules importing `pikepdf` or `pypdfium2` are skipped as "host-verified" at import time.
- `tests/conftest.py` imports `pdfeditor.ui.settings` (PySide6, absent in Pyodide); a stub
  provides the one name it reads.
