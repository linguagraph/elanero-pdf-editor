import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionJobWorker } from '../actionJob/actionJob';
import type { PageRpc } from '../engine/engineConnection';
import { createToastStore } from '../feedback/toasts';
import { PROTOCOL_VERSION } from '../rpc/generated';
import { BackgroundDialog, type BackgroundDialogProps } from './BackgroundDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: {
      escape: (value: string) => value.replace(/[^\w-]/g, (char) => String.fromCharCode(92) + char),
    },
  });
}

const PDF_BYTES = new Uint8Array([37, 80, 68, 70]).buffer;

// The worker's reply to job.run: a mutating job returns its document as the one binary value.
function workerReply(): ActionJobWorker {
  const reply = {
    v: PROTOCOL_VERSION,
    id: 1,
    ok: true,
    result: {
      kind: 'document',
      label: 'Add Background',
      require_full_save: true,
      document: { $bin: 0 },
      files: [],
      value: null,
      name: '',
    },
    events: [],
  };
  return {
    call: vi.fn(async () => ({ reply: JSON.stringify(reply), buffer: PDF_BYTES.slice(0) })),
    terminate: vi.fn(),
  };
}

const NO_MARKS = { found: false, pages: [], ranges: '', foreign: false };

const READY = {
  'marks.get': () => NO_MARKS,
  'jobs.prepare': () => ({
    token: 'j1',
    label: 'marks.background',
    mutating: true,
    document: PDF_BYTES.slice(0),
    state: null,
  }),
  'jobs.apply': () => ({
    applied: true,
    changed: { revisions: { '0': 2 }, pages: [0, 1, 2] },
    state: { history: 4 },
  }),
  'jobs.abort': () => ({}),
};

// Sets a controlled field the way a user does, so React sees the change.
function typeInto(field: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

// A fake engine: each method answers from the table, and every call is recorded.
function fakeEngine(answers: Record<string, (params: unknown) => unknown>) {
  const call = vi.fn(async (method: string, params: unknown) => {
    const answer = answers[method];
    if (answer === undefined) throw new Error(`no answer for ${method}`);
    return answer(params);
  });
  return { call, rpc: { call, chunked: vi.fn() } as unknown as PageRpc };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// Lets the promises settle, inside act so React sees the updates.
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function buttonNamed(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === text,
  );
  if (found === undefined) throw new Error(`no button "${text}"`);
  return found;
}

function setup(
  answers: Record<string, (params: unknown) => unknown> = READY,
  overrides: Partial<BackgroundDialogProps> = {},
) {
  const { call, rpc } = fakeEngine(answers);
  const store = createToastStore();
  const onClose = vi.fn();
  const onChanged = vi.fn();
  const props: BackgroundDialogProps = {
    isOpen: true,
    onClose,
    engine: rpc,
    handle: 'h1',
    startWorker: () => workerReply(),
    pageCount: 3,
    currentPage: 2,
    signed: false,
    onChanged,
    store,
    ...overrides,
  };
  act(() => root.render(<BackgroundDialog {...props} />));
  return { call, store, onClose, onChanged };
}

// The job the dialog asked the engine to prepare: the action name and its arguments.
function preparedJob(call: ReturnType<typeof fakeEngine>['call']) {
  const found = call.mock.calls.find(([method]) => method === 'jobs.prepare');
  return (found?.[1] as { args: { name: string; args: unknown } } | undefined)?.args;
}

describe('the background dialog', () => {
  it('opens with the desktop defaults and sends them for every page', async () => {
    const { call, onClose } = setup();
    await settle();
    const color = document.querySelector<HTMLInputElement>('input[type="color"]');
    const opacity = document.querySelector<HTMLInputElement>('input[type="number"]');
    expect(color?.value).toBe('#ffffe6');
    expect(opacity?.value).toBe('100');

    await act(async () => buttonNamed('Apply').click());
    await settle();
    expect(onClose).toHaveBeenCalled();
    expect(preparedJob(call)).toEqual({
      name: 'marks.background',
      args: {
        color: { r: 1, g: 1, b: 230 / 255 },
        opacity: 1,
        pages: [0, 1, 2],
        replace_existing: false,
      },
    });
  });

  it('sends the current page when that scope is chosen', async () => {
    const { call } = setup();
    await settle();
    await act(async () => {
      [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')][1]?.click();
    });
    await act(async () => buttonNamed('Apply').click());
    await settle();
    expect(preparedJob(call)?.args).toMatchObject({ pages: [1] });
  });

  it('refuses an opacity outside 5 to 100 and says why', async () => {
    setup();
    await settle();
    const opacity = document.querySelector<HTMLInputElement>('input[type="number"]');
    await act(async () => {
      if (opacity) typeInto(opacity, '0');
    });
    expect(buttonNamed('Apply').disabled).toBe(true);
    expect(document.body.textContent).toContain('Enter a value inside the range shown.');
  });
});
