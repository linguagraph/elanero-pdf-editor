import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { createToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import type { RunResult } from '../rpc/generated';
import { CropDialog } from './CropDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, '\\$&') },
  });
}

const PAGES = [
  { width: 612, height: 792, rotation: 0 },
  { width: 612, height: 792, rotation: 0 },
];

let host: HTMLDivElement;
let root: Root;

// A fake engine: session.pages answers with two letter pages; actions.run answers as `run`.
function fakeRpc(run: () => Promise<RunResult>) {
  const call = vi.fn((method: string) => {
    if (method === 'session.pages') return Promise.resolve({ pages: PAGES, labels: [] });
    if (method === 'actions.run') return run();
    return new Promise(() => undefined);
  });
  return { call, rpc: { call } as unknown as Pick<PageRpc, 'call'> as PageRpc };
}

function reply(executed: boolean): RunResult {
  return {
    label: 'Crop 2 Pages',
    executed,
    value: null,
    changed: null,
    state: { history: 1 } as unknown as RunResult['state'],
  };
}

function render(rpc: PageRpc, options: { signed?: boolean; onClose?: () => void } = {}) {
  const onClose = options.onClose ?? vi.fn();
  act(() => {
    root.render(
      <CropDialog
        isOpen
        onClose={onClose}
        rpc={rpc}
        handle="doc-1"
        pageCount={2}
        currentPage={2}
        signed={options.signed ?? false}
        store={createToastStore()}
      />,
    );
  });
  return { onClose };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function field(name: 'left' | 'top' | 'right' | 'bottom'): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>(`input[id$="-${name}"]`);
  if (found === null) throw new Error(`no ${name} field`);
  return found;
}

function typeText(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function cropButton(): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === t('crop.apply'),
  );
  if (found === undefined) throw new Error('no Crop button');
  return found;
}

function alertText(): string | null {
  return document.querySelector('[role="alert"]')?.textContent ?? null;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('CropDialog', () => {
  it('shows the signed note only for a signed document', async () => {
    const { rpc } = fakeRpc(() => Promise.resolve(reply(true)));
    render(rpc, { signed: false });
    await settle();
    expect(document.body.textContent).not.toContain(t('crop.signedNote'));
    act(() => root.unmount());
    root = createRoot(host);
    render(rpc, { signed: true });
    await settle();
    expect(document.body.textContent).toContain(t('crop.signedNote'));
  });

  it('crops every page with the margins in points and closes', async () => {
    const { call, rpc } = fakeRpc(() => Promise.resolve(reply(true)));
    const { onClose } = render(rpc);
    await settle();
    typeText(field('left'), '36');
    typeText(field('bottom'), '12');
    act(() => {
      cropButton().click();
    });
    await settle();
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'doc-1',
      name: 'pages.crop_margins',
      args: { pages: [0, 1], left: 36, top: 0, right: 0, bottom: 12 },
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('sends nothing for a negative margin and shows the message', async () => {
    const { call, rpc } = fakeRpc(() => Promise.resolve(reply(true)));
    const { onClose } = render(rpc);
    await settle();
    typeText(field('top'), '-3');
    act(() => {
      cropButton().click();
    });
    await settle();
    expect(call.mock.calls.some(([method]) => method === 'actions.run')).toBe(false);
    expect(alertText()).toBe(t('crop.error.negative'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows the refusal for margins the engine rejects and stays open', async () => {
    const refusal = new RpcError('REFUSED', 'refused', { reason: 'crop_too_large' });
    const { rpc } = fakeRpc(() => Promise.reject(refusal));
    const { onClose } = render(rpc);
    await settle();
    typeText(field('left'), '5');
    act(() => {
      cropButton().click();
    });
    await settle();
    expect(alertText()).toBe(t('error.REFUSED.cropTooLarge'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes without a toast when the engine did nothing', async () => {
    const { rpc } = fakeRpc(() => Promise.resolve(reply(false)));
    const { onClose } = render(rpc);
    await settle();
    act(() => {
      cropButton().click();
    });
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
