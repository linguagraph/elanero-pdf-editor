// The runtime pins for the engine. web/spike/versions.json is the source of truth; pins.test.ts
// fails when these constants and that file disagree, so a bump changes both in one commit.
export const PYODIDE_VERSION = '314.0.8';
export const PYMUPDF_VERSION = '1.28.2';
export const PYMUPDF_WHEEL_FILE = 'pymupdf-1.28.2-cp313-abi3-pyemscripten_2025_0_wasm32.whl';

// The web package built by scripts/build_web_wheel.py, unpacked into /home/pyodide.
export const WEB_ZIP_FILE = 'pdfeditor-web.zip';

// dto.PROTOCOL_VERSION in src/pdfeditor/webapi/dto.py. The hello reply must carry the same number.
export const WEBAPI_PROTOCOL = 1;
