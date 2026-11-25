import { afterEach, describe, expect, it, vi } from 'vitest';
import { markLoadStage } from './marks';

describe('markLoadStage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names the mark after the load stage', () => {
    const spy = vi.spyOn(performance, 'mark').mockImplementation(() => ({}) as PerformanceMark);
    markLoadStage('pyodide');
    expect(spy).toHaveBeenCalledWith('elanero:load:pyodide');
  });

  it('never throws when the User Timing API fails', () => {
    vi.spyOn(performance, 'mark').mockImplementation(() => {
      throw new Error('no timing');
    });
    expect(() => markLoadStage('ready')).not.toThrow();
  });
});
