import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from 'react-aria-components';
import { afterEach, describe, expect, it, vi } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(resolve(root, 'index.html'), 'utf8');
const appCss = readFileSync(resolve(root, 'src', 'app.css'), 'utf8');

// react-aria skips its style injection when NODE_ENV is 'test', so the check runs as the shipped
// app does. style-src 'self' blocks the <style> it would add (sha256-38RhXrc7...).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('react-aria pressable style', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    document.head.innerHTML = '';
  });

  it('adds no inline <style> element when a pressable renders', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const head = new DOMParser().parseFromString(indexHtml, 'text/html').head;
    for (const el of Array.from(head.querySelectorAll('[id]'))) {
      document.head.append(document.importNode(el, true));
    }
    const host = document.createElement('div');
    document.body.append(host);
    await act(async () => {
      createRoot(host).render(<Button>Press</Button>);
    });
    expect(document.head.querySelectorAll('style')).toHaveLength(0);
  });

  it('keeps the touch-action rule in the stylesheet', () => {
    expect(appCss).toMatch(
      /\[data-react-aria-pressable\]\s*\{\s*touch-action:\s*pan-x pan-y pinch-zoom;/,
    );
  });
});
