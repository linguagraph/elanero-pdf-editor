// The engine heap warning (W3.9 section 4, S4). The engine's linear memory only grows, so once it
// passes HEAP_WARN_BYTES the user is told to close documents. This is a notice, never a refusal:
// nothing is blocked. The check runs after a document opens and after a job is prepared or applied
// (the moments the heap grows by a whole document); there is no timer.
//
// Warn-once rule: one toast per engine generation. A later document open that is still above the
// limit warns again, at most once every REWARN_MS. A job check never repeats the warning. The
// state is keyed by the engine client, which a restart replaces, so a new engine starts fresh.
import type { Empty, MemoryResult } from '../rpc/generated';
import { t } from '../i18n/t';
import { toasts, type ToastStore } from './toasts';

// The one call the check makes. The RPC client satisfies it.
export interface MemoryEngine {
  call(method: 'system.memory', params: Empty): Promise<MemoryResult>;
}

export type MemoryCheckReason = 'open' | 'job';

export const REWARN_MS = 10 * 60 * 1000;

const GIB = 1024 ** 3;

// Shown as "1.6 GiB" in the warning text.
export function formatGiB(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

interface WarnState {
  warned: boolean;
  lastWarnAt: number;
}

export interface MemoryWarnerOptions {
  readonly toasts?: ToastStore;
  readonly now?: () => number;
}

export interface MemoryWarner {
  // Reads system.memory and warns when the heap, plus extraBytes (a job's document copy in the job
  // worker), is above the engine's limit. Never throws: a failed read simply shows nothing.
  check(engine: MemoryEngine, reason: MemoryCheckReason, extraBytes?: number): Promise<void>;
}

export function createMemoryWarner(options: MemoryWarnerOptions = {}): MemoryWarner {
  const store = options.toasts ?? toasts;
  const now = options.now ?? Date.now;
  const states = new WeakMap<MemoryEngine, WarnState>();

  return {
    async check(engine, reason, extraBytes = 0) {
      // Best effort: nothing in here may reach the open or job that called it, so a failed read
      // and a malformed reply both end as no warning.
      try {
        const memory: MemoryResult = await engine.call('system.memory', {});
        // null: the heap cannot be read on this engine, so there is nothing to warn about.
        if (memory.wasm_heap_bytes === null) return;
        const total = memory.wasm_heap_bytes + extraBytes;
        if (total <= memory.heap_warn_bytes) return;

        const at = now();
        const state = states.get(engine) ?? { warned: false, lastWarnAt: 0 };
        states.set(engine, state);
        const due = !state.warned || (reason === 'open' && at - state.lastWarnAt >= REWARN_MS);
        if (!due) return;
        state.warned = true;
        state.lastWarnAt = at;
        store.push('warning', t('memory.warning', { size: formatGiB(total) }));
      } catch {
        return;
      }
    },
  };
}

// The app's checker. The open and job flows call it.
export const memoryWarner: MemoryWarner = createMemoryWarner();
