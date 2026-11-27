import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { createPasswordPrompt } from '../documents/passwordRequest';
import { t, tp } from '../i18n/t';
import { RpcError } from '../rpc/client';
import { ReplacePagesDialog, type ReplacePagesDialogProps } from './ReplacePagesDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a dialog opens (as the organizer test does).
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) },
  });
}

// A fake engine. combine.probe counts the file's pages (`pages`), or refuses a locked file with
// `locked` until that password is sent. pages.replace answers with the source's page count as the
// history step; `refuse` makes it refuse with a reason instead.
function fakeRpc(options: { pages?: number; locked?: string; refuse?: string } = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const rpc = {
    call: vi.fn((method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      // combine.probe takes the password at the top level, actions.run inside its args.
      const password =
        method === 'actions.run'
          ? ((params.args as { password?: string | null }).password ?? null)
          : (params.password ?? null);
      if (method === 'combine.probe') {
        if (options.locked !== undefined && password !== options.locked) {
          return Promise.reject(new RpcError('PASSWORD_REQUIRED', 'password protected'));
        }
        return Promise.resolve({ page_count: options.pages ?? 2, encrypted: false });
      }
      if (method === 'actions.run') {
        if (options.locked !== undefined && password !== options.locked) {
          return Promise.reject(new RpcError('PASSWORD_REQUIRED', 'password protected'));
        }
        if (options.refuse !== undefined) {
          return Promise.reject(new RpcError('REFUSED', 'refused', { reason: options.refuse }));
        }
        return Promise.resolve({
          label: 'Replace Pages',
          executed: true,
          value: null,
          changed: null,
          state: { history: 7 },
        });
      }
      return Promise.reject(new Error(`unexpected ${method}`));
    }),
  };
  return { rpc: rpc as unknown as PageRpc, calls };
}

let host: HTMLDivElement;
let root: Root;

function render(props: Partial<ReplacePagesDialogProps>): ReplacePagesDialogProps {
  const full: ReplacePagesDialogProps = {
    isOpen: true,
    onClose: vi.fn(),
    rpc: fakeRpc().rpc,
    handle: 'h1',
    picked: [0],
    total: 5,
    onReplaced: vi.fn(),
    prompt: createPasswordPrompt(),
    ...props,
  };
  act(() => root.render(<ReplacePagesDialog {...full} />));
  return full;
}

function pdf(name = 'source.pdf', size = 10): File {
  return new File([new Uint8Array(size)], name, { type: 'application/pdf' });
}

// Picks a file through the dialog's hidden file input, as the Choose file button leads to.
async function choose(file: File): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input');
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => {});
}

function rangeInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('.replace-range input');
  if (input === null) throw new Error('no range field');
  return input;
}

function typeRange(text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(rangeInput(), text);
    rangeInput().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function replaceButton(): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === t('replace.submit'),
  );
  if (found === undefined) throw new Error('no Replace button');
  return found;
}

function alerts(): string[] {
  return [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent ?? '');
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

describe('ReplacePagesDialog', () => {
  it('counts the chosen file and fills the source range from the selection', async () => {
    const { rpc, calls } = fakeRpc({ pages: 4 });
    render({ rpc, picked: [0, 1, 2] });
    await choose(pdf());
    expect(calls.map((c) => c.method)).toEqual(['combine.probe']);
    expect(rangeInput().value).toBe('1-3');
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      t('replace.summary', {
        target: tp('replace.count', 3),
        source: tp('replace.count', 3),
      }),
    );
  });

  it('replaces with one pages.replace call, then reports the count and history', async () => {
    const { rpc, calls } = fakeRpc({ pages: 5 });
    const props = render({ rpc, picked: [0], total: 5 });
    await choose(pdf());
    typeRange('2-3');
    await act(async () => {
      replaceButton().click();
    });
    await act(async () => {});
    const run = calls.find((c) => c.method === 'actions.run');
    expect(run?.params).toMatchObject({
      handle: 'h1',
      name: 'pages.replace',
      args: { pages: [0], source_pages: [1, 2], password: null },
    });
    expect(props.onReplaced).toHaveBeenCalledWith(2, 7);
  });

  it('a bad range blocks Replace and says the page count', async () => {
    const { rpc, calls } = fakeRpc({ pages: 2 });
    render({ rpc });
    await choose(pdf());
    typeRange('9');
    expect(alerts()).toContain(t('replace.rangeProblem', { count: 2 }));
    expect(replaceButton().disabled).toBe(true);
    expect(calls.some((c) => c.method === 'actions.run')).toBe(false);
  });

  it('a refusal shows inside the dialog, which stays open', async () => {
    const { rpc } = fakeRpc({ pages: 2, refuse: 'invalid_source_pages' });
    const props = render({ rpc });
    await choose(pdf());
    await act(async () => {
      replaceButton().click();
    });
    await act(async () => {});
    expect(alerts()).toContain(t('error.REFUSED.invalidSourcePages'));
    expect(props.onReplaced).not.toHaveBeenCalled();
  });

  it('asks for the password of a locked file, then uses it for the replace', async () => {
    const { rpc, calls } = fakeRpc({ pages: 2, locked: 'secret' });
    const prompt = createPasswordPrompt();
    const props = render({ rpc, prompt });
    await choose(pdf());
    await act(async () => {
      prompt.answer('secret');
    });
    await act(async () => {});
    expect(rangeInput().value).toBe('1-1');
    await act(async () => {
      replaceButton().click();
    });
    await act(async () => {});
    const run = calls.filter((c) => c.method === 'actions.run');
    expect(run.length).toBe(1);
    expect(run[0]?.params.args).toMatchObject({ password: 'secret' });
    expect(props.onReplaced).toHaveBeenCalledTimes(1);
  });

  it('a file over the probe limit is not counted; the range is checked for its form only', async () => {
    const { rpc, calls } = fakeRpc();
    render({ rpc, picked: [0] });
    await choose(pdf('big.pdf', 65 * 1024 * 1024));
    expect(calls.some((c) => c.method === 'combine.probe')).toBe(false);
    expect(rangeInput().value).toBe('1-1');
    expect(replaceButton().disabled).toBe(false);
    typeRange('3-');
    expect(alerts()).toContain(t('replace.rangeUnknown'));
    expect(replaceButton().disabled).toBe(true);
  });

  it('Cancel closes without sending anything', async () => {
    const { rpc, calls } = fakeRpc();
    const props = render({ rpc });
    await choose(pdf());
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === t('organizer.cancel'),
    );
    act(() => cancel?.click());
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.method === 'actions.run')).toBe(false);
  });
});
