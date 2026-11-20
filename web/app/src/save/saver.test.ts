import { describe, expect, it, vi } from 'vitest';
import type { EngineClient } from '../engine/engineConnection';
import { RpcError } from '../rpc/client';
import { type SaveTarget, createSaver } from './saver';

const TARGET: SaveTarget = {
  handle: 'doc-1',
  name: 'report.pdf',
  signed: false,
  restored: false,
};

const BYTES = new ArrayBuffer(8);

const SAVED = { data: BYTES, size: 8, incremental: false, verified: true, name: 'report' };

// A fake engine: save_bytes answers with SAVED unless the script says otherwise, and mark_saved
// answers unless the script makes it fail. Every call is recorded in order.
function fakeClient(script: {
  save?: () => Promise<unknown>;
  markSaved?: () => Promise<unknown>;
}): { client: EngineClient; calls: () => string[]; params: () => unknown[] } {
  const seen: { method: string; params: unknown }[] = [];
  const call = vi.fn((method: string, params: unknown) => {
    seen.push({ method, params });
    if (method === 'save.save_bytes') return script.save?.() ?? Promise.resolve(SAVED);
    if (method === 'save.mark_saved') {
      return script.markSaved?.() ?? Promise.resolve({ saved: true, state: {} });
    }
    return Promise.reject(new Error(`unexpected ${method}`));
  });
  return {
    client: { call } as unknown as EngineClient,
    calls: () => seen.map((entry) => entry.method),
    params: () => seen.map((entry) => entry.params),
  };
}

describe('createSaver', () => {
  it('writes the bytes, downloads them under the name, then marks the document saved', async () => {
    const fake = fakeClient({});
    const download = vi.fn();
    const saver = createSaver({ client: () => fake.client, download });

    const outcome = await saver.save(TARGET, 'in_place');

    expect(fake.calls()).toEqual(['save.save_bytes', 'save.mark_saved']);
    expect(fake.params()[0]).toEqual({ handle: 'doc-1', mode: 'in_place' });
    expect(download).toHaveBeenCalledWith('report.pdf', BYTES);
    expect(outcome).toEqual({
      status: 'saved',
      name: 'report.pdf',
      incremental: false,
      data: BYTES,
      changedSince: false,
    });
  });

  it('sends the copy mode as copy', async () => {
    const fake = fakeClient({});
    const saver = createSaver({ client: () => fake.client, download: vi.fn() });
    await saver.save(TARGET, 'copy');
    expect(fake.params()[0]).toEqual({ handle: 'doc-1', mode: 'copy' });
  });

  it('reports BUSY without a download and without marking the document saved', async () => {
    const fake = fakeClient({
      save: () => Promise.reject(new RpcError('BUSY', 'busy', { task: 'ocr' })),
    });
    const download = vi.fn();
    const saver = createSaver({ client: () => fake.client, download });

    const outcome = await saver.save(TARGET, 'in_place');

    expect(outcome.status === 'failed' && outcome.error.code).toBe('BUSY');
    expect(download).not.toHaveBeenCalled();
    expect(fake.calls()).toEqual(['save.save_bytes']);
  });

  it('marks an in-place save of a signed document, so the caller can offer a new file', async () => {
    const fake = fakeClient({
      save: () => Promise.reject(new RpcError('SAVE_FAILED', 'refused')),
    });
    const saver = createSaver({ client: () => fake.client, download: vi.fn() });
    const signed = { ...TARGET, signed: true };

    const inPlace = await saver.save(signed, 'in_place');
    const copy = await saver.save(signed, 'copy');

    expect(inPlace.status === 'failed' && inPlace.context.signedInPlaceSave).toBe(true);
    expect(copy.status === 'failed' && copy.context.signedInPlaceSave).toBe(false);
  });

  it('reports an incremental save of a signed document as incremental', async () => {
    const fake = fakeClient({
      save: () => Promise.resolve({ ...SAVED, incremental: true }),
    });
    const saver = createSaver({ client: () => fake.client, download: vi.fn() });
    const outcome = await saver.save({ ...TARGET, signed: true }, 'in_place');
    expect(outcome.status === 'saved' && outcome.incremental).toBe(true);
  });

  it('refuses a second save of the same document while one is running', async () => {
    let finish: (value: unknown) => void = () => undefined;
    const fake = fakeClient({
      save: () => new Promise((resolve) => (finish = resolve)),
    });
    const saver = createSaver({ client: () => fake.client, download: vi.fn() });

    const first = saver.save(TARGET, 'in_place');
    const second = await saver.save(TARGET, 'in_place');
    expect(second).toEqual({ status: 'skipped', reason: 'in-flight' });

    finish(SAVED);
    expect((await first).status).toBe('saved');
    expect(fake.calls()).toEqual(['save.save_bytes', 'save.mark_saved']);
  });

  it('skips an in-place save of a signed document reopened after a restart, with no engine call', async () => {
    const fake = fakeClient({});
    const saver = createSaver({ client: () => fake.client, download: vi.fn() });

    const outcome = await saver.save({ ...TARGET, signed: true, restored: true }, 'in_place');

    expect(outcome).toEqual({ status: 'skipped', reason: 'signed-restored' });
    expect(fake.calls()).toEqual([]);
  });

  it('still copies a restored signed document, since a copy is a full rewrite', async () => {
    const fake = fakeClient({});
    const saver = createSaver({ client: () => fake.client, download: vi.fn() });
    const outcome = await saver.save({ ...TARGET, signed: true, restored: true }, 'copy');
    expect(outcome.status).toBe('saved');
  });

  it('reports a document that changed while it was saved as saved, but changed', async () => {
    const fake = fakeClient({
      markSaved: () => Promise.reject(new RpcError('STALE_OBJECT', 'changed')),
    });
    const saver = createSaver({ client: () => fake.client, download: vi.fn() });
    const outcome = await saver.save(TARGET, 'in_place');
    expect(outcome.status === 'saved' && outcome.changedSince).toBe(true);
  });

  it('does not mark the document saved when the browser refuses the download', async () => {
    const fake = fakeClient({});
    const saver = createSaver({
      client: () => fake.client,
      download: () => {
        throw new Error('blocked');
      },
    });
    const outcome = await saver.save(TARGET, 'in_place');
    expect(outcome).toEqual({ status: 'download-blocked', name: 'report.pdf', data: BYTES });
    expect(fake.calls()).toEqual(['save.save_bytes']);
  });

  it('never calls an undo, an edit or any other document command', async () => {
    const fake = fakeClient({});
    const saver = createSaver({ client: () => fake.client, download: vi.fn() });
    await saver.save(TARGET, 'in_place');
    expect(fake.calls().every((method) => method.startsWith('save.'))).toBe(true);
  });

  it('fails with an engine error when no engine is ready', async () => {
    const saver = createSaver({ client: () => undefined, download: vi.fn() });
    const outcome = await saver.save(TARGET, 'in_place');
    expect(outcome.status === 'failed' && outcome.error.code).toBe('ENGINE_ERROR');
  });
});
