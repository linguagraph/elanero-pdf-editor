// The translation calls' network path (W6.6 section 3). The worker drops XMLHttpRequest after its
// lockdown; this keeps the captured constructor and lets Python open requests only while armed.

// The origins translation may call: the CSP's connect-src minus 'self' (a Vitest test checks it).
export const TRANSLATION_ORIGINS: readonly string[] = [
  'https://api.mymemory.translated.net',
  'https://api.cognitive.microsofttranslator.com',
  'https://libretranslate.com',
];

// The engine calls that may reach the network. The worker arms the gate for each of them.
export const TRANSLATION_METHODS: ReadonlySet<string> = new Set([
  'translation.translate',
  'translation.test',
]);

// The part of XMLHttpRequest that the translation transport uses.
export interface XhrLike {
  open(method: string, url: string, asynchronous: boolean): void;
  setRequestHeader(name: string, value: string): void;
  send(body?: string): void;
  readonly status: number;
  readonly responseText: string;
  timeout: number;
  withCredentials: boolean;
}

export type XhrConstructor = new () => XhrLike;

export interface TranslationNet {
  arm(): void;
  disarm(): void;
  // A new request object for Python (elanero_net.open_xhr). It refuses to open unless armed.
  openXhr(): XhrLike;
}

const ALLOWED_METHODS: ReadonlySet<string> = new Set(['GET', 'POST']);

// True only for an https address with no user name or password, on one of TRANSLATION_ORIGINS.
// The origin is compared as a whole, so a look-alike host (libretranslate.com.example.test) fails.
export function isTranslationUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  return TRANSLATION_ORIGINS.includes(parsed.origin);
}

// The gate for one worker; ``native`` is the constructor captured before the lockdown.
// The request object subclasses it: only open, send and the headers are checked.
export function createTranslationNet(native: XhrConstructor | undefined): TranslationNet {
  let armed = false;
  const assertArmed = (): void => {
    if (!armed) throw new Error('translation is not allowed at this time');
  };
  // The subclass is made on first use: a worker with a stubbed XMLHttpRequest must still load.
  let gated: XhrConstructor | undefined;
  const gatedClass = (): XhrConstructor => {
    if (gated !== undefined) return gated;
    const Base = native as XhrConstructor;
    gated = class GatedXhr extends Base {
      open(method: string, url: string, asynchronous: boolean): void {
        assertArmed();
        if (asynchronous !== false) throw new Error('translation requests must be synchronous');
        if (!ALLOWED_METHODS.has(method)) throw new Error('translation method not allowed');
        if (!isTranslationUrl(url)) throw new Error('translation host not allowed');
        this.withCredentials = false;
        super.open(method, url, false);
      }

      setRequestHeader(name: string, value: string): void {
        assertArmed();
        super.setRequestHeader(name, value);
      }

      send(body?: string): void {
        assertArmed();
        super.send(body);
      }
    };
    return gated;
  };

  return {
    arm: () => {
      armed = true;
    },
    disarm: () => {
      armed = false;
    },
    openXhr: () => {
      if (native === undefined) throw new Error('translation is not available in this worker');
      return new (gatedClass())();
    },
  };
}
