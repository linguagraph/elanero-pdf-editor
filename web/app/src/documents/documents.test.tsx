import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { type EngineClient, getTabSession, setTabSession } from '../engine/engineConnection';
import { fakeEngine, type FakeEngine } from '../engine/testEngine';
import { toasts } from '../feedback/toasts';
import { t } from '../i18n/t';
import { RECENT_STORAGE_KEY } from '../recent/recentFiles';
import { RpcError } from '../rpc/client';
import { APP_VERSION } from '../version';
import { passwordPrompt } from './passwordRequest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a collection takes focus.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) },
  });
}

interface Recorded {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

// A fake engine client. A file whose name starts with "locked" is protected: it needs the password
// "secret". A file whose name starts with "refused" fails to open. Every call is recorded.
function engineClient(): { client: EngineClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let opened = 0;
  const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === 'session.close') return {};
    if (method === 'session.pages') {
      // Three portrait pages, the page count the open reply gives.
      return { pages: [0, 1, 2].map(() => ({ width: 612, height: 792, rotation: 0 })) };
    }
    // The view asks for pixels; these tests do not check them. A reply that never comes keeps the
    // view from retrying, which a rejected render would make it do endlessly.
    if (method === 'render.page') return new Promise<never>(() => undefined);
    if (method !== 'session.open') throw new Error(`unexpected ${method}`);
    const name = String(params['name']);
    if (name.startsWith('refused')) throw new RpcError('OPEN_FAILED', 'damaged');
    if (name.startsWith('locked')) {
      if (params['password'] === null) throw new RpcError('PASSWORD_REQUIRED', 'protected');
      if (params['password'] !== 'secret') throw new RpcError('WRONG_PASSWORD', 'wrong');
    }
    opened += 1;
    return {
      handle: `doc-${opened}`,
      info: {
        encrypted: false,
        has_signatures: false,
        page_count: 3,
        title: '',
        author: '',
        subject: '',
        keywords: '',
        creator: '',
        producer: '',
        creation_date: '',
        mod_date: '',
      },
      pages: 3,
      warning: null,
      state: {},
    };
  });
  return { client: { call } as unknown as EngineClient, calls };
}

let host: HTMLDivElement;
let root: Root;
let engine: FakeEngine;
let calls: Recorded[];

beforeEach(() => {
  window.localStorage.clear();
  // Tab sessions live in a module-level store, so each test starts with none for the first tabs.
  for (const id of [1, 2, 3]) setTabSession(id, null);
  const scripted = engineClient();
  calls = scripted.calls;
  engine = fakeEngine(scripted.client);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root.render(<App engine={engine} />);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  act(() => {
    root.unmount();
  });
  host.remove();
  window.localStorage.clear();
  passwordPrompt.answer(null);
  const queue = toasts.getState();
  for (const toast of [...queue.visible, ...queue.queued]) toasts.dismiss(toast.id);
});

function pdf(name: string, content = '%PDF-1.4 body'): File {
  return new File([content], name, { type: 'application/pdf' });
}

function dropFiles(files: File[]): void {
  const zone = host.querySelector<HTMLElement>('.start-drop');
  if (zone === null) throw new Error('no drop zone');
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files } });
  act(() => {
    zone.dispatchEvent(event);
  });
}

// Waits for the engine's answers to reach the screen. Reading a file and the engine's reply are
// asynchronous, so the check runs again after each short pause until it holds or the tries run out.
async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

function buttonNamed(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === text || button.getAttribute('aria-label') === text,
  );
  if (found === undefined) throw new Error(`no button ${text}`);
  return found;
}

// The password dialog is in a portal on document.body, so its buttons are looked up there.
function dialogButton(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === text,
  );
  if (found === undefined) throw new Error(`no dialog button ${text}`);
  return found;
}

function passwordInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('input[type="password"]');
}

function typePassword(value: string): void {
  const input = passwordInput();
  if (input === null) throw new Error('no password field');
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function submitPassword(): void {
  const form = passwordInput()?.form;
  if (form === null || form === undefined) throw new Error('no password form');
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

function tabNames(): string[] {
  return [...host.querySelectorAll<HTMLElement>('[role="tab"] .doc-tab-name')].map(
    (el) => el.textContent ?? '',
  );
}

function errorToasts(): string[] {
  return toasts
    .getState()
    .visible.filter((toast) => toast.kind === 'error')
    .map((toast) => toast.text);
}

function infoToasts(): string[] {
  return toasts
    .getState()
    .visible.filter((toast) => toast.kind === 'info')
    .map((toast) => toast.text);
}

function openCalls(): Recorded[] {
  return calls.filter((call) => call.method === 'session.open');
}

describe('start page', () => {
  it('shows the start page when no document tab is open', () => {
    expect(host.querySelector('.start-page')).not.toBeNull();
    expect(host.querySelector('[role="tablist"]')).toBeNull();
  });

  it('opens the file input from the Open button, which accepts PDFs only', () => {
    const clicked = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    act(() => {
      buttonNamed(t('start.open')).click();
    });
    expect(clicked).toHaveBeenCalledTimes(1);
    const input = host.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input?.getAttribute('accept')).toBe('application/pdf');
  });

  it('reaches the Open button with the keyboard', () => {
    const open = buttonNamed(t('start.open'));
    expect(open.tabIndex).toBeGreaterThanOrEqual(0);
    act(() => {
      open.focus();
    });
    expect(document.activeElement).toBe(open);
  });

  it('describes the drop zone with text a screen reader can read', () => {
    const zone = host.querySelector<HTMLElement>('.start-drop');
    const describedBy = zone?.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(t('start.drop'));
  });

  it('opens a dropped PDF through session.open and adds its tab', async () => {
    dropFiles([pdf('report.pdf')]);
    await until(() => tabNames().length === 1);
    expect(tabNames()).toEqual(['report.pdf']);
    expect(openCalls()).toHaveLength(1);
    expect(openCalls()[0]?.params).toMatchObject({ name: 'report.pdf', password: null });
    expect(host.querySelector('.start-page')).toBeNull();
  });

  it('shows an error toast for a dropped file that is not a PDF, and opens no tab', () => {
    dropFiles([new File(['hello'], 'notes.txt', { type: 'text/plain' })]);
    expect(tabNames()).toEqual([]);
    expect(calls).toEqual([]);
    expect(errorToasts()).toEqual([t('open.notPdf', { name: 'notes.txt' })]);
  });

  it('accepts a PDF by its name when the browser gives no type', async () => {
    dropFiles([new File(['%PDF'], 'scan.PDF')]);
    await until(() => tabNames().length === 1);
    expect(tabNames()).toEqual(['scan.PDF']);
  });

  it('does not call the engine before it is ready, and says so', () => {
    const notReady = fakeEngine();
    act(() => {
      root.render(<App engine={notReady} />);
    });
    dropFiles([pdf('report.pdf')]);
    expect(tabNames()).toEqual([]);
    expect(infoToasts()).toEqual([t('open.engineNotReady')]);
    expect(calls).toEqual([]);
  });

  it('shows the engine error as a toast and opens no tab', async () => {
    dropFiles([pdf('refused.pdf')]);
    await until(() => errorToasts().length === 1);
    expect(tabNames()).toEqual([]);
    expect(errorToasts()).toEqual([t('error.OPEN_FAILED')]);
  });

  it('lists the recent files newest first, and a click asks for the file again', async () => {
    dropFiles([pdf('first.pdf')]);
    await until(() => tabNames().length === 1);
    act(() => {
      buttonNamed(t('tabs.close', { name: 'first.pdf' })).click();
    });
    dropFiles([pdf('second.pdf')]);
    await until(() => tabNames().length === 1);
    act(() => {
      buttonNamed(t('tabs.close', { name: 'second.pdf' })).click();
    });
    const names = [...host.querySelectorAll<HTMLElement>('.start-recent-name')].map(
      (el) => el.textContent,
    );
    expect(names).toEqual(['second.pdf', 'first.pdf']);

    const clicked = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    act(() => {
      buttonNamed('first.pdf').click();
    });
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.start-hint')?.textContent).toBe(
      t('start.recent.pickAgain', { name: 'first.pdf' }),
    );
  });

  it('keeps only names and times in storage, never the file content', async () => {
    dropFiles([pdf('contract.pdf', '%PDF-1.7 SECRET-PAGE-TEXT')]);
    await until(() => window.localStorage.getItem(RECENT_STORAGE_KEY) !== null);
    const stored = window.localStorage.getItem(RECENT_STORAGE_KEY) ?? '';
    expect(stored).toContain('contract.pdf');
    expect(stored).not.toContain('SECRET-PAGE-TEXT');
    expect(stored).not.toContain('%PDF');
    const entries: unknown[] = JSON.parse(stored);
    expect(Object.keys(entries[0] as object).sort()).toEqual(['name', 'openedAt']);
  });
});

describe('password prompt', () => {
  it('asks once, opens with the password, and stores nothing', async () => {
    dropFiles([pdf('locked.pdf')]);
    await until(() => passwordInput() !== null);
    expect(document.querySelector('.overlay-dialog')?.textContent).toContain('locked.pdf');
    typePassword('secret');
    submitPassword();
    await until(() => tabNames().length === 1);

    expect(tabNames()).toEqual(['locked.pdf']);
    expect(openCalls().map((call) => call.params['password'])).toEqual([null, 'secret']);
    expect(passwordInput()).toBeNull();
    expect(JSON.stringify({ ...window.localStorage })).not.toContain('secret');
    expect(window.sessionStorage.length).toBe(0);
  });

  it('a cancelled prompt opens no tab and calls the engine once', async () => {
    dropFiles([pdf('locked.pdf')]);
    await until(() => passwordInput() !== null);
    act(() => {
      dialogButton(t('action.cancel')).click();
    });
    await until(() => passwordInput() === null);
    expect(tabNames()).toEqual([]);
    expect(openCalls()).toHaveLength(1);
    expect(errorToasts()).toEqual([]);
  });

  it('a wrong password is reported once, and the prompt does not come back', async () => {
    dropFiles([pdf('locked.pdf')]);
    await until(() => passwordInput() !== null);
    typePassword('nope');
    submitPassword();
    await until(() => errorToasts().length === 1);

    expect(errorToasts()).toEqual([t('error.WRONG_PASSWORD')]);
    expect(openCalls()).toHaveLength(2);
    expect(passwordInput()).toBeNull();
    expect(tabNames()).toEqual([]);
  });
});

describe('document tabs', () => {
  it('closes a tab with session.close for its handle, and brings the start page back', async () => {
    dropFiles([pdf('a.pdf'), pdf('b.pdf')]);
    await until(() => tabNames().length === 2);
    expect(tabNames()).toEqual(['a.pdf', 'b.pdf']);
    act(() => {
      buttonNamed(t('tabs.close', { name: 'b.pdf' })).click();
    });
    expect(tabNames()).toEqual(['a.pdf']);
    expect(calls.filter((call) => call.method === 'session.close')).toEqual([
      { method: 'session.close', params: { handle: 'doc-2' } },
    ]);
    act(() => {
      buttonNamed(t('tabs.close', { name: 'a.pdf' })).click();
    });
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    expect(host.querySelector('.start-page')).not.toBeNull();
  });

  it('gives a successfully opened tab its engine session, with the handle', async () => {
    dropFiles([pdf('a.pdf')]);
    await until(() => tabNames().length === 1);
    const session = getTabSession(1);
    expect(session).not.toBeNull();
    expect(session?.handle).toBe('doc-1');
    expect(session?.rpc).toBeDefined();
  });

  it('gives no session to a tab whose open failed', async () => {
    dropFiles([pdf('refused.pdf')]);
    await until(() => errorToasts().length === 1);
    expect(tabNames()).toEqual([]);
    expect(getTabSession(1)).toBeNull();
  });

  it('clears the session of a closed tab and keeps the others', async () => {
    dropFiles([pdf('a.pdf'), pdf('b.pdf')]);
    await until(() => tabNames().length === 2);
    expect(getTabSession(2)?.handle).toBe('doc-2');
    act(() => {
      buttonNamed(t('tabs.close', { name: 'b.pdf' })).click();
    });
    expect(getTabSession(2)).toBeNull();
    expect(getTabSession(1)?.handle).toBe('doc-1');
  });

  it('mounts the document view for an opened tab, which asks for its pages', async () => {
    dropFiles([pdf('a.pdf')]);
    await until(() => host.querySelector('.doc-page') !== null);
    expect(host.querySelector('.doc-view')).not.toBeNull();
    // Only the pages near the (jsdom) viewport are mounted; the first one is among them.
    expect(
      host.querySelector(`[aria-label="${t('view.pageNumber', { page: 1, total: 3 })}"]`),
    ).not.toBeNull();
    expect(calls.filter((call) => call.method === 'session.pages')).toEqual([
      { method: 'session.pages', params: { handle: 'doc-1' } },
    ]);
  });

  it('shows only the document view when a document is open, with no About text', async () => {
    expect(host.textContent).toContain(t('about.title'));
    dropFiles([pdf('a.pdf')]);
    await until(() => host.querySelector('.doc-page') !== null);
    expect(host.querySelector('.doc-view')).not.toBeNull();
    expect(host.querySelector('h1')).toBeNull();
    expect(host.textContent).not.toContain(t('about.title'));
    expect(host.textContent).not.toContain(t('app.version', { version: APP_VERSION }));
  });

  it('shows the page indicator as Page 1 of N at the start', async () => {
    dropFiles([pdf('a.pdf')]);
    await until(() => host.querySelector('.doc-page') !== null);
    expect(host.querySelector('.doc-status-page')?.textContent).toBe(
      t('view.pageNumber', { page: 1, total: 3 }),
    );
    expect(host.querySelector('.doc-status-zoom')?.textContent).toBe(
      t('view.zoomPercent', { percent: 100 }),
    );
  });

  it('updates the page indicator when the view scrolls to another page', async () => {
    dropFiles([pdf('a.pdf')]);
    await until(() => host.querySelector('.doc-page') !== null);
    const scroller = host.querySelector<HTMLElement>('.doc-view-scroll');
    if (scroller === null) throw new Error('no scroll area');
    // Each page is 1056 CSS px tall with the gaps; this offset puts page 2 at the viewport's centre.
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 1100 });
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(host.querySelector('.doc-status-page')?.textContent).toBe(
      t('view.pageNumber', { page: 2, total: 3 }),
    );
  });

  it('keeps About and no status bar on the start page', () => {
    expect(host.querySelector('h1')?.textContent).toBe(t('app.name'));
    expect(host.textContent).toContain(t('about.title'));
    expect(host.querySelector('.doc-status')).toBeNull();
  });

  it('moves between tabs with the arrow keys', async () => {
    dropFiles([pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')]);
    await until(() => tabNames().length === 3);
    const tabs = [...host.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs[2]?.getAttribute('aria-selected')).toBe('true');
    act(() => {
      tabs[2]?.focus();
    });
    act(() => {
      tabs[2]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(
      host.querySelectorAll<HTMLElement>('[role="tab"]')[1]?.getAttribute('aria-selected'),
    ).toBe('true');
  });
});
