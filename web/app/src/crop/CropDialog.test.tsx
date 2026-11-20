import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { createToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import type { RunResult } from '../rpc/generated';
import type { CropValues } from './cropChoice';
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

  it('starts the crop box tool from Draw on page', async () => {
    const { rpc } = fakeRpc(() => Promise.resolve(reply(true)));
    const onDrawOnPage = vi.fn();
    act(() => {
      root.render(
        <CropDialog
          isOpen
          onClose={vi.fn()}
          rpc={rpc}
          handle="doc-1"
          pageCount={2}
          currentPage={2}
          signed={false}
          store={createToastStore()}
          onDrawOnPage={onDrawOnPage}
        />,
      );
    });
    await settle();
    const draw = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === t('crop.draw'),
    );
    act(() => {
      draw?.click();
    });
    expect(onDrawOnPage).toHaveBeenCalledTimes(1);
  });

  it('opens with the margins of a drawn box on its page, and reports each change', async () => {
    const { rpc } = fakeRpc(() => Promise.resolve(reply(true)));
    const onValuesChange = vi.fn();
    act(() => {
      root.render(
        <CropDialog
          isOpen
          onClose={vi.fn()}
          rpc={rpc}
          handle="doc-1"
          pageCount={2}
          currentPage={1}
          signed={false}
          store={createToastStore()}
          drawn={{ page: 2, margins: { left: 72, top: 108, right: 396, bottom: 576 } }}
          onValuesChange={onValuesChange}
        />,
      );
    });
    await settle();
    expect(field('left').value).toBe('72');
    expect(field('bottom').value).toBe('576');
    const current = document.querySelector<HTMLInputElement>('input[value="current"]');
    expect(current?.checked).toBe(true);
    typeText(field('top'), '110');
    expect(onValuesChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ top: '110', scope: 'current', unit: 'pt' }),
    );
  });

  it('reopens with the values the user had when given them back', async () => {
    const { rpc } = fakeRpc(() => Promise.resolve(reply(true)));
    const kept = {
      left: '9',
      top: '0',
      right: '0',
      bottom: '0',
      unit: 'pt' as const,
      scope: 'all' as const,
      range: '',
    };
    act(() => {
      root.render(
        <CropDialog
          isOpen
          onClose={vi.fn()}
          rpc={rpc}
          handle="doc-1"
          pageCount={2}
          currentPage={1}
          signed={false}
          store={createToastStore()}
          initialValues={kept}
        />,
      );
    });
    await settle();
    expect(field('left').value).toBe('9');
  });
});

describe('CropDialog with a drawn box (W4.11 S5)', () => {
  it('stores the drawn margins, so a Draw on page then Esc reopens with them', async () => {
    const { rpc } = fakeRpc(() => Promise.resolve(reply(true)));
    const onValuesChange = vi.fn();
    const drawn = { page: 1, margins: { left: 5, top: 6, right: 7, bottom: 8 } };
    act(() => {
      root.render(
        <CropDialog
          isOpen
          onClose={vi.fn()}
          rpc={rpc}
          handle="doc-1"
          pageCount={2}
          currentPage={1}
          signed={false}
          store={createToastStore()}
          drawn={drawn}
          onValuesChange={onValuesChange}
        />,
      );
    });
    await settle();
    expect(field('left').value).toBe('5');
    const stored = onValuesChange.mock.calls.at(-1)?.[0] as CropValues | undefined;
    expect(stored).toMatchObject({
      left: '5',
      top: '6',
      right: '7',
      bottom: '8',
      scope: 'current',
    });

    // Esc after Draw on page again: the caller reopens with the stored form and no drawn box.
    act(() => root.unmount());
    root = createRoot(host);
    act(() => {
      root.render(
        <CropDialog
          isOpen
          onClose={vi.fn()}
          rpc={rpc}
          handle="doc-1"
          pageCount={2}
          currentPage={1}
          signed={false}
          store={createToastStore()}
          initialValues={stored}
          drawn={null}
        />,
      );
    });
    await settle();
    expect(field('right').value).toBe('7');
    expect(field('bottom').value).toBe('8');
  });
});
