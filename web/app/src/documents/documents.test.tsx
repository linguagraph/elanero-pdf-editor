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
import { fitWidthZoom } from '../view/layout';
import { APP_VERSION } from '../version';
import { passwordPrompt } from './passwordRequest';
import { installLaunchInbox, type LaunchFileHandleLike, type LaunchQueueLike } from '../pwa/launch';
import type { RpcEvent } from '../rpc/generated';

// The first-page previews are kept in a fake store that records each prune (issue 757). The real
// renderer still runs, so a preview is made and sent to the fake store's (empty) load and save.
const thumbPrunes = vi.hoisted(() => [] as string[][]);
vi.mock('../recent/recentThumbs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createRecentThumbs: () => ({
    save: async () => false,
    load: async () => new Map(),
    prune: async (names: readonly string[]) => {
      thumbPrunes.push([...names]);
    },
    remove: async () => undefined,
  }),
}));

// The autosave copies go to a fake store, which records the document each delete names (W4.8 S1).
const autosaveRemoved = vi.hoisted(() => [] as number[]);
vi.mock('../storage/autosaveStore', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createAutosaveStore: () => ({
    available: async () => true,
    write: async () => 'written' as const,
    read: async () => undefined,
    remove: async (_tabId: string, docId: number) => {
      autosaveRemoved.push(docId);
    },
    removeTab: async () => undefined,
  }),
}));

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
        pdf_version: '1.7',
        is_tagged: false,
        has_forms: false,
        has_javascript: false,
        is_repaired: false,
        has_xmp: false,
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
  thumbPrunes.length = 0;
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

// Closes the document tab whose name contains the text: the close mark is pointer-only (W8.5 S8).
function closeTab(name: string): void {
  const tab = [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((el) =>
    el.textContent?.includes(name),
  );
  const mark = tab?.querySelector<HTMLElement>('.doc-tab-close');
  if (mark === undefined || mark === null) throw new Error(`no tab ${name}`);
  mark.click();
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

function openCalls(): Recorded[] {
  return calls.filter((call) => call.method === 'session.open');
}

describe('start page', () => {
  it('shows the start page when no document tab is open', () => {
    expect(host.querySelector('.start-page')).not.toBeNull();
    expect(host.querySelector('.doc-tabs [role="tablist"]')).toBeNull();
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

  // Renders the app with an engine that is still loading, and a client that answers once it is
  // ready (setClient on the returned engine).
  function renderLoading(): { engine: FakeEngine; queued: ReturnType<typeof engineClient> } {
    const queued = engineClient();
    const loading = fakeEngine();
    act(() => {
      root.render(<App engine={loading} />);
    });
    return { engine: loading, queued };
  }

  it('queues files picked during the load, shows them, and opens them once the engine is ready', async () => {
    const { engine: loading, queued } = renderLoading();
    const first = pdf('report.pdf');
    const readFirst = vi.spyOn(first, 'arrayBuffer');
    dropFiles([first, pdf('second.pdf')]);
    expect(readFirst).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.start-pending')?.textContent).toContain(t('start.pending.heading'));
    expect(host.querySelectorAll('.start-pending-list li')).toHaveLength(2);
    expect(queued.calls.filter((call) => call.method === 'session.open')).toEqual([]);
    expect(tabNames()).toEqual([]);

    act(() => {
      loading.setClient(queued.client);
    });
    await until(() => tabNames().length === 2);
    expect(tabNames()).toEqual(['report.pdf', 'second.pdf']);
    const opened = queued.calls.filter((call) => call.method === 'session.open');
    expect(opened.map((call) => call.params['name'])).toEqual(['report.pdf', 'second.pdf']);
    expect(host.querySelector('.start-pending')).toBeNull();
  });

  it("drops a waiting file when its Don't open button is pressed", async () => {
    const { engine: loading, queued } = renderLoading();
    dropFiles([pdf('report.pdf'), pdf('second.pdf')]);
    act(() => {
      buttonNamed(t('start.pending.cancelLabel', { name: 'report.pdf' })).click();
    });
    expect(host.querySelectorAll('.start-pending-list li')).toHaveLength(1);
    act(() => {
      loading.setClient(queued.client);
    });
    await until(() => tabNames().length === 1);
    expect(tabNames()).toEqual(['second.pdf']);
  });

  it('asks for the password of a queued file after the engine is ready', async () => {
    const { engine: loading, queued } = renderLoading();
    dropFiles([pdf('locked.pdf')]);
    act(() => {
      loading.setClient(queued.client);
    });
    await until(() => passwordInput() !== null);
    typePassword('secret');
    submitPassword();
    await until(() => tabNames().length === 1);
    expect(tabNames()).toEqual(['locked.pdf']);
    const opened = queued.calls.filter((call) => call.method === 'session.open');
    expect(opened.map((call) => call.params['password'])).toEqual([null, 'secret']);
  });

  it('keeps opening the queue when one file fails after its open, and reports that file', async () => {
    const { engine: loading, queued } = renderLoading();
    const real = queued.client as unknown as {
      call: (method: string, params: Record<string, unknown>) => Promise<unknown>;
    };
    // The reply for broken.pdf throws while the app reads it, after the engine has opened the file
    // (here at the pages field), so the failure comes after the open, not in it.
    const client = {
      call: (method: string, params: Record<string, unknown>) => {
        if (method === 'session.open' && params['name'] === 'broken.pdf') {
          return Promise.resolve({
            handle: 'doc-broken',
            get pages(): number {
              throw new Error('boom');
            },
            warning: null,
          });
        }
        return real.call(method, params);
      },
    } as unknown as EngineClient;
    dropFiles([pdf('broken.pdf'), pdf('good.pdf')]);
    act(() => {
      loading.setClient(client);
    });
    await until(() => tabNames().length === 1 && errorToasts().length === 1);
    expect(tabNames()).toEqual(['good.pdf']);
    expect(errorToasts()).toHaveLength(1);
    expect(host.querySelector('.start-pending')).toBeNull();
  });

  it('refuses a non-PDF and a too-large file at once, without queueing them', () => {
    renderLoading();
    const big = pdf('big.pdf');
    Object.defineProperty(big, 'size', { value: 1024 ** 3 + 1 });
    dropFiles([new File(['hello'], 'notes.txt', { type: 'text/plain' }), big]);
    expect(errorToasts()).toHaveLength(2);
    expect(host.querySelectorAll('.start-pending-list li')).toHaveLength(0);
  });

  it('does not read a file over the read-ahead limit before the engine is ready', () => {
    renderLoading();
    const large = pdf('large.pdf');
    Object.defineProperty(large, 'size', { value: 256 * 1024 * 1024 + 1 });
    const read = vi.spyOn(large, 'arrayBuffer');
    dropFiles([large]);
    expect(read).not.toHaveBeenCalled();
    expect(host.querySelectorAll('.start-pending-list li')).toHaveLength(1);
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
      closeTab('first.pdf');
    });
    dropFiles([pdf('second.pdf')]);
    await until(() => tabNames().length === 1);
    act(() => {
      closeTab('second.pdf');
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

  it('keeps the hint and does not click the input when the picker is refused after a permission prompt', async () => {
    // Chromium picker refused with SecurityError: the user's gesture expired during the prompt.
    const delay = () => new Promise((resolve) => setTimeout(resolve, 5));
    const refused = vi.fn(async () => {
      await delay();
      throw new DOMException('no gesture', 'SecurityError');
    });
    Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: refused });
    try {
      const handle = {
        kind: 'file',
        name: 'first.pdf',
        getFile: async () => pdf('first.pdf'),
        requestPermission: async () => {
          await delay();
          return 'denied';
        },
      };
      const zone = host.querySelector<HTMLElement>('.start-drop');
      const event = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', {
        value: {
          files: [pdf('first.pdf')],
          items: [{ kind: 'file', getAsFileSystemHandle: async () => handle }],
        },
      });
      act(() => {
        zone?.dispatchEvent(event);
      });
      await until(() => tabNames().length === 1);
      act(() => {
        closeTab('first.pdf');
      });

      const clicked = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
      act(() => {
        buttonNamed('first.pdf').click();
      });
      await until(() => refused.mock.calls.length === 1);
      await until(() => host.querySelector('.start-hint') !== null);
      await delay();
      expect(refused).toHaveBeenCalledTimes(1);
      expect(clicked).not.toHaveBeenCalled();
      expect(host.querySelector('.start-hint')?.textContent).toBe(
        t('start.recent.pickAgain', { name: 'first.pdf' }),
      );
    } finally {
      Reflect.deleteProperty(window, 'showOpenFilePicker');
    }
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
      closeTab('b.pdf');
    });
    expect(tabNames()).toEqual(['a.pdf']);
    expect(calls.filter((call) => call.method === 'session.close')).toEqual([
      { method: 'session.close', params: { handle: 'doc-2' } },
    ]);
    act(() => {
      closeTab('a.pdf');
    });
    expect(host.querySelector('.doc-tabs [role="tablist"]')).toBeNull();
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

  it('marks the open of a document once it is opened (W8.3)', async () => {
    const mark = vi.spyOn(performance, 'mark').mockImplementation(() => ({}) as PerformanceMark);
    dropFiles([pdf('marked.pdf')]);
    await until(() => tabNames().length === 1);
    expect(mark).toHaveBeenCalledWith('elanero:load:open');
    mark.mockRestore();
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
      closeTab('b.pdf');
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
    // The view and the Pages panel, which is open by default (W4.2a S1), each ask once. The
    // first-page preview of the recent file (issue 757) asks once more, when the browser is idle
    // (a timer here, which the wait below lets run), so the count is exactly three.
    await until(() => calls.filter((call) => call.method === 'session.pages').length === 3);
    const pagesCalls = calls.filter((call) => call.method === 'session.pages');
    expect(pagesCalls).toHaveLength(3);
    expect(pagesCalls.slice(0, 2)).toEqual([
      { method: 'session.pages', params: { handle: 'doc-1' } },
      { method: 'session.pages', params: { handle: 'doc-1' } },
    ]);
  });

  it('prunes the previews to the recent list when a file opens', async () => {
    dropFiles([pdf('a.pdf')]);
    await until(() => thumbPrunes.length > 0);
    expect(thumbPrunes.at(-1)).toEqual(['a.pdf']);
  });

  it('shows only the document view when a document is open, with no footer or About text', async () => {
    expect(host.querySelector('.start-footer')?.textContent).toContain(t('about.title'));
    dropFiles([pdf('a.pdf')]);
    await until(() => host.querySelector('.doc-page') !== null);
    expect(host.querySelector('.doc-view')).not.toBeNull();
    expect(host.querySelector('h1')).toBeNull();
    expect(host.querySelector('.start-footer')).toBeNull();
    expect(host.textContent).not.toContain(t('about.title'));
    expect(host.textContent).not.toContain(t('app.version', { version: APP_VERSION }));
  });

  it('shows the page as 1 of N in the canvas pill at the start', async () => {
    dropFiles([pdf('a.pdf')]);
    await until(() => host.querySelector('.doc-page') !== null);
    expect(host.querySelector<HTMLInputElement>('.canvas-pill-jump input')?.value).toBe('1');
    expect(host.querySelector('.canvas-pill-total')?.textContent).toBe(
      t('pill.pageCount', { total: 3 }),
    );
    // The saved default zoom is Fit width: the pages (612 pt wide) fill the window.
    const percent = Math.round(fitWidthZoom(612, window.innerWidth) * 100);
    expect(host.querySelector('.doc-status-zoom')?.textContent).toBe(
      t('view.zoomPercent', { percent }),
    );
  });

  it('updates the canvas pill page when the view scrolls to another page', async () => {
    dropFiles([pdf('a.pdf')]);
    await until(() => host.querySelector('.doc-page') !== null);
    const scroller = host.querySelector<HTMLElement>('.doc-view-scroll');
    if (scroller === null) throw new Error('no scroll area');
    // Each page is 1056 CSS px tall with the gaps; this offset puts page 2 at the viewport's centre.
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 1100 });
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(host.querySelector<HTMLInputElement>('.canvas-pill-jump input')?.value).toBe('2');
  });

  it('keeps the About button in the start page footer and no status bar there', () => {
    expect(host.querySelector('h1')?.textContent).toBe(t('app.name'));
    const footer = host.querySelector('.start-footer');
    expect(footer?.textContent).toContain(t('about.title'));
    expect(footer?.textContent).toContain(t('start.footer.version', { version: APP_VERSION }));
    expect(host.querySelector('.doc-status')).toBeNull();
  });

  it('moves between tabs with the arrow keys', async () => {
    dropFiles([pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')]);
    await until(() => tabNames().length === 3);
    const tabs = [...host.querySelectorAll<HTMLElement>('.doc-tabs [role="tab"]')];
    expect(tabs[2]?.getAttribute('aria-selected')).toBe('true');
    act(() => {
      tabs[2]?.focus();
    });
    act(() => {
      tabs[2]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(
      host
        .querySelectorAll<HTMLElement>('.doc-tabs [role="tab"]')[1]
        ?.getAttribute('aria-selected'),
    ).toBe('true');
  });
});

describe('files handed over by the OS (W4.6 S1)', () => {
  // A launch as the browser builds it: handles whose getFile() returns the File.
  function launchOf(files: File[]): LaunchFileHandleLike[] {
    return files.map((file) => ({ kind: 'file', name: file.name, getFile: async () => file }));
  }

  // Renders the app with a launch inbox whose consumer the test calls with a launch.
  function renderWithLaunches(): { launch(files: File[]): void } {
    let consumer: ((params: { files: LaunchFileHandleLike[] }) => void) | null = null;
    const queue: LaunchQueueLike = {
      setConsumer: (next) => {
        consumer = next;
      },
    };
    const inbox = installLaunchInbox(queue, { failed: () => undefined, tooMany: () => undefined });
    act(() => {
      root.render(<App engine={engine} launches={inbox} />);
    });
    return {
      launch(files) {
        consumer?.({ files: launchOf(files) });
      },
    };
  }

  it('opens a launched PDF through session.open, as the Open button does', async () => {
    const { launch } = renderWithLaunches();
    launch([pdf('opened-from-os.pdf')]);
    await until(() => tabNames().length === 1);
    expect(tabNames()).toEqual(['opened-from-os.pdf']);
    expect(openCalls()[0]?.params).toMatchObject({ name: 'opened-from-os.pdf', password: null });
  });

  it('gives a launched .txt the not-a-PDF toast and opens no tab', async () => {
    const { launch } = renderWithLaunches();
    launch([new File(['hello'], 'notes.txt', { type: 'text/plain' })]);
    await until(() => errorToasts().length > 0);
    expect(tabNames()).toEqual([]);
    expect(calls).toEqual([]);
    expect(errorToasts()).toEqual([t('open.notPdf', { name: 'notes.txt' })]);
  });

  it('refuses a launched file over the size limit before any read', async () => {
    const { launch } = renderWithLaunches();
    const huge = pdf('huge.pdf');
    Object.defineProperty(huge, 'size', { value: 1024 * 1024 * 1024 + 1 });
    const read = vi.spyOn(huge, 'arrayBuffer');
    launch([huge]);
    await until(() => errorToasts().length > 0);
    expect(errorToasts()).toHaveLength(1);
    expect(read).not.toHaveBeenCalled();
    expect(tabNames()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('queues a launch made while the engine loads, under "Waiting to open"', async () => {
    const slot: { consumer?: (params: { files: LaunchFileHandleLike[] }) => void } = {};
    const inbox = installLaunchInbox(
      {
        setConsumer: (next) => {
          slot.consumer = next;
        },
      },
      { failed: () => undefined, tooMany: () => undefined },
    );
    act(() => {
      root.render(<App engine={fakeEngine()} launches={inbox} />);
    });
    slot.consumer?.({ files: launchOf([pdf('waiting.pdf')]) });
    await until(() => host.querySelector('.start-pending') !== null);
    expect(host.querySelector('.start-pending')?.textContent).toContain(t('start.pending.heading'));
    expect(host.querySelector('.start-pending')?.textContent).toContain('waiting.pdf');
  });
});

// The state event of a document, as the engine sends it after a call that changed it.
function stateEvent(handle: string, dirty: boolean): RpcEvent {
  return {
    kind: 'state',
    handle,
    state: {
      page_count: 3,
      structure_version: 1,
      dirty,
      busy: '',
      can_undo: dirty,
      can_redo: false,
      undo_label: '',
      redo_label: '',
      require_full_save: false,
      history: dirty ? 1 : 0,
    },
  };
}

// Dispatches beforeunload and reports whether a listener asked for the warning.
function unloadWarns(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

function dirtyTabName(): string | null {
  return (
    host.querySelector('.doc-tab-dirty')?.closest('[role="tab"]')?.querySelector('.doc-tab-name')
      ?.textContent ?? null
  );
}

describe('engine state events (W4.8 S1)', () => {
  it('shows the unsaved-changes dot on the tab the engine reports dirty, and warns on unload', async () => {
    dropFiles([pdf('a.pdf'), pdf('b.pdf')]);
    await until(() => tabNames().length === 2);
    expect(dirtyTabName()).toBeNull();
    expect(unloadWarns()).toBe(false);

    act(() => {
      engine.emit([stateEvent('doc-2', true)]);
    });

    expect(dirtyTabName()).toBe('b.pdf');
    expect(unloadWarns()).toBe(true);
  });

  it('clears the dot and the unload warning when the engine reports the document clean', async () => {
    dropFiles([pdf('a.pdf')]);
    await until(() => tabNames().length === 1);
    act(() => {
      engine.emit([stateEvent('doc-1', true)]);
    });

    act(() => {
      engine.emit([stateEvent('doc-1', false)]);
    });

    expect(dirtyTabName()).toBeNull();
    expect(unloadWarns()).toBe(false);
  });

  it('ignores a state for a handle no tab holds', async () => {
    dropFiles([pdf('a.pdf')]);
    await until(() => tabNames().length === 1);

    act(() => {
      engine.emit([stateEvent('doc-9', true)]);
    });

    expect(dirtyTabName()).toBeNull();
    expect(unloadWarns()).toBe(false);
  });

  it('deletes the autosave copy of a document that the engine reports clean again', async () => {
    autosaveRemoved.length = 0;
    dropFiles([pdf('a.pdf')]);
    await until(() => tabNames().length === 1);
    act(() => {
      engine.emit([stateEvent('doc-1', true)]);
    });
    act(() => {
      engine.emit([stateEvent('doc-1', false)]);
    });

    await until(() => autosaveRemoved.length > 0);
    expect(autosaveRemoved).toEqual([1]);
  });
});
