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
import { RedactionController } from './redaction/controller';
import type { MessageId } from './i18n/en';
import { TAB_LABELS } from './commands/registry';
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
// With `marks`, the engine lists one mark on every open document, so Apply Redactions is enabled.
function drawingEngine(options: { marks?: boolean; contentEdit?: boolean } = {}): {
  client: EngineClient;
  renders: () => number;
} {
  let opened = 0;
  let renders = 0;
  const call = vi.fn((method: string, params: Record<string, unknown>) => {
    if (method === 'session.close') return Promise.resolve({});
    if (method === 'redaction.list') {
      const marks = options.marks
        ? [
            {
              page: 0,
              name: 'm1',
              rect: { x0: 10, y0: 10, x1: 80, y1: 40 },
              fill: null,
              overlay_text: '',
              text_color: null,
              contents: '',
              author: '',
              locked: false,
            },
          ]
        : [];
      return Promise.resolve({ marks, truncated: false });
    }
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
    // The open reads the engine's content_edit flag (W6.7a); the Edit tool's commands follow it.
    if (method === 'session.capabilities') {
      return Promise.resolve({
        engine: { content_edit: options.contentEdit ?? true },
        platform: {},
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
        pdf_version: '1.7',
        is_tagged: false,
        has_forms: false,
        has_javascript: false,
        is_repaired: false,
        has_xmp: false,
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
    expect(leftPanels).toEqual([
      'pages',
      'bookmarks',
      'attachments',
      'layers',
      'redactions',
      'search',
      'comments',
    ]);
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

describe('App comment and redaction tools (W4.3a S7)', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    for (const id of [1, 2, 3]) setTabSession(id, null);
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
    document.body.innerHTML = '';
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  async function openDocument(marks = false, contentEdit = true): Promise<void> {
    const jobs = { acquire: vi.fn(), warm: vi.fn(), dispose: vi.fn() };
    act(() => {
      root.render(
        <App
          engine={fakeEngine(drawingEngine({ marks, contentEdit }).client)}
          jobs={jobs as unknown as JobWorkerPool}
        />,
      );
    });
    const zone = host.querySelector<HTMLElement>('.start-drop');
    if (zone === null) throw new Error('no drop zone');
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [pdf('report.pdf')] } });
    act(() => {
      zone.dispatchEvent(drop);
    });
    await until(() => host.querySelector('.doc-view-toolbar') !== null);
  }

  function ribbonButton(command: string): HTMLElement {
    const el = host.querySelector<HTMLElement>(`[data-command="${command}"]`);
    if (el === null) throw new Error(`no ribbon button for ${command}`);
    return el;
  }

  function selectTab(label: string): void {
    const tab = [...host.querySelectorAll<HTMLElement>('[role="tab"], .ribbon-tabs > button')].find(
      (el) => el.textContent?.trim() === label,
    );
    if (tab === undefined) throw new Error(`no tab ${label}`);
    act(() => {
      tab.click();
    });
  }

  function toolbarPressed(label: string): string | null | undefined {
    const found = [...host.querySelectorAll<HTMLButtonElement>('.doc-view-toolbar button')].find(
      (el) => el.textContent?.trim() === label,
    );
    return found?.getAttribute('aria-pressed');
  }

  it('has every toolbar button do its job in the open document', async () => {
    await openDocument();
    const click = (label: string) => {
      const found = [...host.querySelectorAll<HTMLButtonElement>('.doc-view-toolbar button')].find(
        (el) => el.textContent?.trim() === label,
      );
      if (found === undefined) throw new Error(`no toolbar button ${label}`);
      act(() => found.click());
    };
    click(t('view.layoutTwoPage'));
    expect(toolbarPressed(t('view.layoutTwoPage'))).toBe('true');
    click(t('view.night'));
    expect(toolbarPressed(t('view.night'))).toBe('true');
    for (const key of ['comment.tool.note', 'comment.tool.rectangle', 'comment.tool.highlight']) {
      click(t(key as Parameters<typeof t>[0]));
      expect(toolbarPressed(t(key as Parameters<typeof t>[0]))).toBe('true');
    }
    click(t('redact.mark'));
    expect(toolbarPressed(t('redact.mark'))).toBe('true');
    expect(toolbarPressed(t('comment.tool.highlight'))).toBe('false');
  });

  it('drops the main region padding while a document is shown, so the view has no thick frame', async () => {
    await openDocument();
    expect(host.querySelector('.app-main')?.classList.contains('app-main--document')).toBe(true);
  });

  it('Note turns the comment tool on in the open document, and a second press turns it off', async () => {
    await openDocument();
    selectTab(t('ribbon.tab.comment'));
    act(() => {
      ribbonButton('sticky-note').click();
    });
    expect(ribbonButton('sticky-note').getAttribute('aria-pressed')).toBe('true');
    expect(toolbarPressed(t('comment.tool.note'))).toBe('true');

    act(() => {
      ribbonButton('sticky-note').click();
    });
    expect(ribbonButton('sticky-note').getAttribute('aria-pressed')).toBe('false');
    expect(toolbarPressed(t('comment.tool.note'))).toBe('false');
  });

  it('Edit Text & Images is off with its reason when the engine lacks content_edit', async () => {
    await openDocument(false, false);
    selectTab(t('ribbon.tab.edit'));
    const edit = ribbonButton('edit-text-images');
    expect(edit.getAttribute('aria-disabled')).toBe('true');
    const described = (edit.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(described).toContain(t('disabled.contentEditOff'));
    act(() => {
      edit.click();
    });
    expect(ribbonButton('edit-text-images').getAttribute('aria-pressed')).not.toBe('true');
  });

  it('Edit Text & Images is enabled when the engine has content_edit, and turns the tool on', async () => {
    await openDocument();
    selectTab(t('ribbon.tab.edit'));
    expect(ribbonButton('edit-text-images').getAttribute('aria-disabled')).toBeNull();
    act(() => {
      ribbonButton('edit-text-images').click();
    });
    expect(ribbonButton('edit-text-images').getAttribute('aria-pressed')).toBe('true');
  });

  it('Redact turns the mark tool on, the same as the toolbar Mark button', async () => {
    await openDocument();
    selectTab(t('ribbon.tab.protect'));
    act(() => {
      ribbonButton('redact').click();
    });
    expect(ribbonButton('redact').getAttribute('aria-pressed')).toBe('true');
    expect(toolbarPressed(t('redact.mark'))).toBe('true');
  });

  it('Apply Redactions is disabled with no marks, with its reason, and opens no confirmation', async () => {
    await openDocument();
    selectTab(t('ribbon.tab.protect'));
    const apply = ribbonButton('apply-redactions');
    expect(apply.getAttribute('aria-disabled')).toBe('true');
    const described = (apply.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(described).toContain(t('disabled.noRedactionMarks'));
    act(() => {
      apply.click();
    });
    expect(document.querySelector('.redact-confirm')).toBeNull();
  });

  // The engine lists one mark (drawingEngine({ marks: true })), so the list loads and Apply is on.
  async function waitForApplyEnabled(): Promise<void> {
    await until(() => ribbonButton('apply-redactions').getAttribute('aria-disabled') !== 'true');
    expect(ribbonButton('apply-redactions').getAttribute('aria-disabled')).not.toBe('true');
  }

  function clickButton(text: string): void {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (el) => el.textContent?.trim() === text,
    );
    if (button === undefined) throw new Error(`no button ${text}`);
    act(() => {
      button.click();
    });
  }

  function tabLabels(): string[] {
    return [...host.querySelectorAll<HTMLElement>('.doc-tabs-list [role="tab"]')].map(
      (tab) => tab.textContent ?? '',
    );
  }

  async function openSecondDocument(): Promise<void> {
    const input = host.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error('no open input');
    Object.defineProperty(input, 'files', { value: [pdf('second.pdf')], configurable: true });
    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await until(() => tabLabels().length === 2);
    expect(tabLabels()).toHaveLength(2);
  }

  it('with marks, Apply Redactions opens the confirmation and does not apply yet', async () => {
    const apply = vi.spyOn(RedactionController.prototype, 'apply').mockResolvedValue(undefined);
    await openDocument(true);
    selectTab(t('ribbon.tab.protect'));
    await waitForApplyEnabled();
    act(() => {
      ribbonButton('apply-redactions').click();
    });
    expect(document.querySelector('.redact-confirm')).not.toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });

  it('Cancel in the confirmation closes it and does not apply', async () => {
    const apply = vi.spyOn(RedactionController.prototype, 'apply').mockResolvedValue(undefined);
    await openDocument(true);
    selectTab(t('ribbon.tab.protect'));
    await waitForApplyEnabled();
    act(() => {
      ribbonButton('apply-redactions').click();
    });
    clickButton(t('redact.confirm.cancel'));
    await until(() => document.querySelector('.redact-confirm') === null);
    expect(document.querySelector('.redact-confirm')).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });

  it('Confirm in the confirmation applies the marks exactly once', async () => {
    const apply = vi.spyOn(RedactionController.prototype, 'apply').mockResolvedValue(undefined);
    await openDocument(true);
    selectTab(t('ribbon.tab.protect'));
    await waitForApplyEnabled();
    act(() => {
      ribbonButton('apply-redactions').click();
    });
    clickButton(t('redact.confirm.apply'));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(null);
  });

  it('switching tabs while the confirmation is open closes it and applies nothing', async () => {
    const apply = vi.spyOn(RedactionController.prototype, 'apply').mockResolvedValue(undefined);
    await openDocument(true);
    await openSecondDocument();
    selectTab(t('ribbon.tab.protect'));
    await waitForApplyEnabled();
    act(() => {
      ribbonButton('apply-redactions').click();
    });
    expect(document.querySelector('.redact-confirm')).not.toBeNull();

    const first = [...host.querySelectorAll<HTMLElement>('.doc-tabs-list [role="tab"]')].find(
      (tab) => (tab.textContent ?? '').includes('report.pdf'),
    );
    if (first === undefined) throw new Error('no first tab');
    act(() => {
      first.click();
    });
    await until(() => document.querySelector('.redact-confirm') === null);
    expect(document.querySelector('.redact-confirm')).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('App: Organize Pages and the view toggles (W4.3a S6)', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    for (const id of [1, 2, 3]) setTabSession(id, null);
    closePanel('left');
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

  // Opens a one-page document through the start page's drop zone, as the user does.
  async function openDocument(): Promise<void> {
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
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [pdf('ribbon.pdf')] } });
    act(() => {
      zone.dispatchEvent(drop);
    });
    await until(() => scripted.renders() > 0);
  }

  // The ribbon tab with the given caption, opened (its panel shows the commands of that tab).
  function openRibbonTab(caption: MessageId): void {
    const tab = [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (element) => element.textContent === t(caption),
    );
    if (tab === undefined) throw new Error(`no ribbon tab ${caption}`);
    act(() => {
      tab.click();
    });
  }

  function ribbonButton(command: string): HTMLElement {
    const el = host.querySelector<HTMLElement>(`[data-command="${command}"]`);
    if (el === null) throw new Error(`no ribbon button for ${command}`);
    return el;
  }

  it('Organize Pages from the ribbon opens the organizer panel on the right', async () => {
    await openDocument();
    expect(host.querySelector('#app-panel-right')).toBeNull();

    openRibbonTab(TAB_LABELS.organize);
    act(() => {
      ribbonButton('organize-pages').click();
    });

    expect(host.querySelector('[data-panel="organizer"]')?.getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(host.querySelector('#app-panel-right')?.textContent).toContain(t('organizer.title'));
  });

  it('marks the layout the view changed to as pressed on the ribbon', async () => {
    await openDocument();
    openRibbonTab(TAB_LABELS.view);
    expect(ribbonButton('single-page-continuous').getAttribute('aria-pressed')).toBe('true');

    act(() => {
      ribbonButton('two-up-continuous').click();
    });
    await until(() => ribbonButton('two-up-continuous').getAttribute('aria-pressed') === 'true');

    expect(ribbonButton('two-up-continuous').getAttribute('aria-pressed')).toBe('true');
    expect(ribbonButton('single-page-continuous').getAttribute('aria-pressed')).toBe('false');
  });

  it('turns Night Mode on and then off from the ribbon, one press at a time', async () => {
    await openDocument();
    openRibbonTab(TAB_LABELS.view);
    act(() => {
      ribbonButton('night-reading').click();
    });
    expect(ribbonButton('night-reading').getAttribute('aria-pressed')).toBe('true');
    act(() => {
      ribbonButton('night-reading').click();
    });
    expect(ribbonButton('night-reading').getAttribute('aria-pressed')).toBe('false');
  });
});
