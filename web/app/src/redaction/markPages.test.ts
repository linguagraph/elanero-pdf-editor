import { describe, expect, it, vi } from 'vitest';
import { createToastStore } from '../feedback/toasts';
import { tp } from '../i18n/t';
import type { PageSize } from '../rpc/generated';
import type { PageArea } from '../text/textLayer';
import { markWholePages } from './markPages';

const SIZES: PageSize[] = [
  { width: 612, height: 792, rotation: 0 },
  { width: 595, height: 842, rotation: 0 },
];

function fakeController(busy = false, added = 2) {
  return {
    getSnapshot: () => ({ busy }),
    markAreas: vi.fn<(areas: readonly PageArea[]) => Promise<number>>(async () => added),
  };
}

describe('markWholePages', () => {
  it('sends one page-sized area per chosen page and reports the count', async () => {
    const controller = fakeController();
    const store = createToastStore();
    const done = await markWholePages({ controller, store }, [0, 1], SIZES);
    expect(done).toBe(true);
    const areas = controller.markAreas.mock.calls[0]?.[0];
    expect(areas?.map((area) => [area.page, area.rect.x1, area.rect.y1])).toEqual([
      [0, 612, 792],
      [1, 595, 842],
    ]);
    expect(store.getState().visible[0]?.text).toBe(tp('redact.markedPages', 2));
  });

  it('sends nothing while an apply runs', async () => {
    const controller = fakeController(true);
    expect(await markWholePages({ controller }, [0], SIZES)).toBe(false);
    expect(controller.markAreas).not.toHaveBeenCalled();
  });

  it('sends nothing for no pages, and shows no toast when no mark was added', async () => {
    const controller = fakeController(false, 0);
    const store = createToastStore();
    expect(await markWholePages({ controller, store }, [], SIZES)).toBe(false);
    expect(controller.markAreas).not.toHaveBeenCalled();
    expect(await markWholePages({ controller, store }, [0], SIZES)).toBe(false);
    expect(store.getState().visible).toHaveLength(0);
  });
});
