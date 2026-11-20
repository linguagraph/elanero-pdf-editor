import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { t } from '../i18n/t';
import type { DrawnCrop } from '../crop/cropChoice';
import { DocumentView } from './DocumentView';
import type { ViewTool } from './viewTool';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Session.pages answers at once; render.page never answers, which keeps the test to the view.
function fakeRpc(): PageRpc {
  const rpc = {
    call: vi.fn((method: string) => {
      if (method === 'session.pages') {
        return Promise.resolve({
          pages: Array.from({ length: 2 }, () => ({ width: 612, height: 792, rotation: 0 })),
          labels: [],
        });
      }
      return new Promise(() => {});
    }),
  };
  return rpc as unknown as PageRpc;
}

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

function view(tool: ViewTool, onCropBoxEnd?: (drawn: DrawnCrop | null) => void) {
  return <DocumentView rpc={fakeRpc()} handle="h" tool={tool} onCropBoxEnd={onCropBoxEnd} />;
}

async function mount(tool: ViewTool, onCropBoxEnd?: (drawn: DrawnCrop | null) => void) {
  act(() => {
    root.render(view(tool, onCropBoxEnd));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function pointer(element: HTMLElement, type: string, x: number, y: number): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  act(() => {
    element.dispatchEvent(event);
  });
}

function commentButton(): HTMLButtonElement {
  const group = host.querySelector(`[role="group"][aria-label="${t('comment.toolbarLabel')}"]`);
  const button = group?.querySelector<HTMLButtonElement>('button');
  if (!button) throw new Error('no comment tool button');
  return button;
}

describe('DocumentView with the crop box tool (W4.11 S5)', () => {
  it('shows the hint and the crop layer on each page while the tool is on', async () => {
    await mount('cropBox');
    expect(host.querySelector('.crop-draw-hint')?.textContent).toBe(t('crop.drawHint'));
    expect(host.querySelector('.doc-view--crop-box')).not.toBeNull();
    expect(host.querySelectorAll('.crop-layer').length).toBeGreaterThan(0);
  });

  it('has no hint or layer with the Select tool', async () => {
    await mount('select');
    expect(host.querySelector('.crop-draw-hint')).toBeNull();
    expect(host.querySelector('.crop-layer')).toBeNull();
  });

  it('reports a drawn box with its page (1-based) and margins', async () => {
    const onCropBoxEnd = vi.fn();
    await mount('cropBox', onCropBoxEnd);
    const layer = host.querySelector<HTMLElement>('.crop-layer');
    if (layer === null) throw new Error('no crop layer');
    layer.getBoundingClientRect = () => new DOMRect(0, 0, 612, 792);
    pointer(layer, 'pointerdown', 100, 100);
    pointer(layer, 'pointerup', 400, 500);
    expect(onCropBoxEnd).toHaveBeenCalledTimes(1);
    const [drawn] = onCropBoxEnd.mock.calls[0] ?? [];
    expect(drawn.page).toBe(1);
    expect(drawn.margins.left).toBeGreaterThan(0);
    expect(drawn.margins.top).toBeGreaterThan(0);
  });

  it('ends the tool with no box when Esc is pressed', async () => {
    const onCropBoxEnd = vi.fn();
    await mount('cropBox', onCropBoxEnd);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onCropBoxEnd).toHaveBeenCalledWith(null);
  });

  it('turns a comment tool off when the crop box tool is chosen', async () => {
    await mount('select');
    act(() => {
      commentButton().click();
    });
    expect(commentButton().getAttribute('aria-pressed')).toBe('true');
    await mount('cropBox');
    expect(commentButton().getAttribute('aria-pressed')).toBe('false');
  });
});

describe('DocumentView crop box Esc (W4.11 S5)', () => {
  it('ignores Esc that was already handled', async () => {
    const onCropBoxEnd = vi.fn();
    await mount('cropBox', onCropBoxEnd);
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    event.preventDefault();
    act(() => {
      document.dispatchEvent(event);
    });
    expect(onCropBoxEnd).not.toHaveBeenCalled();
  });

  it('ignores Esc while an overlay is open, so the dialog owns it', async () => {
    const onCropBoxEnd = vi.fn();
    await mount('cropBox', onCropBoxEnd);
    const backdrop = document.createElement('div');
    backdrop.className = 'overlay-backdrop';
    document.body.append(backdrop);
    try {
      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
      expect(onCropBoxEnd).not.toHaveBeenCalled();
    } finally {
      backdrop.remove();
    }
  });
});
