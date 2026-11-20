import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REGISTRY } from '../commands/catalog';
import type { CommandState } from '../commands/registry';
import { commandDisabledReason } from '../commands/run';
import { t } from '../i18n/t';
import { ShortcutsDialog } from './ShortcutsDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) },
  });
}

const STATE: CommandState = {
  hasDocument: false,
  hasRecentFiles: false,
  canUndo: false,
  canRedo: false,
  capabilities: new Set(),
  ribbonCompact: false,
  ribbonCollapsed: false,
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
  document.body.innerHTML = '';
});

function render(onClose: () => void, isOpen = true): void {
  act(() => {
    root.render(
      <ShortcutsDialog isOpen={isOpen} onClose={onClose} registry={REGISTRY} state={STATE} />,
    );
  });
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

describe('ShortcutsDialog', () => {
  it('lists the bound shortcuts from the registry, with no Back button', () => {
    render(() => undefined);
    expect(dialog()?.textContent).toContain(t('palette.shortcutsList'));
    const kbd = [...document.querySelectorAll('kbd')].map((el) => el.textContent);
    // Close is overridden to Alt+W on the web, as in the palette list.
    expect(kbd).toContain('Alt+W');
    expect(document.querySelector('.palette-back')).toBeNull();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(onClose);
    act(() => {
      dialog()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders nothing while closed', () => {
    render(() => undefined, false);
    expect(dialog()).toBeNull();
  });
});

describe('the keyboard-shortcuts command', () => {
  it('is enabled once it has a handler, and reads not available yet without one', () => {
    const def = REGISTRY.get('keyboard-shortcuts');
    expect(def).toBeDefined();
    if (def === undefined) return;
    expect(commandDisabledReason(def, STATE, { 'keyboard-shortcuts': () => undefined })).toBeNull();
    expect(commandDisabledReason(def, STATE, {})).toBe('notAvailableYet');
  });
});
