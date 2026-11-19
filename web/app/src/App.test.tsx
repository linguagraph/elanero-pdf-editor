import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import { APP_VERSION } from './version';
import { fakeEngine } from './engine/testEngine';

describe('App', () => {
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
