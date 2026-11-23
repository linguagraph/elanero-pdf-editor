import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SelectionSnapshot } from '../translate/runTranslation';
import { SelectionToolbar } from './SelectionToolbar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The toolbar (W6.6 section 8) shows beside the last highlight of a selection, so the tests draw
// one: anchorRect reads a `.page-selection-mark` before it reads the browser's selection.
const SNAPSHOT: SelectionSnapshot = { text: 'Hello world', areas: [] };

interface Current {
  snapshot: SelectionSnapshot | null;
}

let host: HTMLDivElement;
let root: Root;
let mark: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  mark = document.createElement('div');
  mark.className = 'page-selection-mark';
  document.body.append(mark);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  mark.remove();
  vi.restoreAllMocks();
});

// The selection changes: the browser fires selectionchange on the document.
function selectionChanged(): void {
  act(() => {
    document.dispatchEvent(new Event('selectionchange'));
  });
}

function render(current: Current, onCopy = vi.fn(), onTranslate = vi.fn()) {
  act(() => {
    root.render(
      <SelectionToolbar read={() => current.snapshot} onCopy={onCopy} onTranslate={onTranslate} />,
    );
  });
  return { onCopy, onTranslate };
}

function toolbar(): HTMLElement | null {
  return document.querySelector('[role="toolbar"]');
}

function buttonNamed(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent === label);
  if (found === undefined) throw new Error(`no button ${label}`);
  return found;
}

describe('SelectionToolbar', () => {
  it('shows for a selection', () => {
    const current: Current = { snapshot: SNAPSHOT };
    render(current);
    selectionChanged();
    expect(toolbar()).not.toBeNull();
  });

  it('has Copy and Translate, which act on the selected text', () => {
    const current: Current = { snapshot: SNAPSHOT };
    const { onCopy, onTranslate } = render(current);
    selectionChanged();
    expect(buttonNamed('Copy')).toBeDefined();
    expect(buttonNamed('Translate')).toBeDefined();
    act(() => buttonNamed('Copy').click());
    expect(onCopy).toHaveBeenCalledWith('Hello world');
    act(() => buttonNamed('Translate').click());
    expect(onTranslate).toHaveBeenCalledWith(expect.objectContaining({ text: 'Hello world' }));
  });

  it('hides when the selection is cleared', () => {
    const current: Current = { snapshot: SNAPSHOT };
    render(current);
    selectionChanged();
    expect(toolbar()).not.toBeNull();
    current.snapshot = null;
    selectionChanged();
    expect(toolbar()).toBeNull();
  });
});
