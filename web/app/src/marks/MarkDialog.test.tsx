import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionJobWorker } from '../actionJob/actionJob';
import type { PageRpc } from '../engine/engineConnection';
import { createToastStore, type ToastStore } from '../feedback/toasts';
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

function workerReply(label: string): ActionJobWorker {
  const reply = {
    v: PROTOCOL_VERSION,
    id: 1,
    ok: true,
    result: {
      kind: 'document',
      label,
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

// The stored background: red at half opacity, on page 2 only, read from another tool.
const STORED = {
  found: true,
  pages: [1],
  ranges: '2',
  foreign: true,
  font_dropped: false,
  header_footer: null,
  watermark: null,
  background: { color: { r: 1, g: 0, b: 0 }, opacity: 0.5 },
};

const NOTHING_STORED = {
  found: false,
  pages: [],
  ranges: '',
  foreign: false,
  font_dropped: false,
  header_footer: null,
  watermark: null,
  background: null,
};

const JOBS = {
  'jobs.prepare': (params: unknown) => ({
    token: 'j1',
    label: (params as { args: { name: string } }).args.name,
    mutating: true,
    document: PDF_BYTES.slice(0),
    state: null,
  }),
  'jobs.apply': () => ({
    applied: true,
    changed: { revisions: { '0': 2 }, pages: [0] },
    state: { history: 4 },
  }),
  'jobs.abort': () => ({}),
};

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

// Sets a controlled field the way a user does, so React sees the change.
function typeInto(field: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

function setup(stored: unknown, overrides: Partial<BackgroundDialogProps> = {}) {
  const answers = { ...JOBS, 'marks.get': () => stored };
  const { call, rpc } = fakeEngine(answers);
  const store: ToastStore = createToastStore();
  const onClose = vi.fn();
  const props: BackgroundDialogProps = {
    isOpen: true,
    onClose,
    engine: rpc,
    handle: 'h1',
    startWorker: () => workerReply('Marks'),
    pageCount: 3,
    currentPage: 1,
    signed: false,
    store,
    ...overrides,
  };
  act(() => root.render(<BackgroundDialog {...props} />));
  return { call, store, onClose };
}

// The action names the dialog asked the engine to prepare, in order.
function jobNames(call: ReturnType<typeof fakeEngine>['call']): string[] {
  return call.mock.calls
    .filter(([method]) => method === 'jobs.prepare')
    .map(([, params]) => (params as { args: { name: string } }).args.name);
}

// The arguments of the first prepared job.
function firstJobArgs(call: ReturnType<typeof fakeEngine>['call']): unknown {
  const found = call.mock.calls.find(([method]) => method === 'jobs.prepare');
  return (found?.[1] as { args: { args: unknown } } | undefined)?.args.args;
}

describe('the marks dialog shell', () => {
  it('asks first when the document already has the mark, with Replace focused', async () => {
    setup(STORED);
    await settle();
    expect(document.body.textContent).toContain(
      'This document already has background colour on 1 page.',
    );
    expect(document.activeElement).toBe(buttonNamed('Replace the existing background colour'));
  });

  it('Add New opens an empty form that applies as a new mark', async () => {
    const { call, onClose } = setup(STORED);
    await settle();
    await act(async () => buttonNamed('Add New').click());
    await settle();
    await act(async () => buttonNamed('Apply').click());
    await settle();
    expect(onClose).toHaveBeenCalled();
    expect(firstJobArgs(call)).toMatchObject({ replace_existing: false, pages: [0, 1, 2] });
  });

  it('Replace loads the stored settings and the range, and replaces the old mark', async () => {
    const { call } = setup(STORED);
    await settle();
    await act(async () => buttonNamed('Replace the existing background colour').click());
    await settle();
    expect(document.querySelector('h2')?.textContent).toBe('Update background colour');
    expect(document.body.textContent).toContain(
      'Replaces the one another application added, whose settings cannot be read.',
    );
    expect(document.querySelector<HTMLInputElement>('input[type="color"]')?.value).toBe('#ff0000');
    expect(document.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('50');
    expect(document.querySelector<HTMLInputElement>('.mark-range')?.value).toBe('2');

    await act(async () => buttonNamed('Apply').click());
    await settle();
    expect(firstJobArgs(call)).toMatchObject({
      replace_existing: true,
      pages: [1],
      opacity: 0.5,
    });
  });

  it('Remove runs marks.remove with no further question and offers Undo', async () => {
    const { call, store, onClose } = setup(STORED);
    await settle();
    await act(async () => buttonNamed('Remove').click());
    await settle();
    expect(onClose).toHaveBeenCalled();
    expect(jobNames(call)).toEqual(['marks.remove']);
    const toast = store.getState().visible[0];
    expect(toast?.text).toBe('Removed background colour from 1 page.');
    expect(toast?.action).toBeDefined();
  });

  it('a signed document shows its note and the action still runs', async () => {
    const { call } = setup(NOTHING_STORED, { signed: true });
    await settle();
    expect(document.body.textContent).toContain('This document is signed.');
    await act(async () => buttonNamed('Apply').click());
    await settle();
    expect(jobNames(call)).toEqual(['marks.background']);
  });

  it('an invalid page range shows the alert, marks the field and blocks Apply', async () => {
    setup(NOTHING_STORED);
    await settle();
    await act(async () => {
      document.querySelectorAll<HTMLInputElement>('input[type="radio"]')[2]?.click();
    });
    const range = document.querySelector<HTMLInputElement>('.mark-range');
    await act(async () => {
      if (range) typeInto(range, 'nine');
    });
    expect(range?.getAttribute('aria-invalid')).toBe('true');
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe('Enter pages such as 1-3, 5, inside the document.');
    expect(range?.getAttribute('aria-describedby')).toBe(alert?.id);
    expect(buttonNamed('Apply').disabled).toBe(true);
  });

  it('Escape closes without running anything', async () => {
    const { call, onClose } = setup(STORED);
    await settle();
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    await settle();
    expect(onClose).toHaveBeenCalled();
    expect(jobNames(call)).toEqual([]);
  });
});
