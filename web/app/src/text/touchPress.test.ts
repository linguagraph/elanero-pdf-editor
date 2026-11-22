import { describe, expect, it } from 'vitest';
import { IDLE, stepTouch, TOUCH_HIT_PX, TOUCH_SLOP_PX, touchHitPoints } from './touchPress';

const press = { type: 'press', pointerId: 1, x: 100, y: 100, onText: true } as const;
const pending = stepTouch(IDLE, press).gesture;
const selecting = stepTouch(pending, { type: 'timer' }).gesture;

describe('touchPress', () => {
  it('a press on text arms the timer and waits, without selecting', () => {
    expect(stepTouch(IDLE, press)).toEqual({
      gesture: { phase: 'pending', pointerId: 1, x: 100, y: 100 },
      effect: 'arm',
    });
  });

  it('a press off text does nothing', () => {
    expect(stepTouch(IDLE, { ...press, onText: false })).toEqual({ gesture: IDLE, effect: 'none' });
  });

  it('the timer selects the word and enters selecting', () => {
    expect(stepTouch(pending, { type: 'timer' })).toEqual({
      gesture: { phase: 'selecting', pointerId: 1 },
      effect: 'selectWord',
    });
  });

  it('a contextmenu before the timer selects the word too', () => {
    expect(stepTouch(pending, { type: 'contextmenu' })).toEqual({
      gesture: { phase: 'selecting', pointerId: 1 },
      effect: 'selectWord',
    });
  });

  it('a move within the slop keeps waiting; past it is a scroll', () => {
    const within = { type: 'move', pointerId: 1, x: 100 + TOUCH_SLOP_PX, y: 100 } as const;
    expect(stepTouch(pending, within).gesture).toBe(pending);
    const past = { type: 'move', pointerId: 1, x: 100 + TOUCH_SLOP_PX + 1, y: 100 } as const;
    expect(stepTouch(pending, past)).toEqual({ gesture: IDLE, effect: 'stop' });
  });

  it('a diagonal move is measured as a distance', () => {
    const diagonal = { type: 'move', pointerId: 1, x: 106, y: 106 } as const;
    expect(stepTouch(pending, diagonal).effect).toBe('stop');
  });

  it('a lift before the hold is a tap', () => {
    expect(stepTouch(pending, { type: 'up', pointerId: 1 })).toEqual({
      gesture: IDLE,
      effect: 'tap',
    });
  });

  it('pointercancel before the hold stops with nothing selected', () => {
    expect(stepTouch(pending, { type: 'cancel', pointerId: 1 })).toEqual({
      gesture: IDLE,
      effect: 'stop',
    });
  });

  it('a second pointer during the hold is a pinch and cancels it', () => {
    expect(stepTouch(pending, { type: 'second' })).toEqual({ gesture: IDLE, effect: 'stop' });
  });

  it('the stale timer after a cancel does nothing', () => {
    const cancelled = stepTouch(pending, { type: 'cancel', pointerId: 1 }).gesture;
    expect(stepTouch(cancelled, { type: 'timer' })).toEqual({ gesture: IDLE, effect: 'none' });
  });

  it('a move of another pointer does not touch the gesture', () => {
    expect(stepTouch(pending, { type: 'move', pointerId: 2, x: 999, y: 999 }).gesture).toBe(
      pending,
    );
    expect(stepTouch(pending, { type: 'up', pointerId: 2 }).gesture).toBe(pending);
  });

  it('while selecting, a move extends and a lift ends with the selection kept', () => {
    expect(stepTouch(selecting, { type: 'move', pointerId: 1, x: 300, y: 300 })).toEqual({
      gesture: selecting,
      effect: 'extend',
    });
    expect(stepTouch(selecting, { type: 'up', pointerId: 1 })).toEqual({
      gesture: IDLE,
      effect: 'end',
    });
  });

  it('while selecting, a move of any distance is an extend, not a scroll', () => {
    expect(stepTouch(selecting, { type: 'move', pointerId: 1, x: 900, y: 900 }).effect).toBe(
      'extend',
    );
  });

  it('while selecting, pointercancel and a second pointer end without clearing', () => {
    expect(stepTouch(selecting, { type: 'cancel', pointerId: 1 })).toEqual({
      gesture: IDLE,
      effect: 'stop',
    });
    expect(stepTouch(selecting, { type: 'second' })).toEqual({ gesture: IDLE, effect: 'stop' });
  });

  it('while selecting, the timer and a contextmenu change nothing', () => {
    expect(stepTouch(selecting, { type: 'timer' }).effect).toBe('none');
    expect(stepTouch(selecting, { type: 'contextmenu' }).effect).toBe('none');
  });

  it('the hit tolerance is 12 CSS px at any zoom, in points', () => {
    expect((touchHitPoints(1) * 4) / 3).toBeCloseTo(TOUCH_HIT_PX);
    expect((touchHitPoints(2) * 2 * 4) / 3).toBeCloseTo(TOUCH_HIT_PX);
  });
});
