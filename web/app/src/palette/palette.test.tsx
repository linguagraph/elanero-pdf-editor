import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { REGISTRY } from '../commands/catalog';
import { type CommandState, TAB_LABELS } from '../commands/registry';
import { type CommandHandlers, runCommand } from '../commands/run';
import { t } from '../i18n/t';
import { CommandPalette } from './CommandPalette';
import { openCommandPalette } from './openCommandPalette';
import { RECENT_COMMANDS_KEY } from './recentCommands';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens (as in layout.test.tsx).
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) },
  });
}

const OPEN_STATE: CommandState = {
  hasDocument: true,
  hasRecentFiles: true,
  canUndo: true,
  canRedo: true,
  capabilities: new Set(),
  ribbonCompact: false,
  ribbonCollapsed: false,
  viewTool: 'select',
  commentTool: null,
  redacting: false,
  canApplyRedactions: false,
};

const NO_DOCUMENT_STATE: CommandState = { ...OPEN_STATE, hasDocument: false, canUndo: false };

// One spy per registry command, so a test can see exactly which handler ran.
function spies(): Record<string, Mock<() => void>> {
  return Object.fromEntries(REGISTRY.commands.map((def) => [def.id, vi.fn<() => void>()]));
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
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
});

interface HarnessProps {
  state: CommandState;
  handlers: CommandHandlers;
}

// A focusable button outside the palette, so the focus-return test has an element to return to,
// and a text field, so the text-entry rule can be tested.
function Harness({ state, handlers }: HarnessProps) {
  return (
    <>
      <button type="button" id="invoker">
        Invoker
      </button>
      <input type="text" id="field" />
      <CommandPalette registry={REGISTRY} state={state} handlers={handlers} />
    </>
  );
}

function render(state: CommandState, handlers: CommandHandlers): void {
  act(() => {
    root.render(<Harness state={state} handlers={handlers} />);
  });
}

function key(target: EventTarget, init: KeyboardEventInit): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    );
  });
}

const CTRL_SHIFT_P = { key: 'P', ctrlKey: true, shiftKey: true };

function openPalette(): void {
  key(document.body, CTRL_SHIFT_P);
}

function input(): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>('.palette-input');
  if (found === null) throw new Error('palette input is not open');
  return found;
}

function type(text: string): void {
  // React listens for the native 'input' event, so set the value the way a keyboard does.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input(), text);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')];
}

function activeRow(): HTMLElement | undefined {
  return rows().find((row) => row.dataset.active === 'true');
}

describe('command palette', () => {
  it('opens with Ctrl+Shift+P, closes with Escape and returns focus to the invoker', async () => {
    render(OPEN_STATE, spies());
    const invoker = document.querySelector<HTMLButtonElement>('#invoker');
    invoker?.focus();
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    openPalette();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.activeElement).toBe(input());

    key(input(), { key: 'Escape' });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // react-aria restores focus on the next animation frame, so wait for it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(document.activeElement).toBe(invoker);
  });

  it('filters the commands by label and hides the ones the build lacks', () => {
    render(OPEN_STATE, spies());
    openPalette();
    const all = rows().length;
    expect(all).toBeGreaterThan(20);

    type('prefer');
    expect(rows().map((row) => row.dataset.command)).toEqual(['preferences']);

    type('PREFER zzz');
    expect(rows()).toHaveLength(0);
    expect(document.querySelector('.palette-empty')).not.toBeNull();

    // Every word must match: "undo" alone does not match "Redo".
    type('redo');
    expect(rows().map((row) => row.dataset.command)).toEqual(['redo']);
  });

  it('shows a disabled command disabled with its reason, and Enter does not run it', () => {
    const handlers = spies();
    render(NO_DOCUMENT_STATE, handlers);
    openPalette();
    type('close');
    const row = rows()[0];
    expect(row?.dataset.command).toBe('close');
    expect(row?.getAttribute('aria-disabled')).toBe('true');
    expect(row?.textContent).toContain('Open a PDF first.');

    key(input(), { key: 'Enter' });
    expect(handlers.close).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('moves the highlight with the arrow keys, wrapping at the ends', () => {
    render(OPEN_STATE, spies());
    openPalette();
    const first = activeRow()?.dataset.command;
    expect(first).toBe(rows()[0]?.dataset.command);

    key(input(), { key: 'ArrowDown' });
    expect(activeRow()).toBe(rows()[1]);
    expect(input().getAttribute('aria-activedescendant')).toBe(rows()[1]?.id);

    key(input(), { key: 'ArrowUp' });
    key(input(), { key: 'ArrowUp' });
    expect(activeRow()).toBe(rows()[rows().length - 1]);

    key(input(), { key: 'ArrowDown' });
    expect(activeRow()).toBe(rows()[0]);
  });

  it('runs the highlighted command once with Enter, through its handler, and closes', () => {
    const handlers = spies();
    render(OPEN_STATE, handlers);
    openPalette();
    key(input(), { key: 'ArrowDown' });
    const id = activeRow()?.dataset.command ?? '';
    expect(id).not.toBe('');

    key(input(), { key: 'Enter' });
    expect(handlers[id]).toHaveBeenCalledTimes(1);
    const total = Object.values(handlers).reduce((sum, spy) => sum + spy.mock.calls.length, 0);
    expect(total).toBe(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('runs a command when its row is clicked, and not when a disabled row is clicked', () => {
    const handlers = spies();
    render(NO_DOCUMENT_STATE, handlers);
    openPalette();
    type('close');
    act(() => {
      rows()[0]?.click();
    });
    expect(handlers.close).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('lists the bindings from the registry under Keyboard Shortcuts', () => {
    const handlers = spies();
    render(OPEN_STATE, handlers);
    openPalette();
    type('keyboard');
    key(input(), { key: 'Enter' });

    // The entry switches the palette to the list; it does not call a handler.
    expect(handlers['keyboard-shortcuts']).not.toHaveBeenCalled();
    const kbd = [...document.querySelectorAll('kbd')].map((el) => el.textContent);
    // Close is overridden to Alt+W on the web, and Undo keeps the shared Ctrl+Z.
    expect(kbd).toContain('Alt+W');
    expect(kbd).toContain('Ctrl+Z');
    expect(kbd).not.toContain('Ctrl+W');
  });

  it('ranks by the words of the label, so initials and letters in order find a command', () => {
    render(OPEN_STATE, spies());
    openPalette();
    type('rfs');
    expect(rows().map((row) => row.dataset.command)).toContain('reduce-file-size');
  });

  it('shows the ribbon tab of each command in its row', () => {
    render(OPEN_STATE, spies());
    openPalette();
    type('redo');
    const group = REGISTRY.groups.find((g) => g.id === REGISTRY.get('redo')?.group);
    const tab = group?.tab;
    if (tab === null || tab === undefined) throw new Error('redo has no ribbon tab');
    expect(rows()[0]?.querySelector('.palette-tab')?.textContent).toBe(t(TAB_LABELS[tab]));
  });

  it('records a palette run, then lists that command first with the Recent tag', () => {
    const handlers = spies();
    render(OPEN_STATE, handlers);
    openPalette();
    type('redo');
    key(input(), { key: 'Enter' });
    expect(handlers.redo).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(RECENT_COMMANDS_KEY)).toBe('["redo"]');

    openPalette();
    expect(rows()[0]?.dataset.command).toBe('redo');
    expect(rows()[0]?.dataset.recent).toBe('true');
    expect(rows()[0]?.textContent).toContain(t('palette.recent'));
    expect(rows()[1]?.dataset.recent).toBeUndefined();
  });

  it('focuses the page field after the palette closes when Go to Page runs from it', async () => {
    // The page field stands in for the status bar's, which focusPageField focuses in the app.
    const handlers = spies();
    handlers['go-to-page'] = vi.fn(() => {
      document.querySelector<HTMLInputElement>('#field')?.focus();
    });
    render(OPEN_STATE, handlers);
    document.querySelector<HTMLButtonElement>('#invoker')?.focus();
    openPalette();
    type('go to page');
    key(input(), { key: 'Enter' });
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    // The palette restores focus to the invoker on the next frame; Go to Page runs after that.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(handlers['go-to-page']).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(document.querySelector('#field'));
  });

  it('does not record a run that is refused because the command is disabled', () => {
    render(NO_DOCUMENT_STATE, spies());
    openPalette();
    type('close');
    key(input(), { key: 'Enter' });
    expect(window.localStorage.getItem(RECENT_COMMANDS_KEY)).toBeNull();
  });

  it('does not record a ribbon run, which goes through runCommand without the palette', () => {
    // The ribbon's buttons call runCommand directly (Ribbon.tsx), not the palette's run path.
    const handlers = spies();
    render(OPEN_STATE, handlers);
    act(() => {
      runCommand(REGISTRY, 'undo', OPEN_STATE, handlers);
    });
    expect(handlers.undo).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(RECENT_COMMANDS_KEY)).toBeNull();
  });

  it('labels a command with no ribbon tab as in the app menu', () => {
    render(OPEN_STATE, spies());
    openPalette();
    type('preferences');
    expect(rows()[0]?.dataset.command).toBe('preferences');
    expect(rows()[0]?.querySelector('.palette-tab')?.textContent).toBe(t('palette.menuLocation'));
    expect(rows()[0]?.querySelector('.palette-tab')?.textContent).toBe('App menu');
  });

  it('opens and lists the commands normally when the stored recent list is corrupt', () => {
    window.localStorage.setItem(RECENT_COMMANDS_KEY, '{not json');
    render(OPEN_STATE, spies());
    expect(() => openPalette()).not.toThrow();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(rows().length).toBeGreaterThan(20);
    expect(rows().some((row) => row.dataset.recent === 'true')).toBe(false);
  });

  it('does not record the keyboard shortcuts entry, which only switches the palette view', () => {
    render(OPEN_STATE, spies());
    openPalette();
    type('keyboard');
    key(input(), { key: 'Enter' });
    expect(document.querySelector('kbd')).not.toBeNull();
    expect(window.localStorage.getItem(RECENT_COMMANDS_KEY)).toBeNull();
  });

  it('says a command with no handler is not available yet, and does not run it', () => {
    const handlers = spies();
    delete handlers.close;
    render(OPEN_STATE, handlers);
    openPalette();
    type('close');
    const row = rows()[0];
    expect(row?.dataset.command).toBe('close');
    expect(row?.getAttribute('aria-disabled')).toBe('true');
    expect(row?.textContent).toContain(t('disabled.notAvailableYet'));

    key(input(), { key: 'Enter' });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(window.localStorage.getItem(RECENT_COMMANDS_KEY)).toBeNull();
  });

  it('is a scan-clean module: every user string goes through t()', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(here).filter(
      (name) => /\.tsx?$/.test(name) && !/\.test\./.test(name),
    );
    expect(files).toEqual(expect.arrayContaining(['CommandPalette.tsx']));
    const JSX_TEXT = />([^<>{}\n]*\p{L}[^<>{}\n]*)</gu;
    const READABLE_ATTRIBUTE =
      /\b(aria-label|aria-description|title|alt|placeholder)=("[^"]*"|'[^']*')/g;
    for (const file of files) {
      const text = readFileSync(resolve(here, file), 'utf8');
      expect([...text.matchAll(JSX_TEXT)].map((m) => m[1])).toEqual([]);
      expect([...text.matchAll(READABLE_ATTRIBUTE)].map((m) => m[0])).toEqual([]);
    }
  });
});

describe('command palette opened with a seed', () => {
  it('opens filtered by the seed query, with the input and the list showing it', () => {
    render(OPEN_STATE, spies());
    act(() => {
      openCommandPalette({ query: 'redo' });
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(input().value).toBe('redo');
    expect(rows().map((row) => row.dataset.command)).toEqual(['redo']);
  });

  it('opens with an empty query when the seed has none', () => {
    render(OPEN_STATE, spies());
    act(() => {
      openCommandPalette();
    });
    expect(input().value).toBe('');
    expect(rows().length).toBeGreaterThan(20);
  });

  it('opens the shortcuts view when the seed asks for it', () => {
    render(OPEN_STATE, spies());
    act(() => {
      openCommandPalette({ view: 'shortcuts' });
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('.palette-input')).toBeNull();
  });

  it('forgets the seed on the next plain open with Ctrl+Shift+P', () => {
    render(OPEN_STATE, spies());
    act(() => {
      openCommandPalette({ query: 'redo' });
    });
    key(input(), { key: 'Escape' });
    openPalette();
    expect(input().value).toBe('');
  });
});

describe('keyboard shortcuts', () => {
  it('runs the command bound to a shortcut, with its enabled rule honoured', () => {
    const handlers = spies();
    render(OPEN_STATE, handlers);
    key(document.body, { key: 'z', ctrlKey: true });
    expect(handlers.undo).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('does not record a command run from its shortcut', () => {
    const handlers = spies();
    render(OPEN_STATE, handlers);
    key(document.body, { key: 'z', ctrlKey: true });
    expect(handlers.undo).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(RECENT_COMMANDS_KEY)).toBeNull();
  });

  it('does not run a disabled command from its shortcut', () => {
    const handlers = spies();
    render(NO_DOCUMENT_STATE, handlers);
    key(document.body, { key: 'z', ctrlKey: true });
    expect(handlers.undo).not.toHaveBeenCalled();
  });

  it('does not run a shortcut typed into a text field', () => {
    const handlers = spies();
    render(OPEN_STATE, handlers);
    key(document.querySelector('#field') as HTMLElement, { key: 'z', ctrlKey: true });
    expect(handlers.undo).not.toHaveBeenCalled();
  });

  it('uses the web override for Close (Alt+W) and not the browser-reserved Ctrl+W', () => {
    const handlers = spies();
    render(OPEN_STATE, handlers);
    key(document.body, { key: 'w', ctrlKey: true });
    expect(handlers.close).not.toHaveBeenCalled();
    key(document.body, { key: 'w', altKey: true });
    expect(handlers.close).toHaveBeenCalledTimes(1);
  });

  it('runs Go to Page once from Alt+G, and not from a text field', () => {
    const handlers = spies();
    render(OPEN_STATE, handlers);
    key(document.body, { key: 'g', code: 'KeyG', altKey: true });
    expect(handlers['go-to-page']).toHaveBeenCalledTimes(1);
    key(document.querySelector('#field') as HTMLElement, { key: 'g', code: 'KeyG', altKey: true });
    expect(handlers['go-to-page']).toHaveBeenCalledTimes(1);
  });

  it('runs Next and Previous Document from Alt+PgDn and Alt+PgUp, and not in a text field', () => {
    const handlers = spies();
    render(OPEN_STATE, handlers);
    key(document.body, { key: 'PageDown', altKey: true });
    expect(handlers['next-document']).toHaveBeenCalledTimes(1);
    key(document.body, { key: 'PageUp', altKey: true });
    expect(handlers['previous-document']).toHaveBeenCalledTimes(1);
    key(document.querySelector('#field') as HTMLElement, { key: 'PageDown', altKey: true });
    expect(handlers['next-document']).toHaveBeenCalledTimes(1);
  });

  it('does not run Next Document with no document open', () => {
    const handlers = spies();
    render(NO_DOCUMENT_STATE, handlers);
    key(document.body, { key: 'PageDown', altKey: true });
    expect(handlers['next-document']).not.toHaveBeenCalled();
  });

  it('opens the palette from a text field too, and not while it is open', () => {
    render(OPEN_STATE, spies());
    key(document.querySelector('#field') as HTMLElement, CTRL_SHIFT_P);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    // The palette is open: a second Ctrl+Shift+P changes nothing and no shortcut runs.
    openPalette();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });
});
