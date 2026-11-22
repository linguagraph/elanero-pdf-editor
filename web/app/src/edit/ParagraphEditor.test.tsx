import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { t } from '../i18n/t';
import type { PageObjectDto } from '../rpc/generated';
import { ParagraphEditor } from './ParagraphEditor';

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
  vi.restoreAllMocks();
});

const paragraph: PageObjectDto = {
  type: 'text',
  key: 'text:3',
  bbox: { x0: 72, y0: 72, x1: 300, y1: 120 },
  text: 'Old words',
  style: {
    font: 'Helvetica',
    size: 12,
    color: { r: 0, g: 0, b: 0, a: 1 },
    bold: false,
    italic: false,
    align: 'left',
    line_height: 1.2,
    char_spacing: 0,
    word_spacing: 0,
  },
  editable: true,
  reason: '',
  image_size: [0, 0],
  stroke: false,
  fill: false,
};

// The preview asks the engine for the font; a font it lacks gives the generic family.
function fakeRpc() {
  const call = vi.fn(async () => ({ found: false, family: 'serif', program: null }));
  return { rpc: { call } as unknown as PageRpc, call };
}

function mount(options: {
  onApply?: (text: string) => Promise<boolean>;
  onClose?: () => void;
  zoom?: number;
  object?: PageObjectDto;
}) {
  const onApply = options.onApply ?? vi.fn(async () => true);
  const onClose = options.onClose ?? vi.fn();
  const { rpc, call } = fakeRpc();
  const render = (zoom: number) => (
    <ParagraphEditor
      object={options.object ?? paragraph}
      page={0}
      zoom={zoom}
      rpc={rpc}
      handle="h1"
      onApply={onApply}
      onClose={onClose}
    />
  );
  act(() => root.render(render(options.zoom ?? 1)));
  const area = host.querySelector('textarea') as HTMLTextAreaElement;
  return {
    area,
    onApply,
    onClose,
    call,
    rerender: (zoom: number) => act(() => root.render(render(zoom))),
  };
}

// Types into the textarea the way the browser does: the native setter, then an input event.
function typeInto(area: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(area, text);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function keyDown(area: HTMLTextAreaElement, init: KeyboardEventInit) {
  act(() => {
    area.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
}

const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

describe('opening the editor', () => {
  it('shows the block text, selected and focused, with its label and hint', () => {
    const { area } = mount({});
    expect(area.value).toBe('Old words');
    expect(document.activeElement).toBe(area);
    expect(area.selectionStart).toBe(0);
    expect(area.selectionEnd).toBe('Old words'.length);
    expect(area.getAttribute('aria-label')).toBe(t('edit.text.editorLabel'));
    const hint = document.getElementById(area.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toBe(t('edit.text.hint'));
  });

  it('asks the engine for the font the block uses', () => {
    const { call } = mount({});
    expect(call).toHaveBeenCalledWith('content.preview_font', {
      handle: 'h1',
      page: 0,
      font_name: 'Helvetica',
    });
  });
});

describe('committing and cancelling', () => {
  it('Ctrl+Enter applies the typed text and closes', async () => {
    const { area, onApply, onClose } = mount({});
    typeInto(area, 'New words');
    keyDown(area, { key: 'Enter', ctrlKey: true });
    await flush();
    expect(onApply).toHaveBeenCalledWith('New words');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Cmd+Enter applies too, on macOS', async () => {
    const { area, onApply } = mount({});
    typeInto(area, 'New');
    keyDown(area, { key: 'Enter', metaKey: true });
    await flush();
    expect(onApply).toHaveBeenCalledWith('New');
  });

  it('Escape closes with no call, and the typing is dropped', async () => {
    const { area, onApply, onClose } = mount({});
    typeInto(area, 'Typed then cancelled');
    keyDown(area, { key: 'Escape' });
    await flush();
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('an unchanged text closes without a call', async () => {
    const { area, onApply, onClose } = mount({});
    keyDown(area, { key: 'Enter', ctrlKey: true });
    await flush();
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a plain Enter adds a line and does not commit', () => {
    const { area, onApply, onClose } = mount({});
    typeInto(area, 'Old words\nmore');
    keyDown(area, { key: 'Enter' });
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a blur to another element of the app commits', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { area, onApply } = mount({});
    typeInto(area, 'Moved on');
    act(() => area.blur());
    await flush();
    expect(onApply).toHaveBeenCalledWith('Moved on');
  });

  it('a blur because the window lost focus does not commit', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const { area, onApply, onClose } = mount({});
    typeInto(area, 'Half typed');
    act(() => area.blur());
    await flush();
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('composition and busy engine', () => {
  it('Enter and Escape during an IME composition do not commit or close', async () => {
    const { area, onApply, onClose } = mount({});
    typeInto(area, 'Compos');
    keyDown(area, { key: 'Enter', ctrlKey: true, isComposing: true });
    keyDown(area, { key: 'Escape', isComposing: true });
    await flush();
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a busy engine keeps the editor open with its text, and the text can be committed again', async () => {
    const onApply = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { area, onClose } = mount({ onApply });
    typeInto(area, 'Retry me');
    keyDown(area, { key: 'Enter', ctrlKey: true });
    await flush();
    expect(onClose).not.toHaveBeenCalled();
    expect(area.value).toBe('Retry me');
    expect(area.getAttribute('aria-busy')).toBe('false');
    keyDown(area, { key: 'Enter', ctrlKey: true });
    await flush();
    expect(onApply).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a commit in flight is read-only and ignores a second commit', async () => {
    let finish: (value: boolean) => void = () => undefined;
    const onApply = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const { area } = mount({ onApply });
    typeInto(area, 'Slow');
    keyDown(area, { key: 'Enter', ctrlKey: true });
    expect(area.getAttribute('aria-busy')).toBe('true');
    expect(area.readOnly).toBe(true);
    keyDown(area, { key: 'Enter', ctrlKey: true });
    expect(onApply).toHaveBeenCalledTimes(1);
    await act(async () => finish(true));
  });
});

describe('zoom and unmount', () => {
  it('a zoom change keeps the typed text, the caret and the editor', () => {
    const { area, rerender } = mount({ zoom: 1 });
    typeInto(area, 'Kept');
    rerender(2);
    expect(host.querySelector('textarea')).toBe(area);
    expect(area.value).toBe('Kept');
  });

  it('unmounting with changed text commits it, as a tool change does', async () => {
    const onApply = vi.fn(async () => true);
    const { area } = mount({ onApply });
    typeInto(area, 'Left behind');
    act(() => root.unmount());
    root = createRoot(host);
    await flush();
    expect(onApply).toHaveBeenCalledWith('Left behind');
  });
});
