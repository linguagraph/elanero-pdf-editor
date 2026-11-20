import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { createToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import type { DocInfo } from '../rpc/generated';
import { PropertiesDialog } from './PropertiesDialog';
import { MAX_FIELD_LENGTH } from './metadata';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) },
  });
}

const info: DocInfo = {
  encrypted: false,
  has_signatures: false,
  page_count: 2,
  title: 'Report',
  author: '',
  subject: '',
  keywords: '',
  creator: 'Writer',
  producer: 'PDF library',
  creation_date: 'D:20240101120000',
  mod_date: '',
  pdf_version: '1.7',
  is_tagged: false,
  has_forms: false,
  has_javascript: false,
  is_repaired: false,
  has_xmp: false,
};

let host: HTMLDivElement;
let root: Root;

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

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function fakeRpc() {
  const call = vi.fn(async (method: string) => {
    if (method === 'session.info') return info;
    if (method === 'actions.run') {
      return {
        label: 'Edit Document Properties',
        executed: true,
        value: null,
        changed: null,
        state: {},
      };
    }
    return { done: true, label: '', changed: null, state: {} };
  });
  return { call, rpc: { call } as unknown as PageRpc };
}

function field(label: string): HTMLInputElement {
  const input = [...document.body.querySelectorAll('label')]
    .find((el) => el.textContent?.startsWith(label))
    ?.querySelector('input');
  if (input === null || input === undefined) throw new Error(`no field ${label}`);
  return input;
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function applyButton(): HTMLButtonElement {
  const button = [...document.body.querySelectorAll('button')].find(
    (el) => el.textContent === t('properties.apply'),
  );
  if (button === undefined) throw new Error('no Apply button');
  return button;
}

describe('the document properties dialog', () => {
  it('shows the values read with session.info', async () => {
    const { call, rpc } = fakeRpc();
    act(() => {
      root.render(<PropertiesDialog isOpen onClose={() => undefined} rpc={rpc} handle="h1" />);
    });
    await flush();
    expect(call).toHaveBeenCalledWith('session.info', { handle: 'h1' });
    expect(field(t('properties.field.title')).value).toBe('Report');
    expect(document.body.textContent).toContain('PDF library');
  });

  it('Apply sends the changed field once and then closes', async () => {
    const { call, rpc } = fakeRpc();
    const onClose = vi.fn();
    act(() => {
      root.render(<PropertiesDialog isOpen onClose={onClose} rpc={rpc} handle="h1" />);
    });
    await flush();
    act(() => typeInto(field(t('properties.field.author')), 'Finance'));
    await act(async () => {
      applyButton().click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const calls = call.mock.calls as unknown as [string, unknown][];
    const runs = calls.filter(([method]) => method === 'actions.run');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.[1]).toMatchObject({
      name: 'document.set_metadata',
      args: { metadata: { author: 'Finance', title: 'Report' } },
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('an over-long field shows the message and sends nothing', async () => {
    const { call, rpc } = fakeRpc();
    act(() => {
      root.render(<PropertiesDialog isOpen onClose={() => undefined} rpc={rpc} handle="h1" />);
    });
    await flush();
    act(() => typeInto(field(t('properties.field.keywords')), 'k'.repeat(MAX_FIELD_LENGTH + 1)));
    await act(async () => {
      applyButton().click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(call.mock.calls.some(([method]) => method === 'actions.run')).toBe(false);
    expect(document.body.textContent).toContain(
      t('properties.tooLong', { max: MAX_FIELD_LENGTH, fields: t('properties.field.keywords') }),
    );
  });

  it('a successful apply leaves an Undo toast in the store', async () => {
    const { rpc } = fakeRpc();
    const store = createToastStore();
    act(() => {
      root.render(
        <PropertiesDialog isOpen onClose={() => undefined} rpc={rpc} handle="h1" store={store} />,
      );
    });
    await flush();
    act(() => typeInto(field(t('properties.field.subject')), 'Quarterly'));
    await act(async () => {
      applyButton().click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(store.getState().visible[0]?.action?.label).toBe(t('toast.undo'));
  });
});
