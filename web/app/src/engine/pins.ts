// The runtime pins for the engine. web/spike/versions.json is the source of truth; pins.test.ts
// fails when these constants and that file disagree, so a bump changes both in one commit.
export const PYODIDE_VERSION = '314.0.8';
export const PYMUPDF_VERSION = '1.28.2';
// The route-3 build (versions.json builtWheel), the wheel the engine ships. Its name is what
// PyMuPDF's own build gives for Pyodide 314, so it is pinned by that name, not by the PyPI copy.
export const PYMUPDF_WHEEL_FILE = 'pymupdf-1.28.2-cp314-none-pyemscripten_2026_0_wasm32.whl';

// The web package built by scripts/build_web_wheel.py, unpacked into /home/pyodide.
export const WEB_ZIP_FILE = 'pdfeditor-web.zip';

// dto.PROTOCOL_VERSION in src/pdfeditor/webapi/dto.py. The hello reply must carry the same number.
export const WEBAPI_PROTOCOL = 1;
