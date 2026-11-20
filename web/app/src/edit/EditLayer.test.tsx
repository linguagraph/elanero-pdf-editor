import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentObjectsResult, PageObjectDto, RectDto } from '../rpc/generated';
import { EditLayer, type EditSelection } from './EditLayer';
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

// CSS pixels for page points at a zoom: 96 px per 72 pt, as the view draws the page.
const css = (points: number, zoom: number) => points * zoom * (96 / 72);

function obj(key: string, bbox: RectDto, editable = true, reason = ''): PageObjectDto {
  return {
    type: 'text',
    key,
    bbox,
    text: '',
    style: null,
    editable,
    reason,
    image_size: [0, 0],
    stroke: false,
    fill: false,
  };
}

const TEXT = obj('text:0', { x0: 72, y0: 72, x1: 144, y1: 108 });
const IMAGE = obj('image:0', { x0: 200, y0: 200, x1: 260, y1: 260 });
const ROTATED = obj(
  'text:1',
  { x0: 300, y0: 300, x1: 340, y1: 320 },
  false,
  "rotated or vertical text can't be edited yet",
);

// A fake engine that answers every ask with the same list at the given revision.
function fakeCache(objects: PageObjectDto[], revision = 3, truncated = false): ObjectCache {
  const answer: ContentObjectsResult = { revision, objects, truncated };
  const rpc: ObjectsRpc = {
    call: vi.fn(async () => answer) as unknown as ObjectsRpc['call'],
  };
  return new ObjectCache(rpc, 'doc');
}

// The layer with its selection held the way the view holds it, so a click updates the layer.
function Harness({
  cache,
  zoom,
  initial,
  onSelect,
}: {
  cache: ObjectCache;
  zoom: number;
  initial: EditSelection | null;
  onSelect: (next: EditSelection) => void;
}) {
  const [selection, setSelection] = useState<EditSelection | null>(initial);
  return (
    <EditLayer
      cache={cache}
      page={0}
      revision={3}
      zoom={zoom}
      selection={selection}
      onSelect={(next) => {
        onSelect(next);
        setSelection(next);
      }}
    />
  );
}

async function mount(
  objects: PageObjectDto[],
  options: {
    zoom?: number;
    selected?: string[];
    onSelect?: (next: EditSelection) => void;
    revision?: number;
    truncated?: boolean;
  } = {},
): Promise<{ layer: HTMLElement; onSelect: ReturnType<typeof vi.fn> }> {
  const onSelect = vi.fn(options.onSelect ?? (() => undefined));
  const cache = fakeCache(objects, 3, options.truncated);
  const initial: EditSelection | null =
    options.selected === undefined
      ? null
      : { page: 0, revision: options.revision ?? 3, keys: options.selected };
  await act(async () => {
    root.render(
      <Harness cache={cache} zoom={options.zoom ?? 1} initial={initial} onSelect={onSelect} />,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const layer = host.querySelector<HTMLElement>('.edit-layer');
  if (layer === null) throw new Error('no edit layer');
  // jsdom has no layout: the layer covers the page box at the origin.
  layer.getBoundingClientRect = () => new DOMRect(0, 0, 2000, 2000);
  return { layer, onSelect };
}

function pointer(
  element: HTMLElement,
  type: string,
  x: number,
  y: number,
  init: { ctrlKey?: boolean } = {},
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    ctrlKey: init.ctrlKey ?? false,
  });
  act(() => {
    element.dispatchEvent(event);
  });
}

function outline(key: string): HTMLElement {
  const el = host.querySelector<HTMLElement>(`[data-key="${key}"]`);
  if (el === null) throw new Error(`no outline for ${key}`);
  return el;
}

// The px number of a style property, for comparing drawn positions.
const px = (el: HTMLElement, prop: 'left' | 'top' | 'width' | 'height') =>
  Number.parseFloat(el.style[prop]);

describe('EditLayer', () => {
  it('outlines every object and draws the handles of a single selection at zoom 1 and 2', async () => {
    await mount([TEXT, IMAGE], { selected: ['text:0'], zoom: 1 });
    expect(px(outline('text:0'), 'left')).toBeCloseTo(css(72, 1));
    expect(px(outline('text:0'), 'width')).toBeCloseTo(css(72, 1));
    expect(host.querySelectorAll('.edit-handle')).toHaveLength(8);
    expect(host.querySelector('.edit-outline--selected')?.getAttribute('data-key')).toBe('text:0');

    act(() => root.unmount());
    root = createRoot(host);
    await mount([TEXT, IMAGE], { selected: ['text:0'], zoom: 2 });
    expect(px(outline('text:0'), 'left')).toBeCloseTo(css(72, 2));
    expect(px(outline('text:0'), 'height')).toBeCloseTo(css(36, 2));
    expect(host.querySelectorAll('.edit-handle')).toHaveLength(8);
  });

  it('shows no handles when several objects are selected', async () => {
    await mount([TEXT, IMAGE], { selected: ['text:0', 'image:0'] });
    expect(host.querySelectorAll('.edit-handle')).toHaveLength(0);
  });

  it('selects the object under a click', async () => {
    const { layer, onSelect } = await mount([TEXT, IMAGE]);
    pointer(layer, 'pointerdown', css(230, 1), css(230, 1));
    pointer(layer, 'pointerup', css(230, 1), css(230, 1));
    expect(onSelect).toHaveBeenCalledWith({ page: 0, revision: 3, keys: ['image:0'] });
  });

  it('clears the selection on a click on empty ground', async () => {
    const { layer, onSelect } = await mount([TEXT, IMAGE], { selected: ['text:0'] });
    pointer(layer, 'pointerdown', css(500, 1), css(500, 1));
    pointer(layer, 'pointerup', css(500, 1), css(500, 1));
    expect(onSelect).toHaveBeenCalledWith({ page: 0, revision: 3, keys: [] });
  });

  it('adds to the selection on Ctrl+click', async () => {
    const { layer, onSelect } = await mount([TEXT, IMAGE], { selected: ['text:0'] });
    pointer(layer, 'pointerdown', css(230, 1), css(230, 1), { ctrlKey: true });
    pointer(layer, 'pointerup', css(230, 1), css(230, 1), { ctrlKey: true });
    expect(onSelect).toHaveBeenCalledWith({
      page: 0,
      revision: 3,
      keys: ['text:0', 'image:0'],
    });
  });

  it('previews a move of the selection while dragged, and does not commit it', async () => {
    const { layer, onSelect } = await mount([TEXT, IMAGE], { selected: ['text:0'] });
    // Press on the text, then drag 60 css px right: 45 pt.
    pointer(layer, 'pointerdown', css(90, 1), css(90, 1));
    pointer(layer, 'pointermove', css(90, 1) + 60, css(90, 1));
    expect(px(outline('text:0'), 'left')).toBeCloseTo(css(72 + 45, 1));
    pointer(layer, 'pointerup', css(90, 1) + 60, css(90, 1));
    expect(onSelect).not.toHaveBeenCalled();
    expect(px(outline('text:0'), 'left')).toBeCloseTo(css(72, 1));
  });

  it('previews a resize from a handle', async () => {
    const { layer } = await mount([TEXT], { selected: ['text:0'] });
    // Handle 7 is the bottom-right corner, at (144, 108) pt. Drag 24 css px right: 18 pt.
    pointer(layer, 'pointerdown', css(144, 1), css(108, 1));
    pointer(layer, 'pointermove', css(144, 1) + 24, css(108, 1));
    expect(px(outline('text:0'), 'width')).toBeCloseTo(css(90, 1));
    pointer(layer, 'pointerup', css(144, 1) + 24, css(108, 1));
    expect(px(outline('text:0'), 'width')).toBeCloseTo(css(72, 1));
  });

  it('treats a drag under half a point as a click', async () => {
    const { layer, onSelect } = await mount([TEXT, IMAGE], { selected: ['text:0', 'image:0'] });
    // Press on the text inside a two-object selection: a click collapses it to the text alone.
    pointer(layer, 'pointerdown', css(90, 1), css(90, 1));
    pointer(layer, 'pointermove', css(90, 1) + 0.3, css(90, 1));
    pointer(layer, 'pointerup', css(90, 1) + 0.3, css(90, 1));
    expect(onSelect).toHaveBeenCalledWith({ page: 0, revision: 3, keys: ['text:0'] });
  });

  it('shows the not-allowed cursor and the reason on a non-editable object', async () => {
    const { layer } = await mount([TEXT, ROTATED]);
    pointer(layer, 'pointermove', css(320, 1), css(310, 1));
    expect(layer.classList.contains('edit-layer--blocked')).toBe(true);
    expect(layer.getAttribute('title')).toBe("Rotated or vertical text can't be edited yet.");
    pointer(layer, 'pointermove', css(500, 1), css(500, 1));
    expect(layer.classList.contains('edit-layer--blocked')).toBe(false);
  });

  it('ignores a selection made at another revision', async () => {
    await mount([TEXT], { selected: ['text:0'], revision: 2 });
    expect(host.querySelector('.edit-outline--selected')).toBeNull();
    expect(host.querySelectorAll('.edit-handle')).toHaveLength(0);
  });

  it('notes a truncated list', async () => {
    await mount([TEXT], { truncated: true });
    expect(host.querySelector('.edit-note')).not.toBeNull();
  });
});
