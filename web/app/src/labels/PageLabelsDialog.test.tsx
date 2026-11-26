import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import type { PageLabelRuleDto, RunResult } from '../rpc/generated';
import { PageLabelsDialog } from './PageLabelsDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, '\\$&') },
  });
}

// The document's rules: a roman range from page 1, and an A- range from page 3.
const SAVED: PageLabelRuleDto[] = [
  { start: 0, style: 'r', prefix: '', first: 1 },
  { start: 2, style: 'D', prefix: 'A-', first: 1 },
];

let host: HTMLDivElement;
let root: Root;

// A fake engine: session.label_rules answers with `saved`; actions.run answers as `run`.
function fakeRpc(run: () => Promise<RunResult> = () => Promise.resolve(reply(true))) {
  const call = vi.fn((method: string) => {
    if (method === 'session.label_rules') return Promise.resolve({ rules: SAVED });
    if (method === 'actions.run') return run();
    return new Promise(() => undefined);
  });
  return { call, rpc: { call } as unknown as Pick<PageRpc, 'call'> as PageRpc };
}

function reply(executed: boolean): RunResult {
  return {
    label: 'Edit Page Labels',
    executed,
    value: null,
    changed: null,
    state: { history: 1 } as unknown as RunResult['state'],
  };
}

function render(rpc: PageRpc, options: { onClose?: () => void; onChanged?: () => void } = {}) {
  const onClose = options.onClose ?? vi.fn();
  const onChanged = options.onChanged ?? vi.fn();
  act(() => {
    root.render(
      <PageLabelsDialog
        isOpen
        onClose={onClose}
        rpc={rpc}
        handle="doc-1"
        pageCount={8}
        onChanged={onChanged}
      />,
    );
  });
  return { onClose, onChanged };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function column(label: string): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>(`input[aria-label="${label}"]`)];
}

function typeText(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === text,
  );
  if (found === undefined) throw new Error(`no ${text} button`);
  return found;
}

function alertText(): string | null {
  return document.querySelector('[role="alert"]')?.textContent ?? null;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('PageLabelsDialog', () => {
  it('loads the document rules into rows, one-based', async () => {
    const { rpc } = fakeRpc();
    render(rpc);
    await settle();
    expect(column(t('labels.column.from')).map((input) => input.value)).toEqual(['1', '3']);
    expect(column(t('labels.column.first')).map((input) => input.value)).toEqual(['1', '1']);
    expect(column(t('labels.column.prefix')).map((input) => input.value)).toEqual(['', 'A-']);
  });

  it('Save sends pages.set_labels with the rules as 0-based starts, then closes', async () => {
    const { call, rpc } = fakeRpc();
    const { onClose, onChanged } = render(rpc);
    await settle();
    act(() => {
      button(t('labels.ok')).click();
    });
    await settle();
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'doc-1',
      name: 'pages.set_labels',
      args: {
        rules: [
          { start: 0, style: 'r', prefix: '', first: 1 },
          { start: 2, style: 'D', prefix: 'A-', first: 1 },
        ],
      },
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the engine refusal inside the dialog, which stays open', async () => {
    const refusal = new RpcError('REFUSED', 'refused', { reason: 'duplicate_label_start' });
    const { rpc } = fakeRpc(() => Promise.reject(refusal));
    const { onClose } = render(rpc);
    await settle();
    act(() => {
      button(t('labels.ok')).click();
    });
    await settle();
    expect(alertText()).toBe(t('error.REFUSED.duplicateLabelStart'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('refuses a From page outside the document without calling the engine', async () => {
    const { call, rpc } = fakeRpc();
    const { onClose } = render(rpc);
    await settle();
    typeText(column(t('labels.column.from'))[1]!, '9');
    act(() => {
      button(t('labels.ok')).click();
    });
    await settle();
    expect(alertText()).toBe(t('labels.problem.fromPage', { count: 8 }));
    expect(call).not.toHaveBeenCalledWith('actions.run', expect.anything());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Add Range adds a row and Remove takes out the row last focused', async () => {
    const { rpc } = fakeRpc();
    render(rpc);
    await settle();
    act(() => {
      button(t('labels.add')).click();
    });
    expect(column(t('labels.column.from'))).toHaveLength(3);
    act(() => {
      column(t('labels.column.from'))[0]!.focus();
    });
    act(() => {
      button(t('labels.remove')).click();
    });
    expect(column(t('labels.column.from')).map((input) => input.value)).toEqual(['3', '1']);
  });
});
