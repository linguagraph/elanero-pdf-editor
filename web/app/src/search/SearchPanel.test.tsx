import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import type { SearchHitDto } from '../rpc/generated';
import { SearchPanel } from './SearchPanel';
import type { SearchMarks } from './search';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function hit(page: number, context: string): SearchHitDto {
  return {
    page,
    text: 'cat',
    context,
    quads: [
      {
        ul: { x: 10, y: 20 },
        ur: { x: 40, y: 20 },
        ll: { x: 10, y: 32 },
        lr: { x: 40, y: 32 },
      },
    ],
  };
}

function slice(hits: SearchHitDto[], pagesDone: number, done: boolean) {
  return { hits, cursor: done ? null : `c${pagesDone}`, pages_done: pagesDone, total: 4, done };
}

// A fake engine for text.search. It yields the scripted slices in order and stops when the signal is
// aborted. With `hang`, it waits after the last slice until it is stopped, as a long search does.
async function* scripted(
  signal: AbortSignal,
  slices: unknown[],
  hang: boolean,
): AsyncGenerator<unknown, void, undefined> {
  for (const next of slices) {
    if (signal.aborted) return;
    yield next;
  }
  if (hang) {
    await new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('stopped')));
    });
  }
}

function fakeRpc(slices: unknown[], hang = false) {
  const chunked = vi.fn((_method: string, _params: unknown, options?: { signal?: AbortSignal }) =>
    scripted(options?.signal ?? new AbortController().signal, slices, hang),
  );
  return { rpc: { chunked } as unknown as Pick<PageRpc, 'chunked'>, chunked };
}

let host: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function typeQuery(value: string): void {
  const input = host.querySelector<HTMLInputElement>('input[type="search"]');
  if (input === null) throw new Error('no search input');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function submit(): void {
  const form = host.querySelector('form');
  form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

function buttonNamed(name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === name,
  );
  if (found === undefined) throw new Error(`no button ${name}`);
  return found;
}

function statusText(): string {
  return host.querySelector('.search-status')?.textContent ?? '';
}

function resultTexts(): string[] {
  return [...host.querySelectorAll('.search-results li button')].map(
    (button) => button.textContent ?? '',
  );
}

interface Spies {
  onMarks: ReturnType<typeof vi.fn<(marks: SearchMarks | null) => void>>;
  onGoTo: ReturnType<typeof vi.fn<(page: number) => void>>;
  onClose: ReturnType<typeof vi.fn<() => void>>;
}

function render(rpc: Pick<PageRpc, 'chunked'>): Spies {
  const spies: Spies = {
    onMarks: vi.fn<(marks: SearchMarks | null) => void>(),
    onGoTo: vi.fn<(page: number) => void>(),
    onClose: vi.fn<() => void>(),
  };
  act(() => {
    root.render(
      <SearchPanel
        rpc={rpc}
        handle="doc-1"
        onMarks={spies.onMarks}
        onGoTo={spies.onGoTo}
        onClose={spies.onClose}
      />,
    );
  });
  return spies;
}

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
});

describe('SearchPanel', () => {
  const twoPages = [
    slice([hit(0, '[cat] on the mat')], 2, false),
    slice([hit(2, 'a [cat]')], 4, true),
  ];

  it('lists the hits in page order, with the page and the context of each', async () => {
    const { rpc, chunked } = fakeRpc(twoPages);
    const spies = render(rpc);
    typeQuery('cat');
    submit();
    await flush();
    expect(chunked).toHaveBeenCalledWith(
      'text.search',
      expect.objectContaining({
        handle: 'doc-1',
        query: 'cat',
        options: { case_sensitive: false, whole_word: false, regex: false },
      }),
      expect.any(Object),
    );
    expect(resultTexts()).toEqual(['Page 1[cat] on the mat', 'Page 3a [cat]']);
    expect(statusText()).toBe('1 of 2 matches');
    // The first hit is selected and its page is shown.
    expect(spies.onGoTo).toHaveBeenCalledWith(0);
    expect(spies.onMarks).toHaveBeenLastCalledWith({ hits: expect.any(Array), current: 0 });
  });

  it('moves the selected hit with next and previous, and wraps', async () => {
    const { rpc } = fakeRpc(twoPages);
    const spies = render(rpc);
    typeQuery('cat');
    submit();
    await flush();
    act(() => buttonNamed('Next match').click());
    expect(statusText()).toBe('2 of 2 matches');
    expect(spies.onGoTo).toHaveBeenLastCalledWith(2);
    act(() => buttonNamed('Next match').click());
    expect(statusText()).toBe('1 of 2 matches');
    act(() => buttonNamed('Previous match').click());
    expect(statusText()).toBe('2 of 2 matches');
    expect(spies.onGoTo).toHaveBeenLastCalledWith(2);
  });

  it('does not send an empty query', async () => {
    const { rpc, chunked } = fakeRpc(twoPages);
    render(rpc);
    submit();
    await flush();
    expect(chunked).not.toHaveBeenCalled();
    expect(statusText()).toBe('');
  });

  it('reports no matches when the search finds none', async () => {
    const { rpc } = fakeRpc([slice([], 4, true)]);
    render(rpc);
    typeQuery('dog');
    submit();
    await flush();
    expect(statusText()).toBe('No matches.');
    expect(buttonNamed('Next match').disabled).toBe(true);
  });

  it('sends the options that are ticked', async () => {
    const { rpc, chunked } = fakeRpc([slice([], 4, true)]);
    render(rpc);
    const boxes = host.querySelectorAll<HTMLInputElement>('.search-options input');
    act(() => boxes[0]?.click());
    act(() => boxes[2]?.click());
    typeQuery('c.t');
    submit();
    await flush();
    expect(chunked).toHaveBeenCalledWith(
      'text.search',
      expect.objectContaining({
        options: { case_sensitive: true, whole_word: false, regex: true },
      }),
      expect.any(Object),
    );
  });

  it('stops after the slice in flight when Stop is pressed, and keeps the hits found', async () => {
    const { rpc, chunked } = fakeRpc([slice([hit(0, '[cat] one')], 1, false)], true);
    const spies = render(rpc);
    typeQuery('cat');
    submit();
    await flush();
    expect(statusText()).toBe('Searching… page 1 of 4');
    act(() => buttonNamed('Stop').click());
    await flush();
    expect(statusText()).toBe('Search stopped. 1 match found so far.');
    expect(resultTexts()).toEqual(['Page 1[cat] one']);
    expect(chunked).toHaveBeenCalledTimes(1);
    expect(spies.onMarks).toHaveBeenLastCalledWith({ hits: expect.any(Array), current: 0 });
  });

  it('stops a running search when the panel is closed', async () => {
    const { rpc, chunked } = fakeRpc([slice([hit(0, 'x')], 1, false)], true);
    const spies = render(rpc);
    typeQuery('cat');
    submit();
    await flush();
    const signal = chunked.mock.calls[0]?.[2]?.signal;
    act(() => root.unmount());
    expect(signal?.aborted).toBe(true);
    expect(spies.onMarks).toHaveBeenLastCalledWith(null);
    root = createRoot(host);
  });
});
