// W4.3b key probe (manual, its own config: playwright.keys.config.ts). It asks one question per
// key: does a browser-reserved or a second-group key reach the page, and does the page take it?
// The answer decides the second key group the W1.6 table allows (docs/web/spikes/W4.3b-keys.md).
//
// Each key is pressed in a fresh browser context, so a key that closes the page, navigates it or
// opens a window cannot disturb the next one. Synthetic input is not the same as a real keyboard:
// a browser's own accelerators are often never delivered to the page at all. So "arrived" here is
// evidence, not policy. The reserved group in W1.6 stays policy whatever this run says.
//
// The results are written as JSON (test-results/keys-<browser>-<os>.json) and attached to the test.
// Only the four Alt replacements and the palette key are hard assertions; the rest is data.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type Page } from '@playwright/test';

declare global {
  interface Window {
    __probe?: { arrived: boolean; prevented: boolean | null };
  }
}

type Outcome = 'arrived' | 'not-arrived' | 'taken-by-browser';

interface ProbeKey {
  readonly group: 'reserved' | 'second-group' | 'taken-over' | 'web-replacement';
  // The shortcut as the W1.6 table writes it (Ctrl is the desktop's Ctrl; macOS maps it to Meta).
  readonly keys: string;
  // The Playwright key chord as sent to the page.
  readonly press: string;
  // The physical key (KeyboardEvent.code) the page should see.
  readonly code: string;
  readonly hard?: 'arrives' | 'arrives-and-opens-palette';
  readonly zoom?: boolean;
}

// The text in `keys` is the desktop form; `press` is the same chord, with Control swapped for
// Meta on macOS (see `chord`). Keep the two in step when editing.
const PROBES: readonly ProbeKey[] = [
  // Browser-reserved group (W1.6 table).
  { group: 'reserved', keys: 'Ctrl+W', press: 'Control+W', code: 'KeyW' },
  { group: 'reserved', keys: 'Ctrl+F4', press: 'Control+F4', code: 'F4' },
  { group: 'reserved', keys: 'Ctrl+Tab', press: 'Control+Tab', code: 'Tab' },
  { group: 'reserved', keys: 'Ctrl+Shift+Tab', press: 'Control+Shift+Tab', code: 'Tab' },
  { group: 'reserved', keys: 'Ctrl+N', press: 'Control+N', code: 'KeyN' },
  { group: 'reserved', keys: 'Ctrl+Q', press: 'Control+Q', code: 'KeyQ' },
  { group: 'reserved', keys: 'Ctrl+Shift+N', press: 'Control+Shift+N', code: 'KeyN' },
  { group: 'reserved', keys: 'Ctrl+Shift+T', press: 'Control+Shift+T', code: 'KeyT' },
  { group: 'reserved', keys: 'Ctrl+Shift+I', press: 'Control+Shift+I', code: 'KeyI' },
  { group: 'reserved', keys: 'Ctrl+Shift+C', press: 'Control+Shift+C', code: 'KeyC' },
  // Common browser keys the W1.6 table does not list yet (W4.x section 5, recorded as data).
  { group: 'reserved', keys: 'Ctrl+T', press: 'Control+T', code: 'KeyT' },
  { group: 'reserved', keys: 'Ctrl+L', press: 'Control+L', code: 'KeyL' },
  { group: 'reserved', keys: 'Ctrl+R', press: 'Control+R', code: 'KeyR' },
  { group: 'reserved', keys: 'F5', press: 'F5', code: 'F5' },
  { group: 'reserved', keys: 'F11', press: 'F11', code: 'F11' },
  { group: 'reserved', keys: 'F12', press: 'F12', code: 'F12' },
  { group: 'reserved', keys: 'Ctrl+Shift+J', press: 'Control+Shift+J', code: 'KeyJ' },
  { group: 'reserved', keys: 'Alt+F4', press: 'Alt+F4', code: 'F4' },
  { group: 'reserved', keys: 'Alt+D', press: 'Alt+D', code: 'KeyD' },
  { group: 'reserved', keys: 'Alt+F', press: 'Alt+F', code: 'KeyF' },
  // Second group (the candidates for the key list the W1.6 table allows).
  { group: 'second-group', keys: 'Ctrl+1', press: 'Control+1', code: 'Digit1' },
  { group: 'second-group', keys: 'Ctrl+2', press: 'Control+2', code: 'Digit2' },
  { group: 'second-group', keys: 'Ctrl+6', press: 'Control+6', code: 'Digit6' },
  { group: 'second-group', keys: 'Ctrl+0', press: 'Control+0', code: 'Digit0', zoom: true },
  { group: 'second-group', keys: 'Ctrl+=', press: 'Control+=', code: 'Equal', zoom: true },
  { group: 'second-group', keys: 'Ctrl+-', press: 'Control+-', code: 'Minus', zoom: true },
  { group: 'second-group', keys: 'F6', press: 'F6', code: 'F6' },
  { group: 'second-group', keys: 'Shift+F6', press: 'Shift+F6', code: 'F6' },
  { group: 'second-group', keys: 'Ctrl+E', press: 'Control+E', code: 'KeyE' },
  { group: 'second-group', keys: 'Ctrl+K', press: 'Control+K', code: 'KeyK' },
  { group: 'second-group', keys: 'Ctrl+D', press: 'Control+D', code: 'KeyD' },
  // Taken over by the browser's own shortcut policy on the desktop (for comparison).
  { group: 'taken-over', keys: 'Ctrl+O', press: 'Control+O', code: 'KeyO' },
  { group: 'taken-over', keys: 'Ctrl+S', press: 'Control+S', code: 'KeyS' },
  { group: 'taken-over', keys: 'Ctrl+P', press: 'Control+P', code: 'KeyP' },
  { group: 'taken-over', keys: 'Ctrl+F', press: 'Control+F', code: 'KeyF' },
  {
    group: 'taken-over',
    keys: 'Ctrl+Shift+P',
    press: 'Control+Shift+P',
    code: 'KeyP',
    hard: 'arrives-and-opens-palette',
  },
  // Web replacements (web/src/shortcuts.web.ts).
  { group: 'web-replacement', keys: 'Alt+W', press: 'Alt+W', code: 'KeyW', hard: 'arrives' },
  { group: 'web-replacement', keys: 'Alt+G', press: 'Alt+G', code: 'KeyG', hard: 'arrives' },
  {
    group: 'web-replacement',
    keys: 'Alt+PgDn',
    press: 'Alt+PageDown',
    code: 'PageDown',
    hard: 'arrives',
  },
  {
    group: 'web-replacement',
    keys: 'Alt+PgUp',
    press: 'Alt+PageUp',
    code: 'PageUp',
    hard: 'arrives',
  },
];

// The recorder runs before the app's scripts in every document. The capture listener on `window`
// sees the key before the app does: that is "arrived". A bubble listener, added after load, runs
// after the app's document listeners, so `prevented` says whether the app took the key.
function recorderScript(code: string): string {
  return `
    window.__probe = { arrived: false, prevented: null };
    window.addEventListener('keydown', (event) => {
      if (event.code === ${JSON.stringify(code)}) window.__probe.arrived = true;
    }, true);
  `;
}

function chord(press: string): string {
  return process.platform === 'darwin' ? press.replace(/^Control\+/, 'Meta+') : press;
}

function osName(): string {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return process.platform;
}

interface ProbeResult {
  group: ProbeKey['group'];
  keys: string;
  press: string;
  outcome: Outcome;
  // Why a key was counted as taken by the browser: a closed page, a navigation or a new window.
  detail?: 'page-closed' | 'navigated' | 'new-window';
  // Whether the app called preventDefault (only meaningful when the key arrived).
  prevented?: boolean;
  // Whether the palette dialog is open after the key (only for the palette probe).
  paletteOpen?: boolean;
  zoom?: { before: { scale: number; dpr: number }; after: { scale: number; dpr: number } };
}

async function readZoom(page: Page): Promise<{ scale: number; dpr: number }> {
  return page.evaluate(() => ({
    scale: window.visualViewport?.scale ?? 1,
    dpr: window.devicePixelRatio,
  }));
}

async function probeOne(browser: Browser, probe: ProbeKey): Promise<ProbeResult> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript(recorderScript(probe.code));
  const page = await context.newPage();
  try {
    await page.goto('/');
    await page.waitForLoadState('load');
    let navigated = false;
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigated = true;
    });
    // The bubble listener runs after the app's document listeners (see recorderScript).
    await page.evaluate((code: string) => {
      window.addEventListener('keydown', (event) => {
        if (event.code === code && window.__probe)
          window.__probe.prevented = event.defaultPrevented;
      });
    }, probe.code);
    const before = probe.zoom ? await readZoom(page) : undefined;

    let pressFailed = false;
    try {
      await page.keyboard.press(chord(probe.press));
    } catch {
      pressFailed = true;
    }
    await page.waitForTimeout(500);

    const result: ProbeResult = {
      group: probe.group,
      keys: probe.keys,
      press: chord(probe.press),
      outcome: 'not-arrived',
    };
    const newWindow = context.pages().some((p) => p !== page);
    if (page.isClosed() || pressFailed) {
      result.outcome = 'taken-by-browser';
      result.detail = 'page-closed';
      return result;
    }
    if (navigated || newWindow) {
      result.outcome = 'taken-by-browser';
      result.detail = newWindow ? 'new-window' : 'navigated';
    }
    const seen = await page.evaluate(() => window.__probe).catch(() => null);
    if (seen?.arrived) {
      if (result.outcome === 'not-arrived') result.outcome = 'arrived';
      result.prevented = seen.prevented === true;
    }
    if (probe.hard === 'arrives-and-opens-palette') {
      result.paletteOpen = await page
        .locator('[role="dialog"]')
        .first()
        .isVisible()
        .catch(() => false);
    }
    if (before) {
      result.zoom = { before, after: await readZoom(page) };
    }
    return result;
  } finally {
    await context.close().catch(() => undefined);
  }
}

test.describe('browser-reserved and second-group key probe', () => {
  test('press each key in a fresh page and record what the page sees', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(10 * 60_000);
    const results: ProbeResult[] = [];
    for (const probe of PROBES) {
      results.push(await probeOne(browser, probe));
    }

    const report = {
      browser: testInfo.project.name,
      os: osName(),
      platform: process.platform,
      version: browser.version(),
      results,
    };
    const outDir = fileURLToPath(new URL('../test-results', import.meta.url));
    mkdirSync(outDir, { recursive: true });
    const file = `${outDir}/keys-${testInfo.project.name}-${osName()}.json`;
    const body = JSON.stringify(report, null, 2);
    writeFileSync(file, body);
    await testInfo.attach('keys', { body, contentType: 'application/json' });

    // The hard assertions run after the report is written, so a failing key still leaves the data.
    const failures: string[] = [];
    for (const [i, probe] of PROBES.entries()) {
      const result = results[i];
      if (!result || !probe.hard) continue;
      if (result.outcome !== 'arrived') {
        failures.push(`${probe.keys}: ${result.outcome}`);
      } else if (probe.hard === 'arrives-and-opens-palette' && result.paletteOpen !== true) {
        failures.push(`${probe.keys}: arrived, but the palette did not open`);
      }
    }
    expect(failures, `hard key checks (report: ${file})`).toEqual([]);
  });
});
