import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assign, defaultKeys, effectiveKeys, reset } from '../commands/bindings';
import { REGISTRY } from '../commands/catalog';
import type { CommandState } from '../commands/registry';
import { commandDisabledReason } from '../commands/run';
import { t, tp } from '../i18n/t';
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

describe('ShortcutsDialog editing (W4.x, #330 W2)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    reset();
  });

  afterEach(() => {
    reset();
    vi.restoreAllMocks();
  });

  function button(text: string): HTMLButtonElement | undefined {
    return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (el) => el.textContent === text,
    );
  }

  function clickButton(text: string): void {
    const el = button(text);
    expect(el, text).toBeDefined();
    act(() => {
      el?.click();
    });
  }

  function recorder(): HTMLButtonElement {
    const el = document.querySelector<HTMLButtonElement>('.shortcut-recorder');
    expect(el).not.toBeNull();
    return el as HTMLButtonElement;
  }

  function startRecording(): void {
    clickButton(t('shortcuts.record.start'));
  }

  function press(el: Element, init: KeyboardEventInit): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    act(() => {
      el.dispatchEvent(event);
    });
    return event;
  }

  function pressChord(init: KeyboardEventInit): void {
    startRecording();
    press(recorder(), init);
  }

  function messageText(): string {
    return document.querySelector('.shortcut-message')?.textContent ?? '';
  }

  function alertText(): string {
    return document.querySelector('[role="alert"]')?.textContent ?? '';
  }

  it('filters the commands and announces the count', () => {
    render(() => undefined);
    const filter = document.querySelector<HTMLInputElement>('input[type="search"]');
    expect(filter).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(filter, 'open');
      filter?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const names = [...document.querySelectorAll('.shortcut-row-button')].map(
      (el) => el.textContent ?? '',
    );
    expect(names).toContain(t('command.open.label'));
    expect(names.every((name) => name.toLowerCase().includes('open'))).toBe(true);
    expect(document.querySelector('.shortcut-count')?.textContent).toBe(
      tp('shortcuts.count', names.length),
    );
  });

  it('records a key, shows it as ready and assigns it to the command', () => {
    render(() => undefined);
    clickButton(t('command.open.label'));
    pressChord({ key: 'Y', code: 'KeyY', ctrlKey: true, altKey: true });
    expect(messageText()).toBe(t('shortcuts.msg.ready', { keys: 'Ctrl+Alt+Y' }));
    clickButton(t('shortcuts.assign'));
    expect(effectiveKeys('open')).toEqual(['Ctrl+Alt+Y']);
    expect(document.querySelector('.shortcut-current kbd')?.textContent).toBe('Ctrl+Alt+Y');
  });

  it('refuses a key the browser keeps, with an alert and no Assign', () => {
    render(() => undefined);
    clickButton(t('command.open.label'));
    pressChord({ key: 'w', code: 'KeyW', ctrlKey: true });
    expect(alertText()).toBe(t('shortcuts.msg.browser'));
    expect(button(t('shortcuts.assign'))?.disabled).toBe(true);
  });

  it('refuses a key another command holds and names it', () => {
    render(() => undefined);
    clickButton(t('command.open.label'));
    // Alt+W is the Close default on the web, so another command holds it.
    pressChord({ key: 'w', code: 'KeyW', altKey: true });
    expect(alertText()).toContain('is already used by');
    expect(button(t('shortcuts.assign'))?.disabled).toBe(true);
  });

  it('warns about a key some browsers keep, and still allows Assign', () => {
    render(() => undefined);
    clickButton(t('command.open.label'));
    pressChord({ key: '=', code: 'Equal', ctrlKey: true });
    expect(messageText()).toContain('may not work everywhere');
    expect(button(t('shortcuts.assign'))?.disabled).toBe(false);
  });

  it('warns about a plain letter, which runs the command when no text box has focus', () => {
    render(() => undefined);
    clickButton(t('command.open.label'));
    pressChord({ key: 'q', code: 'KeyQ' });
    expect(messageText()).toContain('no text box has focus');
  });

  it('refuses the Windows key and says why', () => {
    render(() => undefined);
    clickButton(t('command.open.label'));
    pressChord({ key: 'k', code: 'KeyK', metaKey: true });
    expect(alertText()).toBe(t('shortcuts.msg.os'));
  });

  it('removes the keys, then restores the default', () => {
    render(() => undefined);
    clickButton(t('command.open.label'));
    const defaults = defaultKeys('open');
    clickButton(t('shortcuts.remove'));
    expect(effectiveKeys('open')).toEqual([]);
    clickButton(t('shortcuts.default'));
    expect(effectiveKeys('open')).toEqual(defaults);
  });

  it('asks before Reset all, and resets only after the confirmation', () => {
    render(() => undefined);
    clickButton(t('command.open.label'));
    pressChord({ key: 'Y', code: 'KeyY', ctrlKey: true, altKey: true });
    clickButton(t('shortcuts.assign'));
    clickButton(t('shortcuts.resetAll'));
    clickButton(t('shortcuts.resetAll.keep'));
    expect(effectiveKeys('open')).toEqual(['Ctrl+Alt+Y']);
    clickButton(t('shortcuts.resetAll'));
    clickButton(t('shortcuts.resetAll.yes'));
    expect(effectiveKeys('open')).toEqual(defaultKeys('open'));
  });

  it('cancels recording on Escape without closing the dialog', () => {
    const onClose = vi.fn();
    render(onClose);
    startRecording();
    press(recorder(), { key: 'Escape', code: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(recorder().textContent).toBe(t('shortcuts.record.start'));
  });

  it('lets Tab leave the recorder without capturing the key', () => {
    render(() => undefined);
    startRecording();
    press(recorder(), { key: 'Tab', code: 'Tab' });
    expect(recorder().textContent).toBe(t('shortcuts.record.start'));
  });

  it('says so when the change could not be saved, and still applies it', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    render(() => undefined);
    clickButton(t('command.open.label'));
    pressChord({ key: 'Y', code: 'KeyY', ctrlKey: true, altKey: true });
    clickButton(t('shortcuts.assign'));
    expect(messageText()).toContain(t('shortcuts.saveFailed'));
    expect(effectiveKeys('open')).toEqual(['Ctrl+Alt+Y']);
  });

  it('focuses the filter when the dialog opens', () => {
    render(() => undefined);
    const filter = document.querySelector<HTMLInputElement>('input[type="search"]');
    expect(filter).not.toBeNull();
    expect(document.activeElement).toBe(filter);
  });

  it('takes focus back to the filter one frame after the dialog opens if focus was lost', async () => {
    render(() => undefined);
    const filter = document.querySelector<HTMLInputElement>('input[type="search"]');
    // What the browser can do after mount: focus moved to the dialog element, or to the body.
    act(() => {
      dialog()?.focus();
    });
    expect(document.activeElement).not.toBe(filter);
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(document.activeElement).toBe(filter);
  });

  it('does not move focus from a control the user moved to inside the dialog', async () => {
    render(() => undefined);
    const row = button(t('command.open.label'));
    act(() => {
      row?.focus();
    });
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(document.activeElement).toBe(row);
  });

  it('returns focus to Reset all when Keep keeps the bindings', () => {
    render(() => undefined);
    clickButton(t('shortcuts.resetAll'));
    clickButton(t('shortcuts.resetAll.keep'));
    expect(document.activeElement).toBe(button(t('shortcuts.resetAll')));
  });

  it('keeps focus in the dialog when the selected row is filtered out by the action', () => {
    render(() => undefined);
    clickButton(t('command.open.label'));
    const filter = document.querySelector<HTMLInputElement>('input[type="search"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(filter, 'zoom');
      filter?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button(t('command.open.label'))).toBeUndefined();
    pressChord({ key: 'Y', code: 'KeyY', ctrlKey: true, altKey: true });
    clickButton(t('shortcuts.assign'));
    expect(document.activeElement).toBe(filter);
  });

  it('moves focus to the filter when Assign is refused for a filtered-out row', () => {
    render(() => undefined);
    clickButton(t('command.open.label'));
    const filter = document.querySelector<HTMLInputElement>('input[type="search"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(filter, 'zoom');
      filter?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button(t('command.open.label'))).toBeUndefined();
    pressChord({ key: 'Y', code: 'KeyY', ctrlKey: true, altKey: true });
    // Another command takes the chord after it was recorded, so Assign refuses it.
    expect(assign('close', ['Ctrl+Alt+Y'])).toBe(true);
    // Focus the Assign button first, as a click would, so the focus check is not met by the filter's autoFocus.
    act(() => {
      button(t('shortcuts.assign'))?.focus();
    });
    clickButton(t('shortcuts.assign'));
    expect(alertText()).toContain('is already used by');
    expect(document.activeElement).toBe(filter);
  });

  it('checks the chord again at Assign, and refuses it when another command took it meanwhile', () => {
    render(() => undefined);
    clickButton(t('command.open.label'));
    pressChord({ key: 'Y', code: 'KeyY', ctrlKey: true, altKey: true });
    expect(assign('close', ['Ctrl+Alt+Y'])).toBe(true);
    clickButton(t('shortcuts.assign'));
    expect(effectiveKeys('open')).toEqual(defaultKeys('open'));
    expect(effectiveKeys('close')).toEqual(['Ctrl+Alt+Y']);
    expect(alertText()).toContain('is already used by');
  });
});
