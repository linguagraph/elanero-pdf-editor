import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t';
import { DocumentStatusBar, type DocumentStatusBarProps } from './DocumentStatusBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

function props(overrides: Partial<DocumentStatusBarProps> = {}): DocumentStatusBarProps {
  return {
    page: 1,
    total: 3,
    labels: [],
    zoom: 1,
    fit: null,
    onGoTo: vi.fn(),
    onStep: vi.fn(),
    onZoom: vi.fn(),
    onZoomStep: vi.fn(),
    ...overrides,
  };
}

function render(value: DocumentStatusBarProps): void {
  act(() => {
    root.render(<DocumentStatusBar {...value} />);
  });
}

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

describe('DocumentStatusBar (#808 slice 1)', () => {
  it('holds the page and zoom controls in one toolbar, in the desktop order', () => {
    render(props());
    const names = [
      ...host.querySelectorAll<HTMLElement>(
        '.doc-status-controls button, .doc-status-controls input',
      ),
    ].map((el) => el.getAttribute('aria-label') ?? el.textContent ?? '');
    expect(names).toEqual([
      t('pill.previousPage'),
      t('view.goToPage'),
      t('pill.nextPage'),
      t('view.zoomOut'),
      t('pill.zoom'),
      t('pill.zoomPresets'),
      t('view.zoomIn'),
      t('view.fitWidth'),
      t('view.fitPage'),
    ]);
    expect(host.querySelector('.doc-status-controls')?.getAttribute('role')).toBe('toolbar');
    expect(host.querySelectorAll('.doc-status-group')).toHaveLength(2);
  });

  it('has no Back, Forward or layout text: those moved to the ribbon', () => {
    render(props());
    const labels = [...host.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).not.toContain('Back');
    expect(labels).not.toContain('Forward');
    expect(host.querySelector('.doc-status-mode')).toBeNull();
    expect(host.querySelector('.doc-status-zoom')).toBeNull();
  });

  it('shows the page and the zoom in their fields', () => {
    render(props({ page: 2, zoom: 1.5 }));
    expect(host.querySelector<HTMLInputElement>('.doc-status-zoom-input')?.value).toBe('150%');
    expect(host.querySelector<HTMLInputElement>('.doc-status-jump input')?.value).toBe('2');
  });
});
