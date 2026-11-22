// The style bar over the paragraph editor (W6.8b slice 1): the keys that change the style, what a
// commit sends, and the focus rules between the text and the bar.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { t } from '../i18n/t';
import type { PageObjectDto } from '../rpc/generated';
import { ParagraphEditor } from './ParagraphEditor';
import { DEFAULT_TEXT_STYLE, toActionStyle } from './textStyle';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  // The preview font is not under test: the engine has no program for the font.
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const paragraph: PageObjectDto = {
  type: 'text',
  key: 'text:3',
  bbox: { x0: 72, y0: 72, x1: 300, y1: 120 },
  text: 'Old words',
  style: { ...DEFAULT_TEXT_STYLE, font: 'Helvetica' },
  editable: true,
  reason: '',
  image_size: [0, 0],
  stroke: false,
  fill: false,
};

function mount() {
  const onApply = vi.fn(async () => true);
  const onClose = vi.fn();
  const call = vi.fn(async () => ({ found: false, family: 'serif', program: null }));
  const rpc = { call } as unknown as PageRpc;
  act(() =>
    root.render(
      <ParagraphEditor
        object={paragraph}
        page={0}
        zoom={1}
        rpc={rpc}
        handle="h1"
        onApply={onApply}
        onClose={onClose}
      />,
    ),
  );
  const area = host.querySelector('textarea') as HTMLTextAreaElement;
  const bar = host.querySelector<HTMLElement>('[role="toolbar"]') as HTMLElement;
  return { area, bar, onApply, onClose };
}

function keyDown(target: HTMLElement, init: KeyboardEventInit) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    );
  });
}

function leave(target: HTMLElement, next: EventTarget | null) {
  act(() => {
    target.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: next }));
  });
}

const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

describe('the style bar in the editor', () => {
  it('Ctrl+B toggles bold, and the commit sends the style with the text', async () => {
    const { area, onApply } = mount();
    keyDown(area, { key: 'b', ctrlKey: true });
    const bold = host.querySelector(`button[aria-label="${t('edit.style.bold')}"]`);
    expect(bold?.getAttribute('aria-pressed')).toBe('true');
    keyDown(area, { key: 'Enter', ctrlKey: true });
    await flush();
    expect(onApply).toHaveBeenCalledWith(
      'Old words',
      toActionStyle({ ...paragraph.style!, bold: true }),
    );
  });

  it('Ctrl+I toggles italic', () => {
    const { area } = mount();
    keyDown(area, { key: 'i', ctrlKey: true });
    const italic = host.querySelector(`button[aria-label="${t('edit.style.italic')}"]`);
    expect(italic?.getAttribute('aria-pressed')).toBe('true');
  });

  it('sends no style when the bar changed nothing, and closes on an unchanged text', async () => {
    const { area, onApply, onClose } = mount();
    keyDown(area, { key: 'Enter', ctrlKey: true });
    await flush();
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape in the text cancels the style change with the text', async () => {
    const { area, onApply, onClose } = mount();
    keyDown(area, { key: 'b', ctrlKey: true });
    keyDown(area, { key: 'Escape' });
    await flush();
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Alt+F10 moves to the bar, and Escape in the bar returns to the text', () => {
    const { area, bar } = mount();
    keyDown(area, { key: 'F10', altKey: true });
    expect(bar.contains(document.activeElement)).toBe(true);
    keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(document.activeElement).toBe(area);
  });

  it('a focus move from the text into the bar does not commit', async () => {
    const { area, bar, onApply, onClose } = mount();
    const size = bar.querySelector<HTMLElement>('input[type="number"]') as HTMLElement;
    leave(area, size);
    await flush();
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a focus move from the bar to outside commits the text', async () => {
    const { bar, area, onApply } = mount();
    // Give the bar a change, so the leave has something to send.
    keyDown(area, { key: 'b', ctrlKey: true });
    const outside = document.createElement('button');
    document.body.append(outside);
    leave(bar.querySelector<HTMLElement>('[data-stop]') as HTMLElement, outside);
    await flush();
    expect(onApply).toHaveBeenCalledWith(
      'Old words',
      toActionStyle({ ...paragraph.style!, bold: true }),
    );
    outside.remove();
  });
});
