// @vitest-environment node
// Runs public/sw.js (the real worker source, rendered as the build renders it) in a node:vm
// context with an in-memory Cache API, a scripted network and a scripted HTTP cache. It checks the
// install reuse (W4.6 S2): unchanged files come from the previous version, the HTTP cache is tried
// before the network, a wrong SHA is never kept, and the fetch handler serves only listed files.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { renderServiceWorker, type PrecacheFile } from './build';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCOPE = 'https://app.test/elanero/';
const NEW = 'elanero-0.4.1-new';
const OLD = 'elanero-0.4.0-old';

interface Bytes {
  body: Uint8Array<ArrayBuffer>;
  type: string;
}

function text(value: string): Bytes {
  return { body: new Uint8Array(new TextEncoder().encode(value)), type: 'text/plain' };
}

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// The build's files, with the bytes each one must have.
const CONTENT: Record<string, Bytes> = {
  'index.html': text('<html>shell</html>'),
  'assets/app.js': text('console.log("app")'),
  'engine-assets/pyodide.mjs': text('export const engine = 1;'),
  'engine-assets/wheel.whl': text('wheel bytes'),
};

function urlOf(path: string): string {
  return new URL(path, SCOPE).href;
}

function bytesOf(path: string): Bytes {
  const bytes = CONTENT[path];
  if (bytes === undefined) throw new Error(`no test content for ${path}`);
  return bytes;
}

class FakeCache {
  readonly entries = new Map<string, Response>();
  async match(key: string | Request): Promise<Response | undefined> {
    const hit = this.entries.get(typeof key === 'string' ? key : key.url);
    return hit?.clone();
  }
  async put(key: string | Request, response: Response): Promise<void> {
    this.entries.set(typeof key === 'string' ? key : key.url, response);
  }
}

function respond(bytes: Bytes | undefined): Response {
  if (bytes === undefined) return new Response('missing', { status: 404 });
  return new Response(bytes.body, { status: 200, headers: { 'content-type': bytes.type } });
}

// One worker's world: the caches on the origin, what the network serves, what the HTTP cache
// holds, and a log of every fetch the worker made ("<cache mode> <path>", or "http <path>").
function world(options: {
  previous?: Record<string, Bytes>;
  httpCache?: Record<string, Bytes>;
  network?: Record<string, Bytes>;
}) {
  const caches = new Map<string, FakeCache>();
  const log: string[] = [];
  const cacheNamed = (name: string): FakeCache => {
    let cache = caches.get(name);
    if (cache === undefined) {
      cache = new FakeCache();
      caches.set(name, cache);
    }
    return cache;
  };
  for (const [path, bytes] of Object.entries(options.previous ?? {})) {
    cacheNamed(OLD).entries.set(urlOf(path), respond(bytes));
  }
  const network = options.network ?? CONTENT;
  const http = options.httpCache ?? {};
  const fetchFake = async (request: Request): Promise<Response> => {
    const path = request.url.slice(SCOPE.length);
    if (request.cache === 'default' && path in http) {
      log.push(`http ${path}`);
      return respond(http[path]);
    }
    log.push(`${request.cache} ${path}`);
    return respond(network[path]);
  };
  const listeners = new Map<string, (event: unknown) => void>();
  const context = vm.createContext({
    self: {
      addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
      registration: { scope: SCOPE },
      location: new URL(`${SCOPE}sw.js`),
      clients: { claim: async () => undefined },
      skipWaiting: () => undefined,
    },
    caches: {
      open: async (name: string) => cacheNamed(name),
      keys: async () => [...caches.keys()],
      delete: async (name: string) => caches.delete(name),
    },
    fetch: fetchFake,
    Request,
    Response,
    Headers,
    URL,
    crypto: globalThis.crypto,
  });
  const source = readFileSync(resolve(appRoot, 'public', 'sw.js'), 'utf8');
  const files: PrecacheFile[] = Object.entries(CONTENT).map(([path, bytes]) => ({
    path,
    sha256: sha(bytes.body),
  }));
  vm.runInContext(renderServiceWorker(source, { cacheName: NEW, commit: 'test', files }), context);

  const install = async (): Promise<void> => {
    const promises: Promise<unknown>[] = [];
    listeners.get('install')?.({
      waitUntil: (promise: Promise<unknown>) => promises.push(promise),
    });
    await Promise.all(promises);
  };
  // Answers a fetch event. Undefined means the worker did not take the request.
  const handle = async (
    url: string,
    init: { method?: string; mode?: string } = {},
  ): Promise<Response | undefined> => {
    let answer: Promise<Response> | undefined;
    listeners.get('fetch')?.({
      request: { url, method: init.method ?? 'GET', mode: init.mode ?? 'same-origin' },
      respondWith: (promise: Promise<Response>) => (answer = promise),
    });
    return answer;
  };
  return { caches, log, install, handle };
}

describe('service worker install (W4.6 S2)', () => {
  it('with no previous version, fetches every listed file and stores it', async () => {
    const w = world({});
    await w.install();
    expect(w.log).toHaveLength(Object.keys(CONTENT).length);
    const stored = [...(w.caches.get(NEW)?.entries.keys() ?? [])].sort();
    expect(stored).toEqual(Object.keys(CONTENT).map(urlOf).sort());
  });

  it('a SHA mismatch fails the install and removes the new version cache', async () => {
    const w = world({ network: { ...CONTENT, 'assets/app.js': text('tampered') } });
    await expect(w.install()).rejects.toThrow(/assets\/app\.js does not match/);
    expect(w.caches.has(NEW)).toBe(false);
  });

  it('copies an unchanged file from the previous version without a request for it', async () => {
    const path = 'engine-assets/pyodide.mjs';
    const w = world({ previous: { [path]: bytesOf(path) } });
    await w.install();
    expect(w.log.some((entry) => entry.endsWith(path))).toBe(false);
    const stored = await w.caches.get(NEW)?.match(urlOf(path));
    expect(await stored?.text()).toBe('export const engine = 1;');
  });

  it('fetches a file the previous version holds with the wrong bytes', async () => {
    const path = 'engine-assets/pyodide.mjs';
    const w = world({ previous: { [path]: text('old engine') } });
    await w.install();
    expect(w.log.filter((entry) => entry.endsWith(path))).toEqual([`default ${path}`]);
    const stored = await w.caches.get(NEW)?.match(urlOf(path));
    expect(await stored?.text()).toBe('export const engine = 1;');
  });

  it('reads the HTTP cache first, so a file the page already loaded is not downloaded again', async () => {
    const path = 'engine-assets/wheel.whl';
    const w = world({ httpCache: { [path]: bytesOf(path) } });
    await w.install();
    expect(w.log).toContain(`http ${path}`);
    expect(w.log.filter((entry) => entry.endsWith(path))).toEqual([`http ${path}`]);
  });

  it('refetches from the network once when the HTTP cache holds the wrong bytes', async () => {
    const w = world({ httpCache: { 'index.html': text('stale shell') } });
    await w.install();
    expect(w.log).toContain('http index.html');
    expect(w.log).toContain('reload index.html');
    const stored = await w.caches.get(NEW)?.match(urlOf('index.html'));
    expect(await stored?.text()).toBe('<html>shell</html>');
  });
});

describe('service worker fetch handler (W4.6 S2)', () => {
  it('serves a navigation with the cached shell', async () => {
    const w = world({});
    await w.install();
    const response = await w.handle(urlOf('some/route'), { mode: 'navigate' });
    expect(await response?.text()).toBe('<html>shell</html>');
  });

  it('serves a listed file from the cache without the network', async () => {
    const w = world({});
    await w.install();
    const before = w.log.length;
    const response = await w.handle(urlOf('assets/app.js'));
    expect(await response?.text()).toBe('console.log("app")');
    expect(w.log.length).toBe(before);
  });

  it('does not intercept a non-GET or a cross-origin request', async () => {
    const w = world({});
    await w.install();
    expect(await w.handle(urlOf('assets/app.js'), { method: 'POST' })).toBeUndefined();
    expect(await w.handle('https://other.test/assets/app.js')).toBeUndefined();
  });
});
