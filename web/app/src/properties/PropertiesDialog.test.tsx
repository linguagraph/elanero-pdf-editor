import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { createToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import type { DocInfo, FontRow } from '../rpc/generated';
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
    if (method === 'session.fonts') return { fonts: [] };
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

function tabNamed(label: string): HTMLElement {
  const tab = [...document.body.querySelectorAll('[role="tab"]')].find(
    (el) => el.textContent === label,
  );
  if (tab === undefined) throw new Error(`no tab ${label}`);
  return tab as HTMLElement;
}

function pressKey(target: HTMLElement, key: string): void {
  act(() => {
    target.focus();
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

// The value shown next to a label in the properties' definition lists.
function factValue(label: string): string | undefined {
  const dt = [...document.body.querySelectorAll('dt')].find((el) => el.textContent === label);
  return dt?.nextElementSibling?.textContent ?? undefined;
}

function openDialog(rpc: PageRpc, store?: ReturnType<typeof createToastStore>): void {
  act(() => {
    root.render(
      <PropertiesDialog isOpen onClose={() => undefined} rpc={rpc} handle="h1" store={store} />,
    );
  });
}

describe('the properties tabs (W7.6 slice A)', () => {
  it('offers Description and Advanced, with Description selected first', async () => {
    const { rpc } = fakeRpc();
    openDialog(rpc);
    await flush();
    const list = document.body.querySelector('[role="tablist"]');
    expect(list?.getAttribute('aria-label')).toBe(t('properties.tabs.label'));
    expect(tabNamed(t('properties.tab.description')).getAttribute('aria-selected')).toBe('true');
    expect(tabNamed(t('properties.tab.advanced')).getAttribute('aria-selected')).toBe('false');
    expect(field(t('properties.field.title')).value).toBe('Report');
  });

  it('the selected tab controls the visible panel and the panel names it', async () => {
    const { rpc } = fakeRpc();
    openDialog(rpc);
    await flush();
    const tab = tabNamed(t('properties.tab.description'));
    const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
    expect(panel?.getAttribute('role')).toBe('tabpanel');
    expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id);
  });

  it('arrow keys move between the tabs and Home and End go to the ends', async () => {
    const { rpc } = fakeRpc();
    openDialog(rpc);
    await flush();
    const description = tabNamed(t('properties.tab.description'));
    const advanced = tabNamed(t('properties.tab.advanced'));
    pressKey(description, 'ArrowRight');
    expect(advanced.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(advanced);
    pressKey(advanced, 'ArrowLeft');
    expect(description.getAttribute('aria-selected')).toBe('true');
    pressKey(description, 'End');
    await flush();
    const fonts = document.querySelectorAll('[role="tab"]')[2] as HTMLElement;
    expect(fonts.getAttribute('aria-selected')).toBe('true');
    pressKey(fonts, 'Home');
    expect(description.getAttribute('aria-selected')).toBe('true');
  });

  it('Apply sends the Description edits made before switching to Advanced', async () => {
    const { call, rpc } = fakeRpc();
    const onClose = vi.fn();
    act(() => {
      root.render(<PropertiesDialog isOpen onClose={onClose} rpc={rpc} handle="h1" />);
    });
    await flush();
    act(() => typeInto(field(t('properties.field.author')), 'Finance'));
    pressKey(tabNamed(t('properties.tab.description')), 'ArrowRight');
    await act(async () => {
      applyButton().click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const calls = call.mock.calls as unknown as [string, unknown][];
    const runs = calls.filter(([method]) => method === 'actions.run');
    expect(runs[0]?.[1]).toMatchObject({ args: { metadata: { author: 'Finance' } } });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('the PDF version on the Advanced tab', () => {
  it('shows the version as text, read with session.info, and no input', async () => {
    const { call, rpc } = fakeRpc();
    openDialog(rpc);
    await flush();
    expect(call).toHaveBeenCalledWith('session.info', { handle: 'h1' });
    pressKey(tabNamed(t('properties.tab.description')), 'ArrowRight');
    expect(factValue(t('properties.version'))).toBe('1.7');
    expect(factValue(t('properties.pages'))).toBe('2');
    expect(factValue(t('properties.tagged'))).toBe(t('properties.no'));
    const panel = document.querySelector('[role="tabpanel"]:not([hidden])') as HTMLElement;
    expect(panel.querySelector('input')).toBeNull();
  });

  it('a file that reports no version shows "Not set"', async () => {
    const blank = { ...info, pdf_version: '' };
    const emptyRpc = {
      call: vi.fn(async (method: string) => (method === 'session.info' ? blank : {})),
    } as unknown as PageRpc;
    openDialog(emptyRpc);
    await flush();
    pressKey(tabNamed(t('properties.tab.description')), 'ArrowRight');
    expect(factValue(t('properties.version'))).toBe(t('properties.empty'));
  });
});

function fontRows(): FontRow[] {
  return [
    {
      name: 'Helvetica',
      type: 'Type1',
      encoding: 'WinAnsiEncoding',
      embedded: false,
      subset: false,
      pages: [0, 1, 2, 6],
    },
    {
      name: 'Arial',
      type: 'TrueType',
      encoding: 'Identity-H',
      embedded: true,
      subset: true,
      pages: [1],
    },
  ];
}

// A fake engine whose session.fonts answers with each of `replies` in turn, then the last one.
function fontsRpc(...replies: Array<FontRow[] | Error>) {
  let next = 0;
  const call = vi.fn(async (method: string) => {
    if (method === 'session.info') return info;
    if (method !== 'session.fonts') return {};
    const reply = replies[Math.min(next, replies.length - 1)] ?? [];
    next += 1;
    if (reply instanceof Error) throw reply;
    return { fonts: reply };
  });
  return { call, rpc: { call } as unknown as PageRpc };
}

function fontsCalls(call: ReturnType<typeof fontsRpc>['call']): number {
  return call.mock.calls.filter(([method]) => method === 'session.fonts').length;
}

function fontsTableRows(): string[][] {
  return [...document.querySelectorAll('.properties-fonts tbody tr')].map((row) =>
    [...row.querySelectorAll('td')].map((cell) => cell.textContent ?? ''),
  );
}

describe('the Fonts tab (W7.6 slice B)', () => {
  it('reads session.fonts once, when the tab is first shown', async () => {
    const { call, rpc } = fontsRpc(fontRows());
    openDialog(rpc);
    await flush();
    expect(fontsCalls(call)).toBe(0);
    pressKey(tabNamed(t('properties.tab.description')), 'ArrowRight');
    pressKey(tabNamed(t('properties.tab.advanced')), 'ArrowRight');
    await flush();
    expect(call).toHaveBeenCalledWith('session.fonts', { handle: 'h1' });
    expect(fontsCalls(call)).toBe(1);
    pressKey(tabNamed(t('properties.tab.fontsCount', { count: 2 })), 'ArrowLeft');
    pressKey(tabNamed(t('properties.tab.advanced')), 'ArrowRight');
    await flush();
    expect(fontsCalls(call)).toBe(1);
  });

  it('labels the tab with the count and lists each font with its embedding and pages', async () => {
    const { rpc } = fontsRpc(fontRows());
    openDialog(rpc);
    await flush();
    pressKey(tabNamed(t('properties.tab.description')), 'ArrowRight');
    pressKey(tabNamed(t('properties.tab.advanced')), 'ArrowRight');
    await flush();
    expect(tabNamed(t('properties.tab.fontsCount', { count: 2 }))).toBeTruthy();
    expect(fontsTableRows()).toEqual([
      ['Helvetica', 'Type1', 'WinAnsiEncoding', t('properties.fonts.notEmbedded'), '1-3, 7'],
      ['Arial', 'TrueType', 'Identity-H', t('properties.fonts.subset'), '2'],
    ]);
  });

  it('a busy engine shows the busy line, and Retry reads the fonts again', async () => {
    const busy = new RpcError('BUSY', 'another job is running');
    const { call, rpc } = fontsRpc(busy, fontRows());
    openDialog(rpc);
    await flush();
    pressKey(tabNamed(t('properties.tab.description')), 'ArrowRight');
    pressKey(tabNamed(t('properties.tab.advanced')), 'ArrowRight');
    await flush();
    expect(document.body.textContent).toContain(t('properties.fonts.busy'));
    const retry = [...document.body.querySelectorAll('button')].find(
      (el) => el.textContent === t('properties.fonts.retry'),
    );
    expect(retry).toBeDefined();
    act(() => retry?.click());
    await flush();
    expect(fontsCalls(call)).toBe(2);
    expect(fontsTableRows()).toHaveLength(2);
  });

  it('a failed read shows the failure line and an error toast', async () => {
    const store = createToastStore();
    const { rpc } = fontsRpc(new Error('boom'));
    openDialog(rpc, store);
    await flush();
    pressKey(tabNamed(t('properties.tab.description')), 'ArrowRight');
    pressKey(tabNamed(t('properties.tab.advanced')), 'ArrowRight');
    await flush();
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(t('properties.fonts.failed'));
    expect(store.getState().visible.some((toast) => toast.kind === 'error')).toBe(true);
  });

  it('a document with no fonts says so', async () => {
    const { rpc } = fontsRpc([]);
    openDialog(rpc);
    await flush();
    pressKey(tabNamed(t('properties.tab.description')), 'ArrowRight');
    pressKey(tabNamed(t('properties.tab.advanced')), 'ArrowRight');
    await flush();
    expect(document.body.textContent).toContain(t('properties.fonts.none'));
    expect(document.querySelector('.properties-fonts')).toBeNull();
  });
});
