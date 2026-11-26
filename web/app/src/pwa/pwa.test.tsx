import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appCacheName, buildManifest, renderServiceWorker, BUILD_PLACEHOLDER } from './build';
import { registerServiceWorker } from './register';
import { applyWaitingWorker, reportWaitingWorker, resetUpdateState } from './update';
import { UpdatePrompt } from './UpdatePrompt';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('web app manifest (W4.6)', () => {
  it('parses and has the fields an installable app needs', () => {
    const manifest = JSON.parse(JSON.stringify(buildManifest())) as Record<string, unknown>;
    expect(manifest.name).toBe('Elanero');
    expect(manifest.short_name).toBe('Elanero');
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    const icons = manifest.icons as { src: string; sizes: string; type: string }[];
    expect(icons.map((icon) => icon.sizes)).toEqual(['256x256', '512x512']);
  });

  it('uses only relative URLs, so the base path is set at build time', () => {
    const manifest = buildManifest();
    const handlers = manifest.file_handlers as { action: string; icons: { src: string }[] }[];
    const urls = [
      manifest.start_url,
      manifest.scope,
      ...(manifest.icons as { src: string }[]),
      ...handlers.map((handler) => handler.action),
      ...handlers.flatMap((handler) => handler.icons),
    ];
    for (const entry of urls) {
      const src = typeof entry === 'string' ? entry : (entry as { src: string }).src;
      expect(src.startsWith('/'), src).toBe(false);
      expect(src.startsWith('http'), src).toBe(false);
    }
  });

  it('declares PDF "Open with" and focus-existing launches (W4.6 S1)', () => {
    const manifest = JSON.parse(JSON.stringify(buildManifest())) as Record<string, unknown>;
    const handlers = manifest.file_handlers as {
      action: string;
      accept: Record<string, string[]>;
      launch_type: string;
    }[];
    expect(handlers).toHaveLength(1);
    const [handler] = handlers;
    expect(handler?.action).toBe(manifest.start_url);
    expect(handler?.accept).toEqual({ 'application/pdf': ['.pdf'] });
    expect(handler?.launch_type).toBe('single-client');
    expect(manifest.launch_handler).toEqual({ client_mode: ['focus-existing', 'auto'] });
  });

  it('has its icons in public/', () => {
    for (const size of [256, 512]) {
      expect(existsSync(resolve(appRoot, 'public', 'icons', `elanero-${size}.png`))).toBe(true);
    }
  });

  it('is linked from index.html', () => {
    const html = readFileSync(resolve(appRoot, 'index.html'), 'utf8');
    expect(html).toContain('<link rel="manifest" href="manifest.webmanifest" />');
  });

  it('sets the Elanero icon as the favicon and apple-touch-icon', () => {
    const html = readFileSync(resolve(appRoot, 'index.html'), 'utf8');
    expect(html).toContain(
      '<link rel="icon" type="image/png" sizes="32x32" href="icons/elanero-32.png" />',
    );
    expect(html).toContain(
      '<link rel="apple-touch-icon" sizes="256x256" href="icons/elanero-256.png" />',
    );
    expect(existsSync(resolve(appRoot, 'public', 'icons', 'elanero-32.png'))).toBe(true);
  });
});

describe('service worker cache name (W4.6)', () => {
  it('is versioned by the app version and the build id', () => {
    expect(appCacheName('0.4.1', 'abc123def456')).toBe('elanero-0.4.1-abc123def456');
  });

  it('changes when the version or the build changes', () => {
    const base = appCacheName('0.4.1', 'aaaa');
    expect(appCacheName('0.4.2', 'aaaa')).not.toBe(base);
    expect(appCacheName('0.4.1', 'bbbb')).not.toBe(base);
  });

  it('rejects parts that could break the name or the cache prefix', () => {
    expect(() => appCacheName('0.4.1 x', 'aaaa')).toThrow();
    expect(() => appCacheName('0.4.1', 'NOT-HEX')).toThrow();
  });

  it('is written into the service worker source, and the placeholder is replaced', () => {
    const source = readFileSync(resolve(appRoot, 'public', 'sw.js'), 'utf8');
    expect(source).toContain(BUILD_PLACEHOLDER);
    const built = renderServiceWorker(source, {
      cacheName: appCacheName('0.4.1', 'abc123def456'),
      commit: 'unknown',
      files: [{ path: "it's/index.html", sha256: 'f'.repeat(64) }],
    });
    expect(built).not.toContain(BUILD_PLACEHOLDER);
    // The escaped JSON must still be a valid JavaScript string inside the worker.
    const literal = /readBuild\('((?:[^'\\]|\\.)*)'\)/.exec(built);
    expect(literal).not.toBeNull();
    // Evaluating the single-quoted literal is the exact check: it is what the worker runs.
    const text = new Function(`return '${literal?.[1] ?? ''}';`)() as string;
    const parsed = JSON.parse(text);
    expect(parsed.cacheName).toBe('elanero-0.4.1-abc123def456');
    expect(parsed.files[0].path).toBe("it's/index.html");
  });

  it('refuses a source without the placeholder', () => {
    expect(() =>
      renderServiceWorker('console.log(1)', { cacheName: 'elanero-x-aa', commit: '', files: [] }),
    ).toThrow(/placeholder/);
  });
});

describe('registerServiceWorker (W4.6)', () => {
  it('does nothing when service workers are unavailable', async () => {
    const onWaiting = vi.fn();
    const result = await registerServiceWorker({
      container: undefined,
      scriptUrl: '/sw.js',
      onWaiting,
    });
    expect(result).toBeUndefined();
    expect(onWaiting).not.toHaveBeenCalled();
  });

  it('returns undefined instead of throwing when registration fails', async () => {
    const container = {
      controller: null,
      register: vi.fn().mockRejectedValue(new Error('denied')),
    } as unknown as ServiceWorkerContainer;
    await expect(
      registerServiceWorker({ container, scriptUrl: '/sw.js', onWaiting: vi.fn() }),
    ).resolves.toBeUndefined();
  });

  it('reports a waiting worker when the page already has a controller', async () => {
    const waiting = { state: 'installed' } as ServiceWorker;
    const registration = {
      waiting,
      installing: null,
      addEventListener: vi.fn(),
    } as unknown as ServiceWorkerRegistration;
    const container = {
      controller: {} as ServiceWorker,
      register: vi.fn().mockResolvedValue(registration),
    } as unknown as ServiceWorkerContainer;
    const onWaiting = vi.fn();
    await registerServiceWorker({ container, scriptUrl: '/app/sw.js', onWaiting });
    expect(container.register).toHaveBeenCalledWith('/app/sw.js');
    expect(onWaiting).toHaveBeenCalledWith(waiting);
  });

  it('does not report a waiting worker on the first install (no controller)', async () => {
    const registration = {
      waiting: { state: 'installed' },
      installing: null,
      addEventListener: vi.fn(),
    } as unknown as ServiceWorkerRegistration;
    const container = {
      controller: null,
      register: vi.fn().mockResolvedValue(registration),
    } as unknown as ServiceWorkerContainer;
    const onWaiting = vi.fn();
    await registerServiceWorker({ container, scriptUrl: '/sw.js', onWaiting });
    expect(onWaiting).not.toHaveBeenCalled();
  });
});

describe('update prompt (W4.6)', () => {
  let host: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetUpdateState();
    host = document.createElement('div');
    document.body.append(host);
  });
  afterEach(() => {
    resetUpdateState();
    host.remove();
  });

  it('shows nothing until a waiting worker is reported', () => {
    const root = createRoot(host);
    act(() => {
      root.render(<UpdatePrompt />);
    });
    expect(host.querySelector('[role="status"]')).toBeNull();
    act(() => {
      root.unmount();
    });
  });

  it('shows the banner with a Reload button when a waiting worker is reported', () => {
    const root = createRoot(host);
    act(() => {
      root.render(<UpdatePrompt />);
    });
    act(() => {
      reportWaitingWorker({ postMessage: vi.fn() } as unknown as ServiceWorker);
    });
    const banner = host.querySelector('[role="status"]');
    expect(banner?.textContent).toContain('A new version of Elanero is ready.');
    const button = host.querySelector('button');
    expect(button?.textContent).toBe('Reload');
    act(() => {
      root.unmount();
    });
  });

  it('asks the waiting worker to take over and reloads once the new worker controls the page', () => {
    const postMessage = vi.fn();
    reportWaitingWorker({ postMessage } as unknown as ServiceWorker);
    const listeners: Array<() => void> = [];
    const container = {
      addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
    } as unknown as ServiceWorkerContainer;
    const reload = vi.fn();
    applyWaitingWorker(container, reload);
    expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(reload).not.toHaveBeenCalled();
    for (const listener of listeners) listener();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
