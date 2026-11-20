// The network globals a Pyodide worker removes once its engine is up (W1.1 section 10). Pyodide
// itself still needs fetch to load packages, so the lock runs in beforeEngine, after the loader's
// packages stage and before any engine code runs.
export const FORBIDDEN_GLOBALS = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'importScripts',
] as const;

// Makes the network globals undefined. It fails closed: if one is still there afterwards, the
// load fails rather than running PDF code with network access.
export function lockDownGlobals(target: object = globalThis, label = 'worker'): void {
  const host = target as Record<string, unknown>;
  for (const name of FORBIDDEN_GLOBALS) {
    try {
      Object.defineProperty(host, name, {
        value: undefined,
        writable: false,
        configurable: true,
        enumerable: false,
      });
    } catch {
      // Not configurable: the check below decides.
    }
  }
  const remaining = FORBIDDEN_GLOBALS.filter((name) => host[name] !== undefined);
  if (remaining.length > 0) {
    throw new Error(`the ${label} could not remove ${remaining.join(', ')}`);
  }
}
