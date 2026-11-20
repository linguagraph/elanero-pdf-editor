import { afterEach, describe, expect, it, vi } from 'vitest';
import { withoutImportScripts } from './loader';

// pyodide.mjs probes for a classic worker with globalThis.importScripts("data:text/javascript,"),
// a string-to-script sink. Under require-trusted-types-for 'script' Firefox and WebKit report a
// CSP violation for it, though the probe's own try/catch still answers "not classic".
describe('withoutImportScripts', () => {
  const holder = globalThis as { importScripts?: unknown };
  afterEach(() => {
    delete holder.importScripts;
  });

  it('hides importScripts while the module evaluates and puts it back after', async () => {
    const original = vi.fn();
    holder.importScripts = original;
    let seen: unknown = 'unset';
    await withoutImportScripts(async () => {
      seen = holder.importScripts;
    });
    expect(seen).not.toBeTypeOf('function');
    expect(holder.importScripts).toBe(original);
  });

  it('restores importScripts when the import fails', async () => {
    const original = vi.fn();
    holder.importScripts = original;
    await expect(
      withoutImportScripts(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(holder.importScripts).toBe(original);
  });

  it('leaves a context without importScripts without one', async () => {
    await withoutImportScripts(async () => undefined);
    expect('importScripts' in holder).toBe(false);
  });
});
