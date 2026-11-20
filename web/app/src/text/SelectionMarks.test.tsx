import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Methods } from '../rpc/generated';
import { PageTextLayer } from './PageTextLayer';
import { TextLayerCache, type TextRpc } from './textLayerCache';
import { TextSelection } from './textSelection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function joinChars(boxes: Float32Array, numbers: Uint32Array): ArrayBuffer {
  const joined = new Uint8Array(boxes.byteLength + numbers.byteLength);
  joined.set(new Uint8Array(boxes.buffer), 0);
  joined.set(new Uint8Array(numbers.buffer), boxes.byteLength);
  return joined.buffer;
}

// Page 0 is "ab" on line 0 and "cd" on line 1 (the separator is char 2); page 1 is "ef" on one line.
// Boxes are points, visible page space, origin top-left.
const LAYERS: Record<number, Methods['text.layer']['result']> = {
  0: {
    revision: 0,
    text: 'ab\ncd',
    line_rects: [],
    chars: joinChars(
      new Float32Array([
        72, 72, 84, 84, 84, 72, 96, 84, 0, 0, 0, 0, 72, 96, 84, 108, 84, 96, 96, 108,
      ]),
      new Uint32Array([0, 0, 0, 1, 1]),
    ),
  },
  1: {
    revision: 0,
    text: 'ef',
    line_rects: [],
    chars: joinChars(
      new Float32Array([72, 120, 84, 132, 84, 120, 96, 132]),
      new Uint32Array([0, 0]),
    ),
  },
};

let host: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

// Two pages side by side in one host, both drawn from the same selection model.
async function renderPages(selection: TextSelection | null | undefined, zoom = 1) {
  const call = vi.fn((_method: 'text.layer', params: { page: number }) =>
    Promise.resolve(LAYERS[params.page] as Methods['text.layer']['result']),
  );
  const cache = new TextLayerCache({ call } as unknown as TextRpc, 'doc-1');
  await act(async () => {
    root.render(
      <>
        {[0, 1].map((page) => (
          <div key={page} className="doc-page" data-page={page}>
            <PageTextLayer
              cache={cache}
              page={page}
              revision={0}
              zoom={zoom}
              selection={selection}
            />
          </div>
        ))}
      </>,
    );
  });
  await flush();
}

function marksOn(page: number): HTMLElement[] {
  return Array.from(
    host.querySelectorAll<HTMLElement>(`[data-page="${page}"] .page-selection-mark`),
  );
}

// The box of a mark as the page element places it, in CSS pixels (96/72 per point at zoom 1).
function box(mark: HTMLElement) {
  return {
    left: mark.style.left,
    top: mark.style.top,
    width: mark.style.width,
    height: mark.style.height,
  };
}

describe('the drawn selection', () => {
  it('draws one mark per line across two lines and two pages, as the model covers them', async () => {
    // From before "b" on page 0 (line 0) to before "f"'s end: "b", the break, "cd" on page 0;
    // then "e" on page 1.
    await renderPages(new TextSelection({ page: 0, index: 1 }, { page: 1, index: 1 }));

    // Page 0: "b" on line 0 (x 84-96, y 72-84 pt), "cd" on line 1 (x 72-96, y 96-108 pt).
    expect(marksOn(0).map(box)).toEqual([
      { left: '112px', top: '96px', width: '16px', height: '16px' },
      { left: '96px', top: '128px', width: '32px', height: '16px' },
    ]);
    // Page 1: "e" only (x 72-84, y 120-132 pt).
    expect(marksOn(1).map(box)).toEqual([
      { left: '96px', top: '160px', width: '16px', height: '16px' },
    ]);
  });

  it('scales the marks with the zoom', async () => {
    await renderPages(new TextSelection({ page: 0, index: 0 }, { page: 0, index: 2 }), 2);
    // "ab" at zoom 2: x 72-96 pt, y 72-84 pt, times 2 times 96/72.
    expect(marksOn(0).map(box)).toEqual([
      { left: '192px', top: '192px', width: '64px', height: '32px' },
    ]);
    expect(marksOn(1)).toHaveLength(0);
  });

  it('draws nothing for an empty selection, and the model stays in charge of the page', async () => {
    await renderPages(new TextSelection({ page: 0, index: 1 }, { page: 0, index: 1 }));
    expect(host.querySelectorAll('.page-selection-mark')).toHaveLength(0);
    const layer = host.querySelector('[data-page="0"] .page-text-layer');
    expect(layer?.classList.contains('page-text-layer--model')).toBe(true);
  });

  it('leaves the browser selection and the model out when no model is given', async () => {
    await renderPages(undefined);
    expect(host.querySelectorAll('.page-selection-mark')).toHaveLength(0);
    expect(host.querySelector('.page-text-layer--model')).toBeNull();
  });

  it('turns the browser selection off on the spans in the stylesheet', () => {
    // jsdom does not apply the stylesheet, so the rule itself is checked.
    const css = readFileSync(join(process.cwd(), 'src/text/textLayer.css'), 'utf8');
    const rule = /\.page-text-layer--model \.page-text-line\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/user-select:\s*none/);
  });
});
