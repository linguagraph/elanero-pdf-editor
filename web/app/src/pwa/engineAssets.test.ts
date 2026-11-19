import { describe, expect, it } from 'vitest';
import {
  engineAssetProblems,
  STAGE_MANIFEST_FILE,
  type PrecacheFile,
  type StageManifest,
} from './build';
import { PYMUPDF_WHEEL_FILE, WEB_ZIP_FILE } from '../engine/pins';

const HASH = (letter: string): string => letter.repeat(64);

const STAGE: StageManifest = {
  pyodide: '314.0.8',
  core: ['pyodide.mjs', 'python_stdlib.zip'],
  packages: [{ name: 'pillow', version: '12.2.0', file: 'pillow.whl', sha256: HASH('a') }],
  wheel: { file: PYMUPDF_WHEEL_FILE, bytes: 10, sha256: HASH('b') },
  web: { file: WEB_ZIP_FILE, sha256: HASH('c') },
};

// The precache list a build of STAGE produces.
function complete(): PrecacheFile[] {
  return [
    { path: 'index.html', sha256: HASH('0') },
    { path: 'engine-assets/pyodide.mjs', sha256: HASH('1') },
    { path: 'engine-assets/python_stdlib.zip', sha256: HASH('2') },
    { path: 'engine-assets/pillow.whl', sha256: HASH('a') },
    { path: `engine-assets/${PYMUPDF_WHEEL_FILE}`, sha256: HASH('b') },
    { path: `engine-assets/${WEB_ZIP_FILE}`, sha256: HASH('c') },
    { path: `engine-assets/${STAGE_MANIFEST_FILE}`, sha256: HASH('d') },
  ];
}

describe('engineAssetProblems (W4.6 S2)', () => {
  it('gives no problem for a complete precache', () => {
    expect(engineAssetProblems(complete(), STAGE)).toEqual([]);
  });

  it('names a missing core file', () => {
    const files = complete().filter((file) => !file.path.endsWith('pyodide.mjs'));
    const problems = engineAssetProblems(files, STAGE);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('engine-assets/pyodide.mjs');
  });

  it('names a missing package', () => {
    const files = complete().filter((file) => !file.path.endsWith('pillow.whl'));
    const problems = engineAssetProblems(files, STAGE);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('engine-assets/pillow.whl');
  });

  it('names a wheel whose precache SHA differs from the stage manifest', () => {
    const files = complete().map((file) =>
      file.path.endsWith(PYMUPDF_WHEEL_FILE) ? { ...file, sha256: HASH('f') } : file,
    );
    const problems = engineAssetProblems(files, STAGE);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(PYMUPDF_WHEEL_FILE);
  });

  it('names a staged wheel other than the pinned one', () => {
    const stage = { ...STAGE, wheel: { ...STAGE.wheel, file: 'pymupdf-9.9.9.whl' } };
    const problems = engineAssetProblems(complete(), stage);
    expect(problems.some((problem) => problem.includes('pymupdf-9.9.9.whl'))).toBe(true);
  });

  it('reports a leftover file in the engine-assets folder that the stage manifest does not list', () => {
    const files = [...complete(), { path: 'engine-assets/old-engine.whl', sha256: HASH('9') }];
    expect(engineAssetProblems(files, STAGE)).toEqual([
      'engine-assets/old-engine.whl is in the engine-assets folder but is not listed in stage-manifest.json',
    ]);
  });

  it('reports a stage manifest without the web zip', () => {
    const stage = { ...STAGE, web: undefined };
    const problems = engineAssetProblems(complete(), stage);
    // The zip is still staged, so it is also a file the manifest does not list.
    expect(problems).toEqual([
      `stage-manifest.json does not name ${WEB_ZIP_FILE}`,
      `engine-assets/${WEB_ZIP_FILE} is in the engine-assets folder but is not listed in stage-manifest.json`,
    ]);
  });
});
