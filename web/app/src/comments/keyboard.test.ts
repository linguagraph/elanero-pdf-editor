import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  arrowStep,
  centredPlacement,
  movedBox,
  NudgeQueue,
  nudgeMergeKey,
  resizedCornerBox,
} from './keyboard';

describe('keyboard placement', () => {
  it('a note opens its form at the centre of the page', () => {
    expect(centredPlacement('note', 612, 792)).toEqual({
      kind: 'text',
      rect: { x0: 306, y0: 396, x1: 306, y1: 396 },
      tip: null,
    });
  });

  it('a box tool places its default 100 by 60 box at once', () => {
    expect(centredPlacement('rectangle', 612, 792)).toEqual({
      kind: 'place',
      rect: { x0: 256, y0: 366, x1: 356, y1: 426 },
      points: [],
    });
  });

  it('a text box opens its form over the same default box', () => {
    expect(centredPlacement('textbox', 612, 792)).toEqual({
      kind: 'text',
      rect: { x0: 256, y0: 366, x1: 356, y1: 426 },
      tip: null,
    });
  });

  it('a line places a 100 pt line through the centre, its two ends as the points', () => {
    expect(centredPlacement('arrow', 612, 792)).toEqual({
      kind: 'place',
      rect: { x0: 256, y0: 396, x1: 356, y1: 396 },
      points: [
        { x: 256, y: 396 },
        { x: 356, y: 396 },
      ],
    });
  });

  it('a callout opens its form over the box, with its tip 40 pt left of the box', () => {
    expect(centredPlacement('callout', 612, 792)).toEqual({
      kind: 'text',
      rect: { x0: 256, y0: 366, x1: 356, y1: 426 },
      tip: { x: 216, y: 396 },
    });
  });

  it('pen, polygon and polyline have no keyboard placement', () => {
    expect(centredPlacement('pen', 612, 792)).toBeNull();
    expect(centredPlacement('polygon', 612, 792)).toBeNull();
    expect(centredPlacement('polyline', 612, 792)).toBeNull();
  });
});

describe('arrow steps and merge keys', () => {
  it('an arrow moves 1 pt, Shift 10 pt, in the arrow direction; other keys have no step', () => {
    expect(arrowStep('ArrowLeft', false)).toEqual({ dx: -1, dy: 0 });
    expect(arrowStep('ArrowDown', true)).toEqual({ dx: 0, dy: 10 });
    expect(arrowStep('Enter', false)).toBeNull();
  });

  it('a move and a resize of one comment have different merge keys', () => {
    const ref = { page: 2, name: 'n7' };
    expect(nudgeMergeKey(ref, 1, false)).toBe('nudge:2:n7:1');
    expect(nudgeMergeKey(ref, 1, true)).toBe('nudge:2:n7:1:resize');
  });
});

describe('holds and merge keys', () => {
  const ref = { page: 2, name: 'n7' };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('two presses with a keyup between them are two steps: different merge keys', () => {
    const queue = new NudgeQueue();
    const first = nudgeMergeKey(ref, queue.press('n7'), false);
    queue.release('n7');
    const second = nudgeMergeKey(ref, queue.press('n7'), false);
    expect(first).not.toBe(second);
  });

  it('presses with no keyup but a gap over 500 ms are two steps: different merge keys', () => {
    vi.useFakeTimers();
    const queue = new NudgeQueue();
    const first = nudgeMergeKey(ref, queue.press('n7'), false);
    vi.advanceTimersByTime(501);
    const second = nudgeMergeKey(ref, queue.press('n7'), false);
    expect(first).not.toBe(second);
  });

  it('rapid presses in one hold share a merge key', () => {
    vi.useFakeTimers();
    const queue = new NudgeQueue();
    const keys: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      keys.push(nudgeMergeKey(ref, queue.press('n7'), false));
      vi.advanceTimersByTime(40);
    }
    expect(new Set(keys).size).toBe(1);
  });

  it('a press at a gap of exactly 500 ms still belongs to the hold', () => {
    vi.useFakeTimers();
    const queue = new NudgeQueue();
    const first = queue.press('n7');
    vi.advanceTimersByTime(500);
    expect(queue.press('n7')).toBe(first);
  });

  it('a resize of a held move keeps its own merge key within the same hold', () => {
    vi.useFakeTimers();
    const queue = new NudgeQueue();
    const hold = queue.press('n7');
    expect(nudgeMergeKey(ref, hold, true)).not.toBe(nudgeMergeKey(ref, hold, false));
  });

  it('the holds of two comments are counted apart', () => {
    const queue = new NudgeQueue();
    expect(queue.press('a')).toBe(1);
    queue.release('a');
    expect(queue.press('a')).toBe(2);
    expect(queue.press('b')).toBe(1);
  });
});

describe('box steps', () => {
  const box = { x0: 10, y0: 10, x1: 30, y1: 20 };

  it('a move shifts every edge', () => {
    expect(movedBox(box, 1, -2)).toEqual({ x0: 11, y0: 8, x1: 31, y1: 18 });
  });

  it('a resize moves the bottom-right corner and keeps the minimum size', () => {
    expect(resizedCornerBox(box, 5, 5)).toEqual({ x0: 10, y0: 10, x1: 35, y1: 25 });
    expect(resizedCornerBox(box, -100, -100)).toEqual({ x0: 10, y0: 10, x1: 14, y1: 14 });
  });
});

describe('NudgeQueue', () => {
  // A step that resolves when the test says so, to hold the queue.
  function gate() {
    let open: (value: boolean) => void = () => undefined;
    const promise = new Promise<boolean>((resolve) => {
      open = resolve;
    });
    return { promise, open };
  }

  it('runs the presses one after another, never two at once', async () => {
    const queue = new NudgeQueue();
    const order: string[] = [];
    const first = gate();
    queue.enqueue(async () => {
      order.push('a-start');
      const ok = await first.promise;
      order.push('a-end');
      return ok;
    });
    queue.enqueue(async () => {
      order.push('b');
      return true;
    });
    await Promise.resolve();
    expect(order).toEqual(['a-start']);
    expect(queue.idle()).toBe(false);
    first.open(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['a-start', 'a-end', 'b']);
    expect(queue.idle()).toBe(true);
  });

  it('reset drops the presses still waiting', async () => {
    const queue = new NudgeQueue();
    const first = gate();
    const ran = vi.fn();
    queue.enqueue(() => first.promise);
    queue.enqueue(async () => {
      ran();
      return true;
    });
    queue.reset();
    first.open(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ran).not.toHaveBeenCalled();
    expect(queue.idle()).toBe(true);
  });

  it('keeps the box of a hold until the list is read again', () => {
    const queue = new NudgeQueue();
    const fallback = { x0: 0, y0: 0, x1: 10, y1: 10 };
    expect(queue.boxOf('a', fallback)).toBe(fallback);
    queue.setBox('a', { x0: 1, y0: 1, x1: 11, y1: 11 });
    expect(queue.boxOf('a', fallback)).toEqual({ x0: 1, y0: 1, x1: 11, y1: 11 });
    queue.clearBoxes();
    expect(queue.boxOf('a', fallback)).toBe(fallback);
  });
});
