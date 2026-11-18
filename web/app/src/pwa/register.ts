// Registers the service worker (W4.6). It is called only in production builds (main.tsx), so the
// dev server's modules never sit behind a cache. Without a service worker (an old browser, or a
// private window that blocks it) the app still works, just without offline use.
import { reportWaitingWorker } from './update';

export interface RegisterOptions {
  // navigator.serviceWorker, or undefined where the browser has none.
  container: ServiceWorkerContainer | undefined;
  // The worker script, same origin. Its default scope is the folder it sits in.
  scriptUrl: string;
  onWaiting(worker: ServiceWorker): void;
}

// The page's CSP requires Trusted Types for scripts (csp.ts), and register() takes a script URL,
// so the URL must be a TrustedScriptURL. The policy accepts only a same-origin sw.js and nothing
// else. Without Trusted Types (jsdom, older browsers) the plain string is used.
interface TrustedTypesFactory {
  createPolicy(
    name: string,
    rules: { createScriptURL(input: string): string },
  ): { createScriptURL(input: string): unknown };
}
let scriptUrlPolicy: { createScriptURL(input: string): unknown } | undefined;

function trustedScriptUrl(url: string): string {
  const factory = (globalThis as { trustedTypes?: TrustedTypesFactory }).trustedTypes;
  if (factory === undefined) return url;
  scriptUrlPolicy ??= factory.createPolicy('elanero-sw-url', {
    createScriptURL(input: string) {
      const resolved = new URL(input, globalThis.location.href);
      if (resolved.origin !== globalThis.location.origin || !resolved.pathname.endsWith('/sw.js')) {
        throw new TypeError('the service worker URL is not a same-origin sw.js');
      }
      return resolved.href;
    },
  });
  return scriptUrlPolicy.createScriptURL(url) as unknown as string;
}

// Resolves to the registration, or undefined when there is no service worker or registering fails.
// It never throws: a failed registration only costs offline use.
export async function registerServiceWorker(
  options: RegisterOptions,
): Promise<ServiceWorkerRegistration | undefined> {
  const { container } = options;
  if (container === undefined) return undefined;
  try {
    const registration = await container.register(trustedScriptUrl(options.scriptUrl));
    // A worker that finished installing while the page was closed is waiting already.
    if (registration.waiting && container.controller) {
      options.onWaiting(registration.waiting);
    }
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      installing?.addEventListener('statechange', () => {
        // "installed" with a controller present means an update, not the first install.
        if (installing.state === 'installed' && container.controller) {
          options.onWaiting(installing);
        }
      });
    });
    return registration;
  } catch {
    return undefined;
  }
}

// The app's own registration: reads the base path from the build, so it works under any
// deployment folder, and reports a waiting update to the update prompt.
export function registerAppServiceWorker(): Promise<ServiceWorkerRegistration | undefined> {
  return registerServiceWorker({
    container: 'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
    scriptUrl: `${import.meta.env.BASE_URL}sw.js`,
    onWaiting: reportWaitingWorker,
  });
}
