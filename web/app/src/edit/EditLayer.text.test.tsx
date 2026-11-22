import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import type { ContentObjectsResult, PageObjectDto, RectDto } from '../rpc/generated';
import { EditLayer } from './EditLayer';
import { ObjectCache, type ObjectsRpc } from './objectCache';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

// CSS pixels for page points at zoom 1, as the layer's pointer maths reads them (96 px per 72 pt).
const px = (points: number) => points * (96 / 72);

function block(key: string, bbox: RectDto, type: 'text' | 'image'): PageObjectDto {
  return {
    type,
    key,
    bbox,
    text: type === 'text' ? 'Paragraph' : '',
    style:
      type === 'text'
        ? {
            font: 'Helvetica',
            size: 12,
            color: { r: 0, g: 0, b: 0, a: 1 },
            bold: false,
            italic: false,
            align: 'left',
            line_height: 1.2,
            char_spacing: 0,
            word_spacing: 0,
          }
        : null,
    editable: true,
    reason: '',
    image_size: [0, 0],
    stroke: false,
    fill: false,
  } as unknown as PageObjectDto;
}

const TEXT = block('text:0', { x0: 72, y0: 72, x1: 300, y1: 120 }, 'text');
const IMAGE = block('image:0', { x0: 320, y0: 72, x1: 400, y1: 120 }, 'image');

function setup(onOpenText: (object: PageObjectDto) => void) {
  const answer: ContentObjectsResult = { revision: 3, objects: [TEXT, IMAGE], truncated: false };
  const objectsRpc: ObjectsRpc = {
    call: vi.fn(async () => answer) as unknown as ObjectsRpc['call'],
  };
  const cache = new ObjectCache(objectsRpc, 'doc');
  const rpc = {
    call: vi.fn(async () => ({ found: false, family: 'serif', program: null })),
  } as unknown as PageRpc;
  act(() => {
    root.render(
      <EditLayer
        cache={cache}
        page={0}
        revision={3}
        zoom={1}
        selection={null}
        onSelect={() => undefined}
        onCommit={() => undefined}
        rpc={rpc}
        handle="doc"
        onOpenText={onOpenText}
      />,
    );
  });
}

async function flush(): Promise<void> {
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

function doubleClickAt(x: number, y: number) {
  const layer = host.querySelector('.edit-layer') as HTMLDivElement;
  act(() => {
    layer.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, clientX: px(x), clientY: px(y) }),
    );
  });
}

describe('double-clicking a block with the Edit tool', () => {
  it('opens an editable paragraph in the text editor', async () => {
    const onOpenText = vi.fn();
    setup(onOpenText);
    await flush();
    doubleClickAt(100, 90);
    expect(onOpenText).toHaveBeenCalledWith(TEXT);
  });

  it('does nothing for an image, or for empty page', async () => {
    const onOpenText = vi.fn();
    setup(onOpenText);
    await flush();
    doubleClickAt(360, 90);
    doubleClickAt(10, 10);
    expect(onOpenText).not.toHaveBeenCalled();
  });
});
