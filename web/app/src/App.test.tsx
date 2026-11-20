import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { APP_VERSION } from './version';
import { GUIDE_URL } from './help/guide';
import { type EngineClient, setTabSession } from './engine/engineConnection';
import { fakeEngine } from './engine/testEngine';
import type { JobWorkerPool } from './engine/jobPool';
import { t } from './i18n/t';
import { closePanel, openPanel } from './layout/sidePanels';

// jsdom has no CSS.escape, and react-aria calls it when a tab takes focus.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) },
  });
}

// An engine that opens every PDF and answers the first page render with pixels, so the first
// page is drawn and the scheduler's firstPage resolves. Other calls never answer.
function drawingEngine(): { client: EngineClient; renders: () => number } {
  let opened = 0;
  let renders = 0;
  const call = vi.fn((method: string, params: Record<string, unknown>) => {
    if (method === 'session.close') return Promise.resolve({});
    if (method === 'session.pages') {
      return Promise.resolve({ pages: [{ width: 612, height: 792, rotation: 0 }] });
    }
    if (method === 'render.page') {
      renders += 1;
      return Promise.resolve({
        width: 1,
        height: 1,
        revision: params['revision'],
        format: 'rgba',
        pixels: new ArrayBuffer(4),
      });
    }
    if (method !== 'session.open') return new Promise<never>(() => undefined);
    opened += 1;
    return Promise.resolve({
      handle: `doc-${opened}`,
      info: {
        encrypted: false,
        has_signatures: false,
        page_count: 1,
        title: '',
        author: '',
        subject: '',
        keywords: '',
        creator: '',
        producer: '',
        creation_date: '',
        mod_date: '',
      },
      pages: 1,
      warning: null,
      state: {},
    });
  });
  return { client: { call } as unknown as EngineClient, renders: () => renders };
}

function pdf(name: string): File {
  return new File(['%PDF-1.4 body'], name, { type: 'application/pdf' });
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

describe('App job worker warm-up', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    for (const id of [1, 2, 3]) setTabSession(id, null);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    window.localStorage.clear();
  });

  function dropFiles(files: File[]): void {
    const zone = host.querySelector<HTMLElement>('.start-drop');
    if (zone === null) throw new Error('no drop zone');
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { files } });
    act(() => {
      zone.dispatchEvent(event);
    });
  }

  function tabNames(): string[] {
    return [...host.querySelectorAll<HTMLElement>('[role="tab"]')].map(
      (tab) => tab.textContent?.trim() ?? '',
    );
  }

  it('warms the job worker exactly once after the first page is drawn, and not again for a second document', async () => {
    const scripted = drawingEngine();
    const jobs = { acquire: vi.fn(), warm: vi.fn(), dispose: vi.fn() };
    act(() => {
      root.render(
        <App engine={fakeEngine(scripted.client)} jobs={jobs as unknown as JobWorkerPool} />,
      );
    });
    expect(jobs.warm).not.toHaveBeenCalled();

    dropFiles([pdf('first.pdf')]);
    await until(() => scripted.renders() > 0);
    await until(() => jobs.warm.mock.calls.length > 0);
    expect(jobs.warm).toHaveBeenCalledTimes(1);

    act(() => {
      host
        .querySelector<HTMLButtonElement>(
          `button[aria-label="${t('tabs.close', { name: 'first.pdf' })}"]`,
        )
        ?.click();
    });
    dropFiles([pdf('second.pdf')]);
    await until(() => tabNames().some((name) => name.includes('second.pdf')));
    const rendersBefore = scripted.renders();
    await until(() => scripted.renders() > rendersBefore);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(jobs.warm).toHaveBeenCalledTimes(1);
  });

  it('warms the job worker after the first page is drawn when App runs under StrictMode', async () => {
    const scripted = drawingEngine();
    const jobs = { acquire: vi.fn(), warm: vi.fn(), dispose: vi.fn() };
    act(() => {
      root.render(
        <StrictMode>
          <App engine={fakeEngine(scripted.client)} jobs={jobs as unknown as JobWorkerPool} />
        </StrictMode>,
      );
    });
    dropFiles([pdf('strict.pdf')]);
    await until(() => scripted.renders() > 0);
    await until(() => jobs.warm.mock.calls.length > 0);
    expect(jobs.warm).toHaveBeenCalledTimes(1);
  });
});

describe('App', () => {
  it('does not warm the job worker before a document is shown, and disposes the pool on unmount', () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const jobs = { acquire: vi.fn(), warm: vi.fn(), dispose: vi.fn() };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() => {
        root.render(<App engine={fakeEngine()} jobs={jobs as unknown as JobWorkerPool} />);
      });
      expect(jobs.warm).not.toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
      host.remove();
    }
    expect(jobs.dispose).toHaveBeenCalled();
  });

  it('renders the app name and the version', () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() => {
        root.render(<App engine={fakeEngine()} />);
      });
      expect(host.querySelector('h1')?.textContent).toBe('Elanero');
      expect(host.textContent).toContain(APP_VERSION);
      expect(host.querySelector('a[rel="noopener noreferrer"]')).not.toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
      host.remove();
    }
  });

  it('mounts the ribbon under the logo bar, with the app menu button beside the logo', () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() => {
        root.render(<App engine={fakeEngine()} />);
      });
      const header = host.querySelector('.app-frame-header');
      expect(header?.querySelector('.app-header .app-menu-button')).not.toBeNull();
      const tabs = header?.querySelectorAll('.ribbon [role="tab"]') ?? [];
      expect(tabs).toHaveLength(7);
      // No document is open, so a document command is disabled with its reason.
      const save = header?.querySelector<HTMLElement>('[data-command="save"]');
      expect(save?.getAttribute('aria-disabled')).toBe('true');
    } finally {
      act(() => {
        root.unmount();
      });
      host.remove();
    }
  });
});

// Clear all reloads the page, so it must stay disabled while any tab is open, even when Open Recent
// has put the start page in front of that tab's unsaved work (W4.5 review finding).
describe('App: Clear all is disabled while a tab is open', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    for (const id of [1, 2, 3]) setTabSession(id, null);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    document.body.innerHTML = '';
    window.localStorage.clear();
  });

  function buttonIn(scope: ParentNode, label: string): HTMLButtonElement | undefined {
    return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === label,
    );
  }

  it('stays disabled after Open Recent shows the start page over an open tab', async () => {
    const scripted = drawingEngine();
    const jobs = { acquire: vi.fn(), warm: vi.fn(), dispose: vi.fn() };
    act(() => {
      root.render(
        <App engine={fakeEngine(scripted.client)} jobs={jobs as unknown as JobWorkerPool} />,
      );
    });
    const zone = host.querySelector<HTMLElement>('.start-drop');
    if (zone === null) throw new Error('no drop zone');
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [pdf('unsaved.pdf')] } });
    act(() => {
      zone.dispatchEvent(drop);
    });
    await until(() => scripted.renders() > 0);
    expect(scripted.renders()).toBeGreaterThan(0);

    // Open Recent from the app menu; the start page then shows next to the open tab.
    const menu = host.querySelector<HTMLButtonElement>(
      `button[aria-label="${t('appMenu.label')}"]`,
    );
    if (menu === undefined || menu === null) throw new Error('no app menu');
    act(() => {
      menu.click();
    });
    const openRecent = () =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (item) => item.textContent?.trim() === t('command.open-recent.label'),
      );
    await until(() => openRecent() !== undefined);
    const item = openRecent();
    if (item === undefined) throw new Error('no Open Recent item');
    act(() => {
      item.click();
    });
    await until(() => host.querySelector('.start-drop') !== null);
    expect(host.querySelector('.start-drop')).not.toBeNull();

    const preferences = buttonIn(host, t('command.preferences.label'));
    if (preferences === undefined) throw new Error('no preferences button');
    act(() => {
      preferences.click();
    });
    const clear = await vi.waitFor(() => {
      const found = buttonIn(document, t('prefs.clearAll.open'));
      if (found === undefined) throw new Error('no clear button');
      return found;
    });
    expect(clear.disabled).toBe(true);
  });
});

describe('App side rails (W4.2a S2)', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    for (const id of [1, 2, 3]) setTabSession(id, null);
    // The side-panel store is module state: each test starts with Pages open on the left only.
    closePanel('left');
    openPanel('pages');
    closePanel('right');
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    window.localStorage.clear();
  });

  function frame(): HTMLElement {
    const element = host.querySelector<HTMLElement>('.app-frame');
    if (element === null) throw new Error('no app frame');
    return element;
  }

  it('hides both rails on the start page', () => {
    act(() => {
      root.render(<App engine={fakeEngine()} />);
    });
    expect(frame().dataset.rails).toBe('hidden');
  });

  it('shows the navigation panels on the left and Organize on the right once a document opens, and Ctrl+F opens Search', async () => {
    const scripted = drawingEngine();
    const jobs = { acquire: vi.fn(), warm: vi.fn(), dispose: vi.fn() };
    act(() => {
      root.render(
        <App engine={fakeEngine(scripted.client)} jobs={jobs as unknown as JobWorkerPool} />,
      );
    });
    const zone = host.querySelector<HTMLElement>('.start-drop');
    if (zone === null) throw new Error('no drop zone');
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [pdf('rails.pdf')] } });
    act(() => {
      zone.dispatchEvent(drop);
    });
    await until(() => scripted.renders() > 0);
    expect(frame().dataset.rails).toBe('shown');

    const leftPanels = [...host.querySelectorAll<HTMLElement>('.app-rail-left [data-panel]')].map(
      (button) => button.dataset.panel,
    );
    expect(leftPanels).toEqual(['pages', 'bookmarks', 'search']);
    expect(
      [...host.querySelectorAll<HTMLElement>('.app-rail-right [data-panel]')].map(
        (button) => button.dataset.panel,
      ),
    ).toEqual(['organizer']);

    // Pages is open by default, and its button names the panel it controls.
    const pages = host.querySelector<HTMLElement>('[data-panel="pages"]');
    expect(pages?.getAttribute('aria-expanded')).toBe('true');
    expect(pages?.getAttribute('aria-controls')).toBe('app-panel-left');
    expect(host.querySelector('#app-panel-left')).not.toBeNull();

    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }),
      );
    });
    expect(host.querySelector('[data-panel="search"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('#app-panel-left')?.textContent).toContain(t('search.title'));
    expect(host.querySelector('[data-panel="pages"]')?.getAttribute('aria-expanded')).toBe('false');
  });

  // Opens a one-page document with Search already open on the left, so each Ctrl+F test starts from
  // the state it names.
  async function openDocument(searchOpen: boolean): Promise<void> {
    const scripted = drawingEngine();
    const jobs = { acquire: vi.fn(), warm: vi.fn(), dispose: vi.fn() };
    act(() => {
      root.render(
        <App engine={fakeEngine(scripted.client)} jobs={jobs as unknown as JobWorkerPool} />,
      );
    });
    const zone = host.querySelector<HTMLElement>('.start-drop');
    if (zone === null) throw new Error('no drop zone');
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [pdf('find.pdf')] } });
    act(() => {
      zone.dispatchEvent(drop);
    });
    await until(() => scripted.renders() > 0);
    if (searchOpen) {
      act(() => {
        openPanel('search');
      });
    }
  }

  function pressCtrlF(): void {
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }),
      );
    });
  }

  it('Ctrl+F moves focus to the Search input when the panel is already open', async () => {
    await openDocument(true);
    const input = host.querySelector<HTMLInputElement>('#app-panel-left input[type="search"]');
    if (input === null) throw new Error('no search input');
    // Focus elsewhere: on a rail button, outside the search box.
    const pages = host.querySelector<HTMLElement>('[data-panel="pages"]');
    pages?.focus();
    expect(document.activeElement).toBe(pages);

    pressCtrlF();
    expect(document.activeElement).toBe(input);
  });

  it('Ctrl+F opens the Search panel and focuses its input when the panel is closed', async () => {
    await openDocument(false);
    expect(host.querySelector('[data-panel="search"]')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
    const pages = host.querySelector<HTMLElement>('[data-panel="pages"]');
    pages?.focus();

    pressCtrlF();
    expect(host.querySelector('[data-panel="search"]')?.getAttribute('aria-expanded')).toBe('true');
    const input = host.querySelector<HTMLInputElement>('#app-panel-left input[type="search"]');
    expect(document.activeElement).toBe(input);
  });
});

describe('App help, about and quick access (W4.3a S4)', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    document.body.innerHTML = '';
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  function menuItem(label: string): HTMLElement | undefined {
    return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === label,
    );
  }

  async function openMenuItem(label: string): Promise<void> {
    const menu = host.querySelector<HTMLButtonElement>(
      `button[aria-label="${t('appMenu.label')}"]`,
    );
    if (menu === null) throw new Error('no app menu');
    act(() => {
      menu.click();
    });
    await until(() => menuItem(label) !== undefined);
    const item = menuItem(label);
    if (item === undefined) throw new Error(`no menu item ${label}`);
    act(() => {
      item.click();
    });
  }

  function renderApp(): void {
    const jobs = { acquire: vi.fn(), warm: vi.fn(), dispose: vi.fn() };
    act(() => {
      root.render(
        <App engine={fakeEngine(drawingEngine().client)} jobs={jobs as unknown as JobWorkerPool} />,
      );
    });
  }

  it('shows the quick-access buttons in the header, with Save disabled while no document is open', () => {
    renderApp();
    const save = host.querySelector<HTMLElement>('.app-header-start [data-command="save"]');
    expect(save).not.toBeNull();
    expect(save?.getAttribute('aria-disabled')).toBe('true');
  });

  it('opens the guide start from the app menu Help item', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    renderApp();
    await openMenuItem(t('command.help.label'));
    expect(open).toHaveBeenCalledWith(GUIDE_URL, '_blank', expect.any(String));
  });

  it('opens About Elanero as an overlay from the app menu', async () => {
    renderApp();
    await openMenuItem(t('command.about-elanero.label'));
    const dialog = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>('[role="dialog"]');
      if (found === null) throw new Error('no dialog');
      return found;
    });
    expect(dialog.textContent).toContain(APP_VERSION);
  });
});

// An engine that also answers the two save calls (W4.8): save_bytes returns a small file and
// mark_saved answers clean. Every call is recorded, so a test can read the order.
function savingEngine(): { client: EngineClient; calls: string[] } {
  const base = drawingEngine().client;
  const calls: string[] = [];
  const call = vi.fn((method: string, params: Record<string, unknown>) => {
    calls.push(method);
    if (method === 'save.save_bytes') {
      return Promise.resolve({
        data: new ArrayBuffer(8),
        size: 8,
        incremental: false,
        verified: true,
        name: 'report',
      });
    }
    if (method === 'save.mark_saved') return Promise.resolve({ saved: true, state: {} });
    return (base.call as unknown as (m: string, p: unknown) => Promise<unknown>)(method, params);
  });
  return { client: { call } as unknown as EngineClient, calls };
}

describe('App Save (W4.8 S2)', () => {
  let host: HTMLDivElement;
  let root: Root;
  let downloads: string[];

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    for (const id of [1, 2, 3]) setTabSession(id, null);
    closePanel('left');
    openPanel('pages');
    closePanel('right');
    // A download is an object URL clicked from an anchor: record the name it is given instead.
    downloads = [];
    URL.createObjectURL = vi.fn(() => 'blob:save-test');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push(this.download);
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    document.body.innerHTML = '';
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  async function openDocument(name: string, engine: EngineClient): Promise<void> {
    const jobs = { acquire: vi.fn(), warm: vi.fn(), dispose: vi.fn() };
    act(() => {
      root.render(<App engine={fakeEngine(engine)} jobs={jobs as unknown as JobWorkerPool} />);
    });
    const zone = host.querySelector<HTMLElement>('.start-drop');
    if (zone === null) throw new Error('no drop zone');
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [pdf(name)] } });
    act(() => {
      zone.dispatchEvent(drop);
    });
    await until(() => saveButton()?.getAttribute('aria-disabled') === null);
  }

  function saveButton(): HTMLElement | null {
    return host.querySelector<HTMLElement>('.app-header-start [data-command="save"]');
  }

  it('Save is enabled with a document open and downloads it under the document name, then marks it saved', async () => {
    const engine = savingEngine();
    await openDocument('report.pdf', engine.client);
    expect(saveButton()?.getAttribute('aria-disabled')).toBeNull();

    act(() => {
      saveButton()?.click();
    });
    await until(() => downloads.length > 0 && engine.calls.includes('save.mark_saved'));

    expect(downloads).toEqual(['report.pdf']);
    expect(engine.calls.filter((method) => method.startsWith('save.'))).toEqual([
      'save.save_bytes',
      'save.mark_saved',
    ]);
  });

  it('Ctrl+S saves the open document and stops the browser save dialog', async () => {
    const engine = savingEngine();
    await openDocument('report.pdf', engine.client);

    const event = new KeyboardEvent('keydown', {
      key: 's',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.body.dispatchEvent(event);
    });
    await until(() => downloads.length > 0);

    expect(event.defaultPrevented).toBe(true);
    expect(downloads).toEqual(['report.pdf']);
  });

  it('Ctrl+S with no document open does nothing, but still stops the browser save dialog', () => {
    const jobs = { acquire: vi.fn(), warm: vi.fn(), dispose: vi.fn() };
    act(() => {
      root.render(<App engine={fakeEngine()} jobs={jobs as unknown as JobWorkerPool} />);
    });
    const event = new KeyboardEvent('keydown', {
      key: 's',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.body.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(downloads).toEqual([]);
  });
});
