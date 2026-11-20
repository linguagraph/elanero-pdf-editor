import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PYMUPDF_VERSION, PYMUPDF_WHEEL_FILE, PYODIDE_VERSION, WEBAPI_PROTOCOL } from './pins';

const here = dirname(fileURLToPath(import.meta.url));
const versions = JSON.parse(
  readFileSync(resolve(here, '..', '..', '..', 'spike', 'versions.json'), 'utf8'),
) as { pyodide: string; pymupdf: string; builtWheel: { file: string } };

describe('engine pins', () => {
  it('match web/spike/versions.json (the one source of the pins)', () => {
    expect(PYODIDE_VERSION).toBe(versions.pyodide);
    expect(PYMUPDF_VERSION).toBe(versions.pymupdf);
    expect(PYMUPDF_WHEEL_FILE).toBe(versions.builtWheel.file);
  });

  it('match the webapi protocol version in the Python package', () => {
    const dto = readFileSync(
      resolve(here, '..', '..', '..', '..', 'src', 'pdfeditor', 'webapi', 'dto.py'),
      'utf8',
    );
    const match = /^PROTOCOL_VERSION = (\d+)$/m.exec(dto);
    expect(match?.[1]).toBe(String(WEBAPI_PROTOCOL));
  });
});
