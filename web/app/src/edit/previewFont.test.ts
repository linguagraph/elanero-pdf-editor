import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { familyOf, loadPreviewFace, previewFamilyCss } from './previewFont';

// The browser's font API, as the preview uses it: a FontFace that loads unless the program is
// marked bad, and a document font set that records what was added.
class FakeFontFace {
  readonly family: string;
  constructor(family: string, source: ArrayBuffer) {
    this.family = family;
    if (new Uint8Array(source)[0] === 0) throw new Error('bad program');
  }
  async load(): Promise<this> {
    return this;
  }
}

const added: string[] = [];

beforeEach(() => {
  vi.stubGlobal('FontFace', FakeFontFace);
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { add: (face: FakeFontFace) => added.push(face.family) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  added.length = 0;
});

function program(seed: number): ArrayBuffer {
  return new Uint8Array([seed, 2, 3, 4, 5]).buffer;
}

function rpcAnswering(reply: unknown) {
  const call = vi.fn(async () => reply);
  return { rpc: { call } as unknown as PageRpc, call };
}

describe('familyOf', () => {
  it('maps a name to the generic family the desktop would guess', () => {
    expect(familyOf('Courier New')).toBe('monospace');
    expect(familyOf('Times-Roman')).toBe('serif');
    expect(familyOf('Georgia')).toBe('serif');
    expect(familyOf('Arial')).toBe('sans-serif');
    expect(familyOf('Times Sans')).toBe('sans-serif');
  });
});

describe('previewFamilyCss', () => {
  it('uses the generic family when the engine has no program', async () => {
    const { rpc } = rpcAnswering({ found: false, family: 'serif', program: null });
    expect(await previewFamilyCss(rpc, 'h1', 0, 'Mystery')).toBe('serif');
    expect(added).toEqual([]);
  });

  it('loads the document face and lists the generic family after it', async () => {
    const { rpc, call } = rpcAnswering({
      found: true,
      family: 'sans-serif',
      program: program(1),
    });
    const css = await previewFamilyCss(rpc, 'h1', 2, 'Free Sans');
    expect(call).toHaveBeenCalledWith('content.preview_font', {
      handle: 'h1',
      page: 2,
      font_name: 'Free Sans',
    });
    expect(css).toMatch(/^"pdf-[0-9a-f]{12}", sans-serif$/);
    expect(added).toHaveLength(1);
  });

  it('keeps the generic family when the browser rejects the program', async () => {
    const { rpc } = rpcAnswering({ found: true, family: 'serif', program: program(0) });
    expect(await previewFamilyCss(rpc, 'h1', 0, 'Type1Font')).toBe('serif');
    expect(added).toEqual([]);
  });
});

describe('loadPreviewFace', () => {
  it('loads a program once for the page, and a second ask reuses the face', async () => {
    const first = await loadPreviewFace(program(7));
    const second = await loadPreviewFace(program(7));
    expect(first).toBe(second);
    expect(added).toHaveLength(1);
  });

  it('caches a rejected program as null, so it is not tried again', async () => {
    expect(await loadPreviewFace(program(0))).toBeNull();
    expect(await loadPreviewFace(program(0))).toBeNull();
    expect(added).toEqual([]);
  });
});
