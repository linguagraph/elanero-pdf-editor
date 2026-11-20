import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionJobCancelled, type ActionJobWorker } from '../actionJob/actionJob';
import type { PageRpc } from '../engine/engineConnection';
import { RpcError } from '../rpc/client';
import { t } from '../i18n/t';
import { SanitizeDialog } from './SanitizeDialog';
import { runSanitize, SANITIZE_LABEL, SANITIZE_OPTIONS, type SanitizeChoice } from './sanitize';

// The dialog calls runSanitize; these tests drive its outcomes and check the choice it sends. The
// job's own arguments are covered by sanitize.test.ts.
vi.mock('./sanitize', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sanitize')>();
  return { ...actual, runSanitize: vi.fn() };
});

const runSanitizeMock = vi.mocked(runSanitize);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) },
  });
}

let host: HTMLDivElement;
let root: Root;

const worker: ActionJobWorker = { call: vi.fn(), terminate: vi.fn() };
const engine = { call: vi.fn() } as unknown as PageRpc;

function props(overrides: { isOpen?: boolean; onClose?: () => void; onChanged?: () => void } = {}) {
  return {
    isOpen: overrides.isOpen ?? true,
    onClose: overrides.onClose ?? vi.fn(),
    engine,
    handle: 'doc-1',
    startWorker: () => worker,
    onChanged: overrides.onChanged,
  };
}

function render(overrides: Parameters<typeof props>[0] = {}) {
  act(() => {
    root.render(<SanitizeDialog {...props(overrides)} />);
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === label,
  );
  if (found === undefined) throw new Error(`no ${label} button`);
  return found;
}

function checkboxes(): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
}

function checkboxFor(label: string): HTMLInputElement {
  const found = checkboxes().find((input) => input.labels?.[0]?.textContent === label);
  if (found === undefined) throw new Error(`no ${label} option`);
  return found;
}

function toggle(label: string): void {
  act(() => {
    checkboxFor(label).click();
  });
}

function submit(): void {
  act(() => {
    button(t('sanitize.run')).click();
  });
}

function alertText(): string | null {
  return document.querySelector('[role="alert"]')?.textContent ?? null;
}

function fieldsetDisabled(): boolean {
  return document.querySelector('fieldset')?.disabled ?? false;
}

beforeEach(() => {
  runSanitizeMock.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

describe('SanitizeDialog choices', () => {
  it('offers all eleven categories, each checked, with its label through t()', () => {
    render();
    expect(checkboxes()).toHaveLength(11);
    for (const option of SANITIZE_OPTIONS) {
      const label = t(SANITIZE_LABEL[option]);
      expect(checkboxFor(label).checked).toBe(true);
    }
  });

  it('disables Sanitize when every category is unchecked', () => {
    render();
    for (const option of SANITIZE_OPTIONS) toggle(t(SANITIZE_LABEL[option]));
    expect(button(t('sanitize.run')).disabled).toBe(true);
  });

  it('starts again from the defaults when the dialog is reopened', () => {
    render();
    toggle(t(SANITIZE_LABEL.links));
    render({ isOpen: false });
    render();
    expect(checkboxFor(t(SANITIZE_LABEL.links)).checked).toBe(true);
  });
});

describe('SanitizeDialog confirm and run', () => {
  it('asks for confirmation, and Back returns with the choices kept', () => {
    render();
    toggle(t(SANITIZE_LABEL.metadata));
    submit();
    expect(document.querySelector('.redact-confirm')?.textContent).toContain(
      t('sanitize.confirm.body'),
    );
    act(() => {
      button(t('sanitize.confirm.back')).click();
    });
    expect(checkboxFor(t(SANITIZE_LABEL.metadata)).checked).toBe(false);
    expect(runSanitizeMock).not.toHaveBeenCalled();
  });

  it('sends every category in the choice, with the one the user unchecked off', () => {
    runSanitizeMock.mockReturnValue(new Promise(() => undefined));
    render();
    toggle(t(SANITIZE_LABEL.hidden_layers));
    submit();
    act(() => {
      button(t('sanitize.confirm.run')).click();
    });
    expect(runSanitizeMock).toHaveBeenCalledTimes(1);
    const [, handle, choice] = runSanitizeMock.mock.calls[0] as [unknown, string, SanitizeChoice];
    expect(handle).toBe('doc-1');
    expect(Object.keys(choice).sort()).toEqual([...SANITIZE_OPTIONS].sort());
    expect(choice.hidden_layers).toBe(false);
    expect(
      SANITIZE_OPTIONS.filter((option) => option !== 'hidden_layers').every((o) => choice[o]),
    ).toBe(true);
  });

  it('disables the choices while the sanitize runs', () => {
    runSanitizeMock.mockReturnValue(new Promise(() => undefined));
    render();
    submit();
    act(() => {
      button(t('sanitize.confirm.run')).click();
    });
    expect(fieldsetDisabled()).toBe(true);
    expect(button(t('sanitize.close')).disabled).toBe(true);
  });
});

describe('SanitizeDialog result', () => {
  async function runWith(result: { removed: string[]; changed: null }, onChanged = vi.fn()) {
    runSanitizeMock.mockResolvedValue(result);
    render({ onChanged });
    submit();
    act(() => {
      button(t('sanitize.confirm.run')).click();
    });
    await settle();
    return onChanged;
  }

  it('lists what was removed, with the save hint', async () => {
    await runWith({ removed: ['Document properties', 'Links'], changed: null });
    const text = document.body.textContent ?? '';
    expect(text).toContain(t('sanitize.result.heading'));
    expect(text).toContain('Document properties');
    expect(text).toContain('Links');
    expect(text).toContain(t('sanitize.result.saveHint'));
  });

  it('says nothing needed removing when the list is empty', async () => {
    await runWith({ removed: [], changed: null });
    expect(document.body.textContent).toContain(t('sanitize.result.none'));
    expect(document.querySelector('.sanitize-result')).toBeNull();
  });

  it('reports the changed pages to the view', async () => {
    const changed = { pages: [0] } as never;
    runSanitizeMock.mockResolvedValue({ removed: ['Links'], changed });
    const onChanged = vi.fn();
    render({ onChanged });
    submit();
    act(() => {
      button(t('sanitize.confirm.run')).click();
    });
    await settle();
    expect(onChanged).toHaveBeenCalledWith(changed);
  });
});

describe('SanitizeDialog failures', () => {
  async function failWith(failure: unknown): Promise<void> {
    runSanitizeMock.mockRejectedValue(failure);
    render();
    submit();
    act(() => {
      button(t('sanitize.confirm.run')).click();
    });
    await settle();
  }

  it('shows no error when the user cancels', async () => {
    await failWith(new ActionJobCancelled());
    expect(alertText()).toBeNull();
    expect(document.querySelector('.redact-confirm')).toBeNull();
  });

  it('shows the encrypted-document refusal through t()', async () => {
    await failWith(new RpcError('REFUSED', 'refused', { reason: 'encrypted_mutating_job' }));
    expect(alertText()).toBe(t('job.encryptedRefused'));
  });

  it('shows the signed-document refusal through t()', async () => {
    await failWith(new RpcError('REFUSED', 'refused', { reason: 'signed_document' }));
    expect(alertText()).toBe(t('sanitize.refused.signed'));
    expect(alertText()).toBe(
      'This document is signed. Sanitizing it would invalidate the signatures.',
    );
  });

  it('shows the generic failure for any other error', async () => {
    await failWith(new Error('boom'));
    expect(alertText()).toBe(t('sanitize.failed'));
  });
});

describe('SanitizeDialog close', () => {
  it('cannot be closed while the sanitize runs', () => {
    runSanitizeMock.mockReturnValue(new Promise(() => undefined));
    const onClose = vi.fn();
    render({ onClose });
    submit();
    act(() => {
      button(t('sanitize.confirm.run')).click();
    });
    expect(button(t('sanitize.close')).disabled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });
});
