import { describe, expect, it, vi } from 'vitest';
import type { ActionJobWorker } from '../actionJob/actionJob';
import { createJobProgressStore } from '../feedback/jobRun';
import { createToastStore } from '../feedback/toasts';
import { PROTOCOL_VERSION } from '../rpc/generated';
import {
  readRemoved,
  runSanitize,
  type SanitizeChoice,
  SANITIZE_DEFAULTS,
  SANITIZE_LABEL,
  SANITIZE_OPTIONS,
  sanitizeArgs,
} from './sanitize';

const PDF_BYTES = new Uint8Array([37, 80, 68, 70]).buffer;

describe('sanitize options (W7.4)', () => {
  it('offers the eleven options of SanitizeOptions, all on by default', () => {
    expect(SANITIZE_OPTIONS).toHaveLength(11);
    expect(Object.values(SANITIZE_DEFAULTS).every(Boolean)).toBe(true);
    expect(Object.keys(SANITIZE_LABEL).sort()).toEqual([...SANITIZE_OPTIONS].sort());
  });

  it('sends every option in the job arguments, not only the ones that are on', () => {
    const choice = { ...SANITIZE_DEFAULTS, links: false } as SanitizeChoice;
    const { options } = sanitizeArgs(choice);
    expect(Object.keys(options).sort()).toEqual([...SANITIZE_OPTIONS].sort());
    expect(options.links).toBe(false);
    expect(options.metadata).toBe(true);
  });

  it('reads the list of removed items from the action value', () => {
    expect(readRemoved(['Document properties', 'Links'])).toEqual(['Document properties', 'Links']);
    expect(() => readRemoved('nothing')).toThrow();
  });
});

describe('runSanitize', () => {
  it('runs document.sanitize as an action job and returns what was removed', async () => {
    const reply = {
      v: PROTOCOL_VERSION,
      id: 1,
      ok: true,
      result: {
        kind: 'document',
        label: 'Sanitize Document',
        require_full_save: true,
        document: { $bin: 0 },
        files: [],
        value: ['Document properties'],
        name: '',
      },
      events: [],
    };
    const worker: ActionJobWorker = {
      call: vi.fn(async () => ({ reply: JSON.stringify(reply), buffer: PDF_BYTES.slice(0) })),
      terminate: vi.fn(),
    };
    const call = vi.fn(async (method: string) => {
      if (method === 'jobs.prepare') {
        return {
          token: 'j2',
          label: 'Sanitize Document',
          mutating: true,
          document: PDF_BYTES.slice(0),
          state: null,
        };
      }
      return { applied: true, changed: null, state: {} };
    });
    const store = createToastStore();
    const choice = { ...SANITIZE_DEFAULTS, metadata: false } as SanitizeChoice;
    const outcome = await runSanitize(
      {
        engine: { call } as never,
        startWorker: () => worker,
        progress: createJobProgressStore({ toasts: store }),
      },
      'h1',
      choice,
    );

    expect(call).toHaveBeenCalledWith('jobs.prepare', {
      handle: 'h1',
      job: 'action',
      args: { name: 'document.sanitize', args: sanitizeArgs(choice) },
    });
    expect(outcome).toEqual({ removed: ['Document properties'], changed: null });
  });
});
