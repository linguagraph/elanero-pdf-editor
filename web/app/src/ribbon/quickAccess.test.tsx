import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUICK_ACCESS, REGISTRY } from '../commands/catalog';
import { type CommandState, DISABLED_REASON_LABELS } from '../commands/registry';
import { t } from '../i18n/t';
import { QuickAccess } from './QuickAccess';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  vi.unstubAllGlobals();
});

function render(node: React.ReactNode): void {
  act(() => {
    root.render(node);
  });
}

const state: CommandState = {
  hasDocument: true,
  hasRecentFiles: false,
  canUndo: true,
  canRedo: false,
  capabilities: new Set(),
  ribbonCompact: false,
  ribbonCollapsed: false,
  viewTool: 'select',
  canGoBack: false,
  canGoForward: false,
  view: null,
};

function commandsShown(): string[] {
  return [...host.querySelectorAll<HTMLElement>('[data-command]')].map(
    (el) => el.dataset.command ?? '',
  );
}

function setWidth(width: number): void {
  vi.stubGlobal('innerWidth', width);
}

describe('QuickAccess', () => {
  it('shows Select, Hand, Undo, Redo and Save at a wide window, as icons with labels', () => {
    setWidth(1280);
    render(<QuickAccess registry={REGISTRY} state={state} handlers={{}} />);
    expect(commandsShown()).toEqual(QUICK_ACCESS);
    const undo = host.querySelector<HTMLElement>('[data-command="undo"]');
    expect(undo?.getAttribute('aria-label')).toBe(t('command.undo.label'));
    expect(undo?.querySelector('.ribbon-command-label')).toBeNull();
  });

  it('keeps only Undo, Redo and Save below 1024 px', () => {
    setWidth(900);
    render(<QuickAccess registry={REGISTRY} state={state} handlers={{}} />);
    expect(commandsShown()).toEqual(['undo', 'redo', 'save']);
  });

  it('keeps every button disabled with the not-available reason until its handler lands', () => {
    setWidth(1280);
    render(<QuickAccess registry={REGISTRY} state={state} handlers={{}} />);
    const save = host.querySelector<HTMLElement>('[data-command="save"]');
    expect(save?.getAttribute('aria-disabled')).toBe('true');
    const described = (save?.getAttribute('aria-describedby') ?? '').split(' ');
    const text = described.map((id) => document.getElementById(id)?.textContent ?? '');
    expect(text).toContain(t(DISABLED_REASON_LABELS.notAvailableYet));
  });

  it('runs a command that has a handler and is enabled', () => {
    setWidth(1280);
    const undo = vi.fn();
    render(<QuickAccess registry={REGISTRY} state={state} handlers={{ undo }} />);
    const button = host.querySelector<HTMLElement>('[data-command="undo"]');
    act(() => {
      button?.click();
    });
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('does not run Redo while there is nothing to redo', () => {
    setWidth(1280);
    const redo = vi.fn();
    render(<QuickAccess registry={REGISTRY} state={state} handlers={{ redo }} />);
    const button = host.querySelector<HTMLElement>('[data-command="redo"]');
    act(() => {
      button?.click();
    });
    expect(redo).not.toHaveBeenCalled();
  });
});

describe('QuickAccess: the Select and Hand toggles (W4.10)', () => {
  it('shows aria-pressed on the Select and Hand buttons from the view tool', () => {
    setWidth(1280);
    render(
      <QuickAccess registry={REGISTRY} state={{ ...state, viewTool: 'hand' }} handlers={{}} />,
    );
    const pressed = (id: string) =>
      host.querySelector(`[data-command="${id}"]`)?.getAttribute('aria-pressed');
    expect(pressed('select-tool')).toBe('false');
    expect(pressed('hand-tool')).toBe('true');
  });

  it('runs a press once', () => {
    setWidth(1280);
    const hand = vi.fn();
    render(<QuickAccess registry={REGISTRY} state={state} handlers={{ 'hand-tool': hand }} />);
    act(() => {
      host.querySelector<HTMLElement>('[data-command="hand-tool"]')?.click();
    });
    expect(hand).toHaveBeenCalledTimes(1);
  });
});
