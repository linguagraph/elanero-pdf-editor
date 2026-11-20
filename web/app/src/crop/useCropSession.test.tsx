import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setViewTool, useViewTool, type ViewTool } from '../view/viewTool';
import type { CropValues, DrawnCrop } from './cropChoice';
import { type CropSession, useCropSession } from './useCropSession';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RANGE_VALUES: CropValues = {
  left: '10',
  top: '0',
  right: '0',
  bottom: '0',
  unit: 'pt',
  scope: 'range',
  range: '8-10',
};

const DRAWN: DrawnCrop = { page: 2, margins: { left: 5, top: 6, right: 7, bottom: 8 } };

let host: HTMLDivElement;
let root: Root;
let session: CropSession;
let toolOfTab1: ViewTool;

// The latest commit's session and tab 1's tool, recorded in an effect.
function Harness({ activeId, tabIds }: { activeId: number | null; tabIds: number[] }) {
  const current = useCropSession(activeId, tabIds);
  const tool = useViewTool(1);
  useEffect(() => {
    session = current;
    toolOfTab1 = tool;
  });
  return null;
}

function mount(activeId: number | null, tabIds: number[]): void {
  act(() => {
    root.render(<Harness activeId={activeId} tabIds={tabIds} />);
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  setViewTool(1, 'select');
  mount(1, [1, 2]);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setViewTool(1, 'select');
});

describe('useCropSession', () => {
  it('a reopen after a Cancel starts from the defaults', () => {
    act(() => session.openDialog());
    act(() => session.setValues(RANGE_VALUES));
    act(() => session.close());
    act(() => session.openDialog());
    expect(session.open).toBe(true);
    expect(session.values).toBeUndefined();
  });

  it('a reopen after Draw on page keeps the form and the tool starts on the tab', () => {
    act(() => session.openDialog());
    act(() => session.setValues(RANGE_VALUES));
    act(() => session.drawOnPage());
    expect(session.open).toBe(false);
    expect(toolOfTab1).toBe('cropBox');
    act(() => session.boxEnded(null));
    expect(session.open).toBe(true);
    expect(session.values).toEqual(RANGE_VALUES);
    expect(toolOfTab1).toBe('select');
  });

  it('a successful crop (close) clears the form', () => {
    act(() => session.openDialog());
    act(() => session.setValues(RANGE_VALUES));
    act(() => session.close());
    expect(session.values).toBeUndefined();
  });

  it('a change of tab clears the form and leaves the crop box tool on the tab left', () => {
    act(() => session.openDialog());
    act(() => session.setValues(RANGE_VALUES));
    act(() => session.drawOnPage());
    expect(toolOfTab1).toBe('cropBox');
    mount(2, [1, 2]);
    expect(session.open).toBe(false);
    expect(session.values).toBeUndefined();
    expect(session.drawn).toBeNull();
    expect(toolOfTab1).toBe('select');
  });

  it('choosing Hand after Draw on page clears the form, so Crop opens with the defaults', () => {
    act(() => session.openDialog());
    act(() => session.setValues(RANGE_VALUES));
    act(() => session.drawOnPage());
    act(() => setViewTool(1, 'hand'));
    expect(toolOfTab1).toBe('hand');
    act(() => session.openDialog());
    expect(session.open).toBe(true);
    expect(session.values).toBeUndefined();
    expect(session.scopePage).toBeNull();
  });

  it('a comment or mark tool chosen after Draw on page clears the form too', () => {
    act(() => session.openDialog());
    act(() => session.setValues(RANGE_VALUES));
    act(() => session.drawOnPage());
    act(() => setViewTool(1, 'select'));
    expect(session.values).toBeUndefined();
    expect(session.drawn).toBeNull();
  });

  it('Esc inside the crop box mode keeps the form and the page of the drawn box', () => {
    act(() => session.drawOnPage());
    act(() => session.boxEnded(DRAWN));
    act(() => session.drawOnPage());
    act(() => session.boxEnded(null));
    expect(session.open).toBe(true);
    expect(session.scopePage).toBe(DRAWN.page);
    expect(toolOfTab1).toBe('select');
  });

  it('the scope page is the page of the box drawn, and a close clears it', () => {
    act(() => session.boxEnded(DRAWN));
    expect(session.scopePage).toBe(2);
    act(() => session.close());
    expect(session.scopePage).toBeNull();
  });

  it('keeps a drawn box until the dialog is closed', () => {
    act(() => session.boxEnded(DRAWN));
    expect(session.drawn).toEqual(DRAWN);
    act(() => session.close());
    expect(session.drawn).toBeNull();
  });
});
