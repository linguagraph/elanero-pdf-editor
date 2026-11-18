// The same policy is written into index.html; csp.test.ts fails if the two drift apart.
export const CSP_POLICY =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' https://api.mymemory.translated.net https://api.cognitive.microsofttranslator.com https://libretranslate.com; img-src 'self' blob: data:; style-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; require-trusted-types-for 'script'";

export const REFERRER_POLICY = 'no-referrer';
