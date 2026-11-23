// After a shortcut changes (here, or from another tab through a storage event), every place that
// shows the key shows the new one: the ribbon tooltips, the command buttons' description, the
// palette rows, the shortcut list and the Help button (W4.x, design section 9, error 3).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HelpButton } from '../ribbon/HelpButton';
import { CommandButton, Ribbon } from '../ribbon/Ribbon';
import { CommandPalette } from '../palette/CommandPalette';
import { openCommandPalette } from '../palette/openCommandPalette';
import { t } from '../i18n/t';
import { assign, BINDINGS_STORAGE_KEY, reset } from './bindings';
import { REGISTRY } from './catalog';
import { type CommandDef, type CommandState } from './registry';
import { type CommandHandlers } from './run';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a popover opens (as in palette.test.tsx).
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) },
  });
}

const STATE: CommandState = {
  hasDocument: true,
  hasRecentFiles: true,
  canUndo: true,
  canRedo: true,
  capabilities: new Set(),
  contentEdit: false,
  ribbonCompact: false,
  ribbonCollapsed: false,
  viewTool: 'select',
  commentTool: null,
  redacting: false,
  canApplyRedactions: false,
  canGoBack: false,
  canGoForward: false,
  view: null,
};

// Every command shown here has a handler, so its button is enabled and describes only its key.
const HANDLERS: CommandHandlers = {
  help: () => undefined,
  'go-to-page': () => undefined,
  'collapse-ribbon': () => undefined,
};

function def(id: string): CommandDef {
  const found = REGISTRY.get(id);
  if (found === undefined) throw new Error(`no command ${id}`);
  return found;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  act(() => {
    reset();
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
});

function render(node: React.ReactNode): void {
  act(() => {
    root.render(node);
  });
}

// The hidden text a command button is described by (its shortcut and, when disabled, its reason).
function describedText(el: HTMLElement): string {
  const ids = (el.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
}

function commandButton(id: string): HTMLElement {
  const el = host.querySelector<HTMLElement>(`[data-command="${id}"]`);
  if (el === null) throw new Error(`no command button for ${id}`);
  return el;
}

// Shows a tooltip the way a keyboard user does (focus with keyboard modality opens it at once),
// and returns its text. Each tooltip is read from the body, where react-aria portals it.
function tooltipOf(trigger: HTMLElement): string {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  });
  act(() => {
    trigger.focus();
  });
  const text = document.querySelector('[role="tooltip"]')?.textContent ?? '';
  act(() => {
    trigger.blur();
  });
  return text;
}

function helpButton(): HTMLElement {
  const el = host.querySelector<HTMLElement>('.ribbon-help');
  if (el === null) throw new Error('no Help button');
  return el;
}

function chevron(): HTMLElement {
  const el = host.querySelector<HTMLElement>('.ribbon-chevron');
  if (el === null) throw new Error('no collapse chevron');
  return el;
}

function openShortcutsPalette(): void {
  act(() => {
    openCommandPalette({ view: 'shortcuts' });
  });
}

function paletteShortcut(id: string): string | null | undefined {
  return document.querySelector(`[data-command="${id}"] .palette-shortcut`)?.textContent;
}

function shortcutKbds(): string[] {
  return [...document.querySelectorAll('kbd')].map((el) => el.textContent ?? '');
}

describe('shortcut changes reach every place that shows a key', () => {
  it('shows an assigned key in the Help button, command button, palette and shortcut list', () => {
    render(
      <>
        <HelpButton />
        <CommandButton
          def={def('help')}
          registry={REGISTRY}
          state={STATE}
          handlers={HANDLERS}
          compact={false}
        />
        <CommandPalette registry={REGISTRY} state={STATE} handlers={HANDLERS} />
      </>,
    );
    // Before the change the Help key is F1 (the shared table).
    expect(tooltipOf(helpButton())).toBe(t('ribbon.helpTip', { keys: 'F1' }));

    // The command list is open while the key changes, so its row must re-render on its own.
    act(() => {
      openCommandPalette();
    });
    expect(paletteShortcut('help')).toBe('F1');
    act(() => {
      assign('help', ['Ctrl+Alt+H']);
    });
    expect(paletteShortcut('help')).toBe('Ctrl+Alt+H');

    // Close the palette (Escape in its search box) and check the other places.
    act(() => {
      document
        .querySelector<HTMLElement>('.palette-input')
        ?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
    });
    expect(tooltipOf(helpButton())).toBe(t('ribbon.helpTip', { keys: 'Ctrl+Alt+H' }));
    expect(describedText(commandButton('help'))).toBe('Ctrl+Alt+H');

    openShortcutsPalette();
    expect(shortcutKbds()).toContain('Ctrl+Alt+H');
    expect(shortcutKbds()).not.toContain('F1');
  });

  it('re-renders an open shortcut list when a key changes while it is shown', () => {
    render(<CommandPalette registry={REGISTRY} state={STATE} handlers={HANDLERS} />);
    openShortcutsPalette();
    expect(shortcutKbds()).toContain('F1');

    act(() => {
      assign('help', ['Ctrl+Alt+H']);
    });

    expect(shortcutKbds()).toContain('Ctrl+Alt+H');
    expect(shortcutKbds()).not.toContain('F1');
  });

  it('re-renders an open command list when another tab changes the stored keys', () => {
    render(<CommandPalette registry={REGISTRY} state={STATE} handlers={HANDLERS} />);
    act(() => {
      openCommandPalette();
    });
    expect(paletteShortcut('help')).toBe('F1');

    act(() => {
      window.localStorage.setItem(
        BINDINGS_STORAGE_KEY,
        JSON.stringify({ version: 1, bindings: { help: ['Ctrl+Alt+H'] } }),
      );
      window.dispatchEvent(new StorageEvent('storage', { key: BINDINGS_STORAGE_KEY }));
    });

    expect(paletteShortcut('help')).toBe('Ctrl+Alt+H');
  });

  it('shows the new collapse key on the ribbon chevron and the Help button in the ribbon', () => {
    render(<Ribbon registry={REGISTRY} state={STATE} handlers={HANDLERS} />);
    act(() => {
      assign('collapse-ribbon', ['Ctrl+Alt+J']);
      assign('help', ['Ctrl+Alt+H']);
    });
    expect(tooltipOf(chevron())).toBe(t('ribbon.collapseTip', { keys: 'Ctrl+Alt+J' }));
    expect(tooltipOf(helpButton())).toBe(t('ribbon.helpTip', { keys: 'Ctrl+Alt+H' }));
  });

  it('shows Go to Page as Alt+G with no user keys, in the button and the palette', () => {
    render(
      <>
        <CommandButton
          def={def('go-to-page')}
          registry={REGISTRY}
          state={STATE}
          handlers={HANDLERS}
          compact={false}
        />
        <CommandPalette registry={REGISTRY} state={STATE} handlers={HANDLERS} />
      </>,
    );
    expect(window.localStorage.getItem(BINDINGS_STORAGE_KEY)).toBeNull();
    expect(describedText(commandButton('go-to-page'))).toBe('Alt+G');

    act(() => {
      openCommandPalette({ query: 'go to page' });
    });
    expect(paletteShortcut('go-to-page')).toBe('Alt+G');
  });

  it('updates every place when another tab changes the stored keys', () => {
    render(
      <>
        <Ribbon registry={REGISTRY} state={STATE} handlers={HANDLERS} />
        <CommandPalette registry={REGISTRY} state={STATE} handlers={HANDLERS} />
      </>,
    );
    expect(tooltipOf(helpButton())).toBe(t('ribbon.helpTip', { keys: 'F1' }));

    // Another tab writes the store, then fires the storage event this tab receives.
    act(() => {
      window.localStorage.setItem(
        BINDINGS_STORAGE_KEY,
        JSON.stringify({
          version: 1,
          bindings: { help: ['Ctrl+Alt+H'], 'collapse-ribbon': ['Ctrl+Alt+J'] },
        }),
      );
      window.dispatchEvent(new StorageEvent('storage', { key: BINDINGS_STORAGE_KEY }));
    });

    expect(tooltipOf(helpButton())).toBe(t('ribbon.helpTip', { keys: 'Ctrl+Alt+H' }));
    expect(tooltipOf(chevron())).toBe(t('ribbon.collapseTip', { keys: 'Ctrl+Alt+J' }));

    act(() => {
      openCommandPalette({ view: 'shortcuts' });
    });
    expect(shortcutKbds()).toContain('Ctrl+Alt+H');
  });
});
