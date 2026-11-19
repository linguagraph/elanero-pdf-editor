import { describe, expect, it } from 'vitest';
import { MAX_IN_FLIGHT, type QueueEntry, RenderQueue, requestKey } from './renderQueue';

function entry(page: number, visible: boolean, distance: number, revision = 0): QueueEntry {
  return { request: { page, revision, scaleMilli: 1000, rotation: 0 }, visible, distance };
}

describe('RenderQueue', () => {
  it('allows two requests in flight by default', () => {
    expect(MAX_IN_FLIGHT).toBe(2);
    const queue = new RenderQueue();
    queue.plan([entry(0, true, 0), entry(1, true, 5), entry(2, true, 10)]);
    expect(queue.next()?.page).toBe(0);
    expect(queue.next()?.page).toBe(1);
    expect(queue.next()).toBeNull();
    expect(queue.inFlightCount).toBe(2);
    expect(queue.queuedCount).toBe(1);
  });

  it('sends the next request once one has finished', () => {
    const queue = new RenderQueue();
    queue.plan([entry(0, true, 0), entry(1, true, 5), entry(2, true, 10)]);
    const first = queue.next();
    queue.next();
    queue.finish(requestKey(first!));
    expect(queue.next()?.page).toBe(2);
  });

  it('sends visible pages before prefetch pages', () => {
    const queue = new RenderQueue();
    queue.plan([entry(9, false, 0), entry(3, true, 500)]);
    expect(queue.queuedKeys()[0]).toBe(requestKey(entry(3, true, 500).request));
  });

  it('sends visible pages nearest the viewport centre first', () => {
    const queue = new RenderQueue(10);
    queue.plan([entry(4, true, 300), entry(5, true, 20), entry(6, true, 90)]);
    const order = [queue.next(), queue.next(), queue.next()].map((r) => r?.page);
    expect(order).toEqual([5, 6, 4]);
  });

  it('drops queued requests for pages that left the window before they are sent', () => {
    const queue = new RenderQueue();
    queue.plan([entry(0, true, 0), entry(1, true, 5), entry(2, false, 900)]);
    const dropped = queue.plan([entry(1, true, 5)]);
    expect(dropped).toEqual([
      requestKey(entry(0, true, 0).request),
      requestKey(entry(2, false, 900).request),
    ]);
    expect(queue.queuedKeys()).toEqual([requestKey(entry(1, true, 5).request)]);
  });

  it('does not recall a request already in flight, but marks it unwanted', () => {
    const queue = new RenderQueue();
    queue.plan([entry(0, true, 0)]);
    const key = requestKey(queue.next()!);
    queue.plan([entry(1, true, 5)]);
    expect(queue.isInFlight(key)).toBe(true);
    expect(queue.isWanted(key)).toBe(false);
    expect(queue.isWanted(requestKey(entry(1, true, 5).request))).toBe(true);
  });

  it('does not queue a page that is already in flight', () => {
    const queue = new RenderQueue();
    queue.plan([entry(0, true, 0)]);
    queue.next();
    queue.plan([entry(0, true, 0), entry(1, true, 5)]);
    expect(queue.queuedKeys()).toEqual([requestKey(entry(1, true, 5).request)]);
  });

  it('keeps one entry for a duplicate key, the higher priority one', () => {
    const queue = new RenderQueue();
    queue.plan([entry(2, false, 900), entry(2, true, 1)]);
    expect(queue.queuedCount).toBe(1);
    expect(queue.next()?.page).toBe(2);
  });

  it('treats a new revision as a different request', () => {
    const queue = new RenderQueue();
    queue.plan([entry(0, true, 0, 0)]);
    queue.plan([entry(0, true, 0, 4)]);
    expect(queue.queuedKeys()).toEqual([requestKey(entry(0, true, 0, 4).request)]);
  });
});

describe('RenderQueue tiles', () => {
  it('keys a tile apart from the whole page and from the other tiles', () => {
    const whole = { page: 1, revision: 0, scaleMilli: 1000, rotation: 0 };
    const a = { ...whole, tileX: 0, tileY: 1 };
    const b = { ...whole, tileX: 1, tileY: 1 };
    expect(requestKey(a)).not.toBe(requestKey(whole));
    expect(requestKey(a)).not.toBe(requestKey(b));
  });

  it('drops a queued tile that the next plan no longer wants, before it is sent', () => {
    const queue = new RenderQueue(1);
    const tile = (tileX: number): QueueEntry => ({
      request: { page: 0, revision: 0, scaleMilli: 1000, rotation: 0, tileX, tileY: 0 },
      visible: true,
      distance: tileX,
    });
    queue.plan([tile(0), tile(1), tile(2)]);
    expect(queue.next()?.tileX).toBe(0);
    const dropped = queue.plan([tile(2)]);
    expect(dropped).toEqual([requestKey(tile(1).request)]);
    queue.finish(requestKey(tile(0).request));
    expect(queue.next()?.tileX).toBe(2);
  });
});
