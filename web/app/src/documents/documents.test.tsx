import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { toasts } from '../feedback/toasts';
import { t } from '../i18n/t';
import { RECENT_STORAGE_KEY } from '../recent/recentFiles';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a collection takes focus.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) },
  });
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root.render(<App />);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  act(() => {
    root.unmount();
  });
  host.remove();
  window.localStorage.clear();
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

function buttonNamed(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === text || button.getAttribute('aria-label') === text,
  );
  if (found === undefined) throw new Error(`no button ${text}`);
  return found;
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

  it('adds a tab for a dropped PDF', () => {
    dropFiles([pdf('report.pdf')]);
    expect(tabNames()).toEqual(['report.pdf']);
    expect(host.querySelector('.start-page')).toBeNull();
  });

  it('shows an error toast for a dropped file that is not a PDF, and opens no tab', () => {
    dropFiles([new File(['hello'], 'notes.txt', { type: 'text/plain' })]);
    expect(tabNames()).toEqual([]);
    expect(errorToasts()).toEqual([t('open.notPdf', { name: 'notes.txt' })]);
  });

  it('accepts a PDF by its name when the browser gives no type', () => {
    dropFiles([new File(['%PDF'], 'scan.PDF')]);
    expect(tabNames()).toEqual(['scan.PDF']);
  });

  it('tells the user the engine is not connected yet, and keeps the file in its tab', () => {
    dropFiles([pdf('report.pdf')]);
    const infos = toasts
      .getState()
      .visible.filter((toast) => toast.kind === 'info')
      .map((toast) => toast.text);
    expect(infos).toEqual([t('open.engineNotConnected', { name: 'report.pdf' })]);
  });

  it('lists the recent files newest first, and a click asks for the file again', () => {
    dropFiles([pdf('first.pdf')]);
    act(() => {
      buttonNamed(t('tabs.close', { name: 'first.pdf' })).click();
    });
    dropFiles([pdf('second.pdf')]);
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

  it('keeps only names and times in storage, never the file content', () => {
    dropFiles([pdf('contract.pdf', '%PDF-1.7 SECRET-PAGE-TEXT')]);
    const stored = window.localStorage.getItem(RECENT_STORAGE_KEY) ?? '';
    expect(stored).toContain('contract.pdf');
    expect(stored).not.toContain('SECRET-PAGE-TEXT');
    expect(stored).not.toContain('%PDF');
    const entries: unknown[] = JSON.parse(stored);
    expect(Object.keys(entries[0] as object).sort()).toEqual(['name', 'openedAt']);
  });
});

describe('document tabs', () => {
  it('closes a tab and brings the start page back when none are left', () => {
    dropFiles([pdf('a.pdf'), pdf('b.pdf')]);
    expect(tabNames()).toEqual(['a.pdf', 'b.pdf']);
    act(() => {
      buttonNamed(t('tabs.close', { name: 'b.pdf' })).click();
    });
    expect(tabNames()).toEqual(['a.pdf']);
    act(() => {
      buttonNamed(t('tabs.close', { name: 'a.pdf' })).click();
    });
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    expect(host.querySelector('.start-page')).not.toBeNull();
  });

  it('moves between tabs with the arrow keys', () => {
    dropFiles([pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')]);
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
