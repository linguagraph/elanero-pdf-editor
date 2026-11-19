import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { APP_VERSION } from './version';
import { type EngineClient, setTabSession } from './engine/engineConnection';
import { fakeEngine } from './engine/testEngine';
import type { JobWorkerPool } from './engine/jobPool';
import { t } from './i18n/t';

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
