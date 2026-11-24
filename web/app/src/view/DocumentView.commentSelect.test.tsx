// After a comment is added the view returns to Select and selects the new comment (W7.1a
// Question 3): the tool button is released, the page's comment layer goes, and the comment gets
// its selection outline.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { t } from '../i18n/t';
import { COMMENT_TOOL_LABEL } from '../comments/tools';
import { PREFS_STORAGE_KEY } from '../prefs/store';
import { DocumentView } from './DocumentView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NAME = 'square-1';
const RECT = { x0: 300, y0: 396, x1: 320, y1: 416 };

// One comment as comments.page sends it (PageCommentDto).
const comment = () => ({
  page: 0,
  name: NAME,
  type: 'Square',
  author: '',
  contents: '',
  subject: '',
  created: null,
  modified: null,
  state: 'None',
  locked: false,
  rect: RECT,
  bounds: RECT,
});

// The engine: one page; annotations.create adds the note and comments.page lists it from then on.
function fakeRpc(): { rpc: PageRpc; calls: () => string[] } {
  const seen: string[] = [];
  let placed = false;
  const rpc = {
    call: vi.fn(async (method: string) => {
      seen.push(method);
      if (method === 'session.pages') {
        return { pages: [{ width: 612, height: 792, rotation: 0 }], labels: [] };
      }
      if (method === 'actions.run') {
        placed = true;
        return {
          label: 'Add Rectangle',
          executed: true,
          value: [{ page: 0, name: NAME }],
          changed: { changes: [], revisions: { '0': 1 } },
          state: { history: 1 },
        };
      }
      if (method === 'comments.page') {
        const threads = placed ? [{ comment: comment(), replies: [] }] : [];
        return { page: 0, revision: placed ? 1 : 0, threads };
      }
      return new Promise(() => {});
    }),
  };
  return { rpc: rpc as unknown as PageRpc, calls: () => seen };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify({ defaultZoom: '100' }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('a comment that is added', () => {
  it('returns the view to Select and selects the new comment', async () => {
    const { rpc, calls } = fakeRpc();
    const onToolChange = vi.fn();
    act(() => root.render(<DocumentView rpc={rpc} handle="h" onToolChange={onToolChange} />));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const note = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === t(COMMENT_TOOL_LABEL.rectangle),
    );
    if (note === undefined) throw new Error('no rectangle tool');
    act(() => note.click());
    expect(note.getAttribute('aria-pressed')).toBe('true');
    const layer = host.querySelector<HTMLElement>('.comment-layer');
    if (layer === null) throw new Error('no comment layer');
    await act(async () => {
      layer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(calls()).toContain('actions.run');
    expect(onToolChange.mock.calls.at(-1)?.[0]).toBe('select');
    expect(note.getAttribute('aria-pressed')).toBe('false');
    expect(host.querySelector('.comment-layer')).toBeNull();
    expect(host.querySelectorAll('.comment-select-outline')).toHaveLength(1);
  });
});
