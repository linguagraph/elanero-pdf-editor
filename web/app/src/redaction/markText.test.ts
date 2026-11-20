import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createToastStore } from '../feedback/toasts';
import { t, tp } from '../i18n/t';
import type { PageArea } from '../text/textLayer';
import { domSelectionAreas } from '../text/selection';
import { markSelectedText } from './markText';

vi.mock('../text/selection', () => ({ domSelectionAreas: vi.fn(() => [] as PageArea[]) }));

const AREA: PageArea = {
  page: 0,
  rect: { x0: 1, y0: 2, x1: 30, y1: 40 },
  quads: [],
  text: 'jane',
};

function fakeController(busy = false, added = 1) {
  return {
    getSnapshot: () => ({ busy }),
    markAreas: vi.fn(async () => added),
  };
}

function fakeSelection() {
  return { removeAllRanges: vi.fn() } as unknown as Selection & {
    removeAllRanges: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  vi.mocked(domSelectionAreas).mockReturnValue([]);
});

describe('markSelectedText (W4.12 S2)', () => {
  it('shows an info message and marks nothing with no selected text', async () => {
    const store = createToastStore();
    const controller = fakeController();
    await markSelectedText({
      controller,
      selection: null,
      lookup: () => undefined,
      store,
    });
    expect(controller.markAreas).not.toHaveBeenCalled();
    const [toast] = store.getState().visible;
    expect(toast?.kind).toBe('info');
    expect(toast?.text).toBe(t('redact.selectTextFirst'));
  });

  it('marks the selection areas, clears the selection and says how many', async () => {
    vi.mocked(domSelectionAreas).mockReturnValue([AREA]);
    const store = createToastStore();
    const controller = fakeController(false, 1);
    const selection = fakeSelection();
    await markSelectedText({ controller, selection, lookup: () => undefined, store });
    expect(controller.markAreas).toHaveBeenCalledWith([AREA]);
    expect(selection.removeAllRanges).toHaveBeenCalledTimes(1);
    const [toast] = store.getState().visible;
    expect(toast?.kind).toBe('success');
    expect(toast?.text).toBe(tp('redact.markedText', 1));
  });

  it('keeps the selection and says nothing when the mark added nothing', async () => {
    vi.mocked(domSelectionAreas).mockReturnValue([AREA]);
    const store = createToastStore();
    const selection = fakeSelection();
    await markSelectedText({
      controller: fakeController(false, 0),
      selection,
      lookup: () => undefined,
      store,
    });
    expect(selection.removeAllRanges).not.toHaveBeenCalled();
    expect(store.getState().visible).toHaveLength(0);
  });

  it('does nothing while an apply runs', async () => {
    vi.mocked(domSelectionAreas).mockReturnValue([AREA]);
    const controller = fakeController(true);
    await markSelectedText({
      controller,
      selection: fakeSelection(),
      lookup: () => undefined,
      store: createToastStore(),
    });
    expect(controller.markAreas).not.toHaveBeenCalled();
  });
});
