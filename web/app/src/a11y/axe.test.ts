import { afterEach, describe, expect, it } from 'vitest';
import { runAxe } from '../test/axe';

// The helper must actually report a violation, or every component check above passes for free.
describe('runAxe', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('reports a serious violation with its rule id, impact and HTML', async () => {
    document.body.innerHTML = '<div id="probe"><button></button></div>';
    const { blocking, advisory } = await runAxe(document.getElementById('probe') as Element);
    expect(blocking).toHaveLength(1);
    expect(blocking[0]).toMatch(/^\[critical\] button-name: .*<button><\/button>/);
    expect(advisory).toEqual([]);
  });

  it('returns moderate and minor findings as advisories, not blocking ones', async () => {
    // A heading that skips a level is a moderate heading-order finding.
    document.body.innerHTML = '<div id="probe"><h1>A</h1><h3>B</h3></div>';
    const { blocking, advisory } = await runAxe(document.getElementById('probe') as Element);
    expect(blocking.filter((line) => line.includes('heading-order'))).toEqual([]);
    expect(advisory.some((line) => line.includes('heading-order'))).toBe(true);
  });
});
