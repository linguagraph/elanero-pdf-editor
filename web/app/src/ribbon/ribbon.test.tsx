import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REGISTRY } from '../commands/catalog';
import { type CommandState, TAB_LABELS } from '../commands/registry';
import { ribbonLayout } from '../commands/run';
import { t } from '../i18n/t';
import { CommandPalette } from '../palette/CommandPalette';
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
  hasRecentFiles: false,
  canUndo: false,
  canRedo: false,
  capabilities: new Set(['signing', 'ocr', 'office_import', 'pdfa', 'pwa_install']),
  ribbonCompact: false,
  ribbonCollapsed: false,
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

  it('marks a command with no handler yet as disabled, with the not-available reason', () => {
    render(<Ribbon registry={REGISTRY} state={withDoc} handlers={{}} />);
    const el = button('save');
    expect(el.getAttribute('aria-disabled')).toBe('true');
    expect(describedText(el)).toContain(t('disabled.notAvailableYet'));
  });

  it('gives the shortcut from the shared table in the description', () => {
    render(<Ribbon registry={REGISTRY} state={withDoc} handlers={{ save: vi.fn() }} />);
    expect(describedText(button('save'))).toBe('Ctrl+S');
  });
});

describe('Ribbon in a narrow window', () => {
  const realWidth = window.innerWidth;
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: realWidth });
  });

  function narrow(width: number): void {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  }

  it('shows one row of tabs, with no tab panels, below the tablet breakpoint', () => {
    narrow(390);
    render(<Ribbon registry={REGISTRY} state={withDoc} handlers={{}} />);
    expect(host.querySelector('.ribbon-collapsed')).not.toBeNull();
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    expect(host.querySelectorAll('.ribbon-tabs > button')).toHaveLength(
      ribbonLayout(REGISTRY, withDoc).length,
    );
  });

  it('opens a tab group in a popover, and closes it once a command runs', () => {
    narrow(390);
    const save = vi.fn();
    render(<Ribbon registry={REGISTRY} state={withDoc} handlers={{ save }} />);
    const homeTab = host.querySelector<HTMLButtonElement>('.ribbon-tabs > button');
    expect(homeTab?.textContent).toBe(t(TAB_LABELS.home));
    act(() => {
      homeTab?.click();
    });
    const popover = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(popover?.textContent).toContain(t('command.save.label'));
    act(() => {
      document.querySelector<HTMLElement>('[data-command="save"]')?.click();
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('does not run a disabled command from the popover', () => {
    narrow(390);
    const save = vi.fn();
    render(<Ribbon registry={REGISTRY} state={noDoc} handlers={{ save }} />);
    act(() => {
      host.querySelector<HTMLButtonElement>('.ribbon-tabs > button')?.click();
    });
    const el = document.querySelector<HTMLElement>('[data-command="save"]');
    expect(el?.getAttribute('aria-disabled')).toBe('true');
    act(() => {
      el?.click();
    });
    expect(save).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('keeps the popover open and says why when a command with no handler is pressed', () => {
    narrow(390);
    render(<Ribbon registry={REGISTRY} state={withDoc} handlers={{ save: vi.fn() }} />);
    act(() => {
      host.querySelector<HTMLButtonElement>('.ribbon-tabs > button')?.click();
    });
    act(() => {
      document.querySelector<HTMLElement>('[data-command="print"]')?.click();
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('.ribbon-notice')?.textContent).toBe(
      t('disabled.notAvailableYet'),
    );
  });

  it('marks the tab buttons as opening a dialog', () => {
    narrow(390);
    render(<Ribbon registry={REGISTRY} state={withDoc} handlers={{}} />);
    const tabButtons = host.querySelectorAll<HTMLElement>('.ribbon-tabs > button');
    expect(tabButtons.length).toBeGreaterThan(0);
    for (const tabButton of tabButtons) {
      expect(tabButton.getAttribute('aria-haspopup')).toBe('dialog');
    }
  });

  it('closes the popover on Escape and returns focus to its tab button', async () => {
    narrow(390);
    render(<Ribbon registry={REGISTRY} state={withDoc} handlers={{ save: vi.fn() }} />);
    const homeTab = host.querySelector<HTMLButtonElement>('.ribbon-tabs > button');
    // A pointer press focuses the button before the popover opens; react-aria restores focus there.
    act(() => {
      homeTab?.focus();
      homeTab?.click();
    });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    act(() => {
      dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    // react-aria restores focus after the popover unmounts, on a later tick.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(homeTab);
  });
});

// Every string the ribbon shows or reads goes through t() (W4.7). Class names and ids are not text.
describe('ribbon strings go through t()', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const JSX_TEXT = />([^<>{}\n]*\p{L}[^<>{}\n]*)</gu;
  const READABLE_ATTRIBUTE =
    /\b(aria-label|aria-description|title|alt|placeholder)=("[^"]*"|'[^']*')/g;

  it.each(['Ribbon.tsx', 'AppMenu.tsx'])('%s has no literal user text', (file) => {
    const text = readFileSync(resolve(here, file), 'utf8');
    expect([...text.matchAll(JSX_TEXT)].map((m) => m[1])).toEqual([]);
    expect([...text.matchAll(READABLE_ATTRIBUTE)].map((m) => m[0])).toEqual([]);
  });
});

describe('AppMenu', () => {
  it('marks a command with no handler yet as disabled', () => {
    render(<AppMenu registry={REGISTRY} state={withDoc} handlers={{ preferences: vi.fn() }} />);
    act(() => {
      host.querySelector<HTMLElement>('button[aria-label="Main menu"]')?.click();
    });
    const item = (id: string): HTMLElement | null =>
      document.querySelector<HTMLElement>(`[role="menuitem"][data-key="${id}"]`);
    expect(item('print')?.getAttribute('aria-disabled')).toBe('true');
    expect(item('preferences')?.getAttribute('aria-disabled')).toBeNull();
  });

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

describe('Ribbon forms (W4.3a S2)', () => {
  const realWidth = window.innerWidth;
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: realWidth });
  });

  function setWidth(width: number): void {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  }

  function withPrefs(prefs: Partial<CommandState>): CommandState {
    return { ...withDoc, ...prefs };
  }

  function tabAt(index: number): HTMLElement {
    const tab = host.querySelectorAll<HTMLElement>('[role="tab"]')[index];
    if (tab === undefined) throw new Error(`no tab ${index}`);
    return tab;
  }

  it('is compact at 1100 px: icons only, the label as the name, and the captions still name the groups', () => {
    setWidth(1100);
    render(<Ribbon registry={REGISTRY} state={withDoc} handlers={{}} />);
    expect(host.querySelector('.ribbon')?.getAttribute('data-form')).toBe('compact');
    expect(host.querySelector('.ribbon-command-label')).toBeNull();
    const save = button('save');
    expect(save.getAttribute('aria-label')).toBe(t('command.save.label'));
    const labelId = save.closest('[role="group"]')?.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId ?? '')?.textContent).toBeTruthy();
  });

  it('is full at 1280 px and shows the labels', () => {
    setWidth(1280);
    render(<Ribbon registry={REGISTRY} state={withDoc} handlers={{}} />);
    expect(host.querySelector('.ribbon')?.getAttribute('data-form')).toBe('full');
    expect(host.querySelector('.ribbon-command-label')).not.toBeNull();
    expect(host.querySelector('.ribbon-chevron')).not.toBeNull();
  });

  it('is forced compact at 1100 px even when the user has not asked for it', () => {
    setWidth(1100);
    render(
      <Ribbon registry={REGISTRY} state={withPrefs({ ribbonCompact: false })} handlers={{}} />,
    );
    expect(host.querySelector('.ribbon')?.getAttribute('data-form')).toBe('compact');
  });

  it('drops the chevron at the tablet tier, where the tabs open drop-downs', () => {
    setWidth(900);
    render(<Ribbon registry={REGISTRY} state={withDoc} handlers={{}} />);
    expect(host.querySelector('.ribbon')?.getAttribute('data-collapsed-by')).toBe('tier');
    expect(host.querySelector('.ribbon-chevron')).toBeNull();
  });

  it('runs collapse-ribbon from the chevron, and hides the panels while the user has collapsed it', () => {
    setWidth(1280);
    const toggle = vi.fn();
    render(<Ribbon registry={REGISTRY} state={withDoc} handlers={{ 'collapse-ribbon': toggle }} />);
    act(() => {
      host.querySelector<HTMLElement>('.ribbon-chevron')?.click();
    });
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('shows the tab row only when collapsed by the user, and a tab press expands it', () => {
    setWidth(1280);
    const toggle = vi.fn();
    render(
      <Ribbon
        registry={REGISTRY}
        state={withPrefs({ ribbonCollapsed: true })}
        handlers={{ 'collapse-ribbon': toggle }}
      />,
    );
    expect(host.querySelector('.ribbon')?.getAttribute('data-form')).toBe('collapsed');
    expect(host.querySelector('[role="tabpanel"]')).toBeNull();
    expect(host.querySelector('.ribbon-chevron')?.getAttribute('aria-label')).toBe(
      t('ribbon.expand'),
    );
    act(() => {
      tabAt(1).click();
    });
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('toggles on a double-click of a tab, but not on the one that expanded the ribbon', () => {
    setWidth(1280);
    const toggle = vi.fn();
    const dblclick = () => {
      act(() => {
        tabAt(0).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      });
    };
    render(<Ribbon registry={REGISTRY} state={withDoc} handlers={{ 'collapse-ribbon': toggle }} />);
    dblclick();
    expect(toggle).toHaveBeenCalledTimes(1);
    toggle.mockClear();

    host.remove();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    render(
      <Ribbon
        registry={REGISTRY}
        state={withPrefs({ ribbonCollapsed: true })}
        handlers={{ 'collapse-ribbon': toggle }}
      />,
    );
    act(() => {
      tabAt(0).click();
    });
    dblclick();
    expect(toggle).toHaveBeenCalledTimes(1);
  });
});

// A ribbon whose collapse state lives in a parent, next to the command palette that owns the
// document Ctrl+F1 listener, so a key press runs the real path: keydown, runCommand, the handler.
function CollapsibleRibbon({ initialCollapsed }: { initialCollapsed: boolean }) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const state: CommandState = { ...withDoc, ribbonCollapsed: collapsed };
  const handlers = { 'collapse-ribbon': () => setCollapsed((value) => !value) };
  return (
    <>
      <Ribbon registry={REGISTRY} state={state} handlers={handlers} />
      <CommandPalette registry={REGISTRY} state={state} handlers={handlers} />
    </>
  );
}

describe('Ribbon collapse keys (W4.3a S2)', () => {
  const realWidth = window.innerWidth;
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: realWidth });
  });

  function setWidth(width: number): void {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  }

  function tabAt(index: number): HTMLElement {
    const tab = host.querySelectorAll<HTMLElement>('[role="tab"]')[index];
    if (tab === undefined) throw new Error(`no tab ${index}`);
    return tab;
  }

  function dblclickTab(index: number): void {
    act(() => {
      tabAt(index).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
  }

  function panelsShown(): boolean {
    return host.querySelector('[role="tabpanel"]') !== null;
  }

  function pressCtrlF1(): void {
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'F1', ctrlKey: true, bubbles: true }),
      );
    });
  }

  it('toggles the ribbon on Ctrl+F1 keydown, hiding and then showing the panels', () => {
    setWidth(1280);
    render(<CollapsibleRibbon initialCollapsed={false} />);
    expect(panelsShown()).toBe(true);

    pressCtrlF1();
    expect(panelsShown()).toBe(false);
    expect(host.querySelector('.ribbon')?.getAttribute('data-collapsed-by')).toBe('user');

    pressCtrlF1();
    expect(panelsShown()).toBe(true);
  });

  it('does not toggle the ribbon on a plain F1 keydown', () => {
    setWidth(1280);
    render(<CollapsibleRibbon initialCollapsed={false} />);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F1', bubbles: true }));
    });
    expect(panelsShown()).toBe(true);
  });

  it('a press 500 ms after the expanding press is a new press, and collapses the ribbon again', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    setWidth(1280);
    render(<CollapsibleRibbon initialCollapsed={true} />);
    expect(panelsShown()).toBe(false);

    // The press expands the ribbon and starts the double-click window.
    act(() => {
      tabAt(0).click();
    });
    expect(panelsShown()).toBe(true);

    // The next press lands 500 ms later, outside the window, so it toggles the ribbon back.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    dblclickTab(0);
    expect(panelsShown()).toBe(false);
  });

  it('a double-click 499 ms after the expanding press leaves the ribbon open', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    setWidth(1280);
    render(<CollapsibleRibbon initialCollapsed={true} />);
    act(() => {
      tabAt(0).click();
    });
    act(() => {
      vi.advanceTimersByTime(499);
    });
    dblclickTab(0);
    expect(panelsShown()).toBe(true);
  });

  it('a keyboard Enter on a focused tab expands a ribbon the user has collapsed', () => {
    setWidth(1280);
    render(<CollapsibleRibbon initialCollapsed={true} />);
    expect(panelsShown()).toBe(false);

    act(() => {
      tabAt(0).focus();
    });
    act(() => {
      tabAt(0).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(panelsShown()).toBe(true);
    expect(host.querySelector('.ribbon')?.getAttribute('data-collapsed-by')).toBeNull();
  });
});

describe('Ribbon group overflow (W4.3a S3)', () => {
  const realWidth = window.innerWidth;
  let rowWidth = 0;
  let observed: (() => void) | null = null;

  beforeEach(() => {
    rowWidth = 0;
    observed = null;
    // Every group is 100 px wide; the toolbar's content width is the test's `rowWidth`.
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.getAttribute('data-group') === null ? 0 : 100;
    });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains('ribbon-toolbar') || this.classList.contains('ribbon-tabrow')
        ? rowWidth
        : 0;
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          observed = callback;
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: realWidth });
  });

  function homeGroupIds(): string[] {
    return (ribbonLayout(REGISTRY, withDoc).find((tab) => tab.tab === 'home')?.groups ?? []).map(
      (group) => group.group.id,
    );
  }

  function rowGroupIds(): string[] {
    return [...host.querySelectorAll<HTMLElement>('.ribbon-panel [data-group]')].map(
      (el) => el.dataset.group ?? '',
    );
  }

  // The menu's groups, read from its group captions in order.
  function menuLabels(): string[] {
    return [...document.querySelectorAll('[role="dialog"] .ribbon-group-label')].map(
      (el) => el.textContent ?? '',
    );
  }

  it('shows every group and no "More commands" button when all fit', () => {
    rowWidth = 10_000;
    render(<Ribbon registry={REGISTRY} state={withDoc} handlers={{}} />);
    expect(rowGroupIds()).toEqual(homeGroupIds());
    expect(host.querySelector('.ribbon-more')).toBeNull();
  });

  it('moves the groups that do not fit to the menu, whole and in order', () => {
    // 3 groups of 100 px plus the menu button's 40 px fit in 350 px; the rest go to the menu.
    rowWidth = 350;
    render(<Ribbon registry={REGISTRY} state={withDoc} handlers={{}} />);
    const ids = homeGroupIds();
    expect(rowGroupIds()).toEqual(ids.slice(0, 3));
    expect(host.querySelector('.ribbon-more')).not.toBeNull();
    act(() => {
      host.querySelector<HTMLButtonElement>('.ribbon-more')?.click();
    });
    expect(menuLabels()).toEqual(ids.slice(3).map((id) => labelOf(id)));
  });

  it('keeps no group in the row when even one does not fit beside the menu button', () => {
    rowWidth = 120;
    render(<Ribbon registry={REGISTRY} state={withDoc} handlers={{}} />);
    expect(rowGroupIds()).toEqual([]);
    act(() => {
      host.querySelector<HTMLButtonElement>('.ribbon-more')?.click();
    });
    expect(menuLabels()).toEqual(homeGroupIds().map((id) => labelOf(id)));
  });

  it('recomputes the row when the observed row changes width', () => {
    rowWidth = 10_000;
    render(<Ribbon registry={REGISTRY} state={withDoc} handlers={{}} />);
    expect(host.querySelector('.ribbon-more')).toBeNull();
    rowWidth = 350;
    act(() => {
      observed?.();
    });
    expect(rowGroupIds()).toEqual(homeGroupIds().slice(0, 3));
  });

  it('runs a command from the menu and closes the menu', () => {
    rowWidth = 350;
    const run = vi.fn();
    // Every command gets the same handler, so the first command of a hidden group can be run.
    const handlers = Object.fromEntries(REGISTRY.commands.map((def) => [def.id, run]));
    render(<Ribbon registry={REGISTRY} state={withDoc} handlers={handlers} />);
    const hidden = ribbonLayout(REGISTRY, withDoc)
      .find((tab) => tab.tab === 'home')
      ?.groups.slice(3);
    const first = hidden?.[0]?.commands[0];
    expect(first).toBeDefined();
    act(() => {
      host.querySelector<HTMLButtonElement>('.ribbon-more')?.click();
    });
    act(() => {
      document.querySelector<HTMLElement>(`[data-command="${first?.id}"]`)?.click();
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shows the disabled notice in the menu for a disabled command, and keeps the menu open', () => {
    rowWidth = 350;
    render(<Ribbon registry={REGISTRY} state={noDoc} handlers={{}} />);
    act(() => {
      host.querySelector<HTMLButtonElement>('.ribbon-more')?.click();
    });
    const disabled = document.querySelector<HTMLElement>('[role="dialog"] [aria-disabled="true"]');
    expect(disabled).not.toBeNull();
    act(() => {
      disabled?.click();
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      t('disabled.needsDocument'),
    );
  });
});

// The caption of a group in the home tab, by its id.
function labelOf(groupId: string): string {
  const group = REGISTRY.groups.find((entry) => entry.id === groupId);
  if (group === undefined) throw new Error(`no group ${groupId}`);
  return t(group.labelId);
}
