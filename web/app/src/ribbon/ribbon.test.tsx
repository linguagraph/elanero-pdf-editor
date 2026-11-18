import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REGISTRY } from '../commands/catalog';
import { type CommandState, TAB_LABELS } from '../commands/registry';
import { ribbonLayout } from '../commands/run';
import { t } from '../i18n/t';
import { AppMenu } from './AppMenu';
import { Ribbon } from './Ribbon';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a popover opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) },
  });
}

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

function render(node: React.ReactNode): void {
  act(() => {
    root.render(node);
  });
}

function key(target: Element, name: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  });
}

function button(command: string): HTMLElement {
  const el = host.querySelector<HTMLElement>(`[data-command="${command}"]`);
  if (el === null) throw new Error(`no ribbon button for ${command}`);
  return el;
}

// The text of the hidden elements a button is described by, joined by a space.
function describedText(el: HTMLElement): string {
  const ids = (el.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
}

function activeCommand(): string | null | undefined {
  return (document.activeElement as HTMLElement | null)?.dataset.command;
}

const withDoc: CommandState = {
  hasDocument: true,
  canUndo: false,
  canRedo: false,
  capabilities: new Set(['signing', 'ocr', 'office_import', 'pdfa', 'pwa_install']),
};
const noDoc: CommandState = { ...withDoc, hasDocument: false };

describe('Ribbon', () => {
  it('renders the groups of each tab from the registry', () => {
    render(<Ribbon registry={REGISTRY} state={withDoc} handlers={{}} />);
    const groupLabels = [...host.querySelectorAll('[role="group"] .ribbon-group-label')].map(
      (el) => el.textContent,
    );
    const expected = ribbonLayout(REGISTRY, withDoc)
      .find((tab) => tab.tab === 'home')
      ?.groups.map((group) => t(group.group.labelId));
    expect(groupLabels).toEqual(expected);
    expect(host.querySelector('[role="tablist"]')?.textContent).toContain(t(TAB_LABELS.home));
  });

  it('moves focus between tabs with the arrow keys', () => {
    render(<Ribbon registry={REGISTRY} state={withDoc} handlers={{}} />);
    const tabs = [...host.querySelectorAll<HTMLElement>('[role="tab"]')];
    tabs[0]?.focus();
    key(tabs[0] as HTMLElement, 'ArrowRight');
    expect(document.activeElement).toBe(tabs[1]);
    key(tabs[1] as HTMLElement, 'ArrowLeft');
    expect(document.activeElement).toBe(tabs[0]);
  });

  it('moves focus between commands with the arrow keys', () => {
    render(<Ribbon registry={REGISTRY} state={withDoc} handlers={{}} />);
    button('open').focus();
    key(button('open'), 'ArrowRight');
    expect(activeCommand()).toBe('save');
    key(button('save'), 'ArrowRight');
    expect(activeCommand()).toBe('print');
  });

  it('shows a disabled command as aria-disabled with its reason, and does not run it', () => {
    const save = vi.fn();
    render(<Ribbon registry={REGISTRY} state={noDoc} handlers={{ save }} />);
    const el = button('save');
    expect(el.getAttribute('aria-disabled')).toBe('true');
    expect(describedText(el)).toContain(t('disabled.needsDocument'));
    act(() => {
      el.click();
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('runs an enabled command when pressed', () => {
    const save = vi.fn();
    render(<Ribbon registry={REGISTRY} state={withDoc} handlers={{ save }} />);
    expect(button('save').getAttribute('aria-disabled')).toBeNull();
    act(() => {
      button('save').click();
    });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('gives the shortcut from the shared table in the description', () => {
    render(<Ribbon registry={REGISTRY} state={withDoc} handlers={{}} />);
    expect(describedText(button('save'))).toBe('Ctrl+S');
  });
});

describe('AppMenu', () => {
  it('opens from its button and closes with Escape', () => {
    render(<AppMenu registry={REGISTRY} state={withDoc} handlers={{}} />);
    const trigger = host.querySelector<HTMLElement>('button[aria-label="Main menu"]');
    expect(trigger).not.toBeNull();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    act(() => {
      trigger?.click();
    });
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain(t('command.preferences.label'));
    act(() => {
      menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('marks a disabled item aria-disabled and runs enabled items only', () => {
    const save = vi.fn();
    const preferences = vi.fn();
    render(<AppMenu registry={REGISTRY} state={noDoc} handlers={{ save, preferences }} />);
    act(() => {
      host.querySelector<HTMLElement>('button[aria-label="Main menu"]')?.click();
    });
    const item = (id: string): HTMLElement | null =>
      document.querySelector<HTMLElement>(`[role="menuitem"][data-key="${id}"]`);
    expect(item('save')?.getAttribute('aria-disabled')).toBe('true');
    expect(item('preferences')?.getAttribute('aria-disabled')).toBeNull();
    act(() => {
      item('save')?.click();
    });
    expect(save).not.toHaveBeenCalled();
    act(() => {
      item('preferences')?.click();
    });
    expect(preferences).toHaveBeenCalledTimes(1);
  });
});
