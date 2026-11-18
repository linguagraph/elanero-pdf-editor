/* global self, caches, fetch, Request, Response, Headers, URL, crypto */
// Elanero service worker (W4.6). Plain JavaScript, same origin, no dependencies.
//
// The build (vite.config.ts, src/pwa/build.ts) replaces the placeholder below with the cache name
// and the list of files to keep offline, each with its SHA-256. Served unbuilt (dev), the list is
// empty and the worker caches nothing.
//
// - install: fetches every listed file (bypassing the HTTP cache), checks its SHA-256, and stores
//   it under this version's cache. Any mismatch fails the install, so the old worker stays.
// - Nothing activates on install. The page asks for it with a SKIP_WAITING message, after the
//   user accepts the update prompt (src/pwa/update.ts).
// - activate: deletes the caches of other Elanero versions and takes control of open pages.
// - fetch: a listed file, or the app shell for a navigation, comes from the cache; anything else
//   goes to the network. Documents are never cached, so a PDF the user opens never lands here.

const BUILD = readBuild('__BUILD_JSON__');

function readBuild(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return { cacheName: 'elanero-unbuilt', commit: 'unknown', files: [] };
  }
}

const SHELL_PATH = 'index.html';

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
});

async function precache() {
  const cache = await caches.open(BUILD.cacheName);
  try {
    for (const file of BUILD.files) {
      const url = new URL(file.path, self.registration.scope).href;
      const response = await fetch(
        new Request(url, { cache: 'reload', credentials: 'same-origin' }),
      );
      if (!response.ok) {
        throw new Error(`${file.path} could not be fetched (HTTP ${response.status})`);
      }
      const body = await response.arrayBuffer();
      if ((await sha256Hex(body)) !== file.sha256) {
        throw new Error(`${file.path} does not match the build's SHA-256`);
      }
      // Only the content type is kept. The body is already decoded, so an encoding header from
      // the server would describe bytes the cache does not hold.
      const headers = new Headers();
      const type = response.headers.get('content-type');
      if (type !== null) headers.set('content-type', type);
      await cache.put(url, new Response(body, { status: 200, headers }));
    }
  } catch (error) {
    // A partial version is removed, so the next install starts clean.
    await caches.delete(BUILD.cacheName);
    throw error;
  }
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('elanero-') && name !== BUILD.cacheName)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(respond(request));
});

async function respond(request) {
  const cache = await caches.open(BUILD.cacheName);
  const key =
    request.mode === 'navigate' ? new URL(SHELL_PATH, self.registration.scope).href : request.url;
  const hit = await cache.match(key);
  return hit ?? fetch(request);
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
