// W0.2 performance driver (spike-only). Opens perf/index.html for each fixture, five times over.
// Each run uses a persistent profile in a fresh, empty directory: cold = the first load in it,
// warm = a reload in the same profile, so the HTTP disk cache is used. (A browser.newContext()
// profile did not keep the 18 MB PyMuPDF wheel across the reload: its transferSize was the full
// 18 MB on every warm run, verified against a persistent profile where it was 0.)
// Writes out/perf-<env>[-<browser>].json: the raw numbers that perf/report.py turns into the tables
// of docs/web/spikes/W0.2-results.md. Budgets are not asserted here: a missed budget is a finding,
// so the job fails only when the harness itself cannot run.
//
// Environment: PERF_ENV (ci | laptop), PERF_RUNS (default 5), PERF_FIXTURES (comma list; the
// local-only scanned sample is skipped when it is not staged), PERF_CPU_THROTTLE (the mid-range
// proxy, see throttle() below).
import { test, expect, chromium, firefox, webkit, type BrowserContext, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LAUNCHERS = { chromium, firefox, webkit } as const;

const ENV = process.env.PERF_ENV ?? "local";
const RUNS = Number(process.env.PERF_RUNS ?? 5);
const FIXTURES = (
  process.env.PERF_FIXTURES ??
  "perf_mixed_10.pdf,perf_mixed_200.pdf,perf_mixed_1000.pdf,scanned_dryer.pdf"
).split(",");
// PERF_CPU_THROTTLE=4 is the mid-range proxy: Chromium CPU throttling at 4x. It reaches the page's
// main thread. Chromium refuses the same command for dedicated workers ("only supported for pages,
// not workers"), so the engine worker runs at full speed; every refusal is recorded in the run.
const THROTTLE = Number(process.env.PERF_CPU_THROTTLE ?? 0);
const OUT = path.join(__dirname, "out");
const STAGED = path.join(__dirname, "dist", "perf", "fixtures");

type ThrottleState = { rate: number; page: string; workers: string[] };

// Throttles the page and every dedicated worker it starts. Workers are found with
// Target.setAutoAttach on the page's CDP session. flatten is false: Playwright's public
// CDPSession.send cannot address a flattened child session, while a non-flattened child is driven
// through Target.sendMessageToTarget on the page session, which it can.
async function throttle(page: Page): Promise<ThrottleState | null> {
  if (!THROTTLE) return null;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
  const state: ThrottleState = { rate: THROTTLE, page: "applied", workers: [] };
  let nextId = 1_000_000;
  const replies = new Map<number, (msg: { error?: { message: string } }) => void>();
  cdp.on("Target.receivedMessageFromTarget", (event: { message: string }) => {
    const msg = JSON.parse(event.message) as { id: number; error?: { message: string } };
    replies.get(msg.id)?.(msg);
    replies.delete(msg.id);
  });
  cdp.on(
    "Target.attachedToTarget",
    async (event: { sessionId: string; targetInfo: { type: string } }) => {
      if (event.targetInfo.type !== "worker") return;
      const id = nextId++;
      const reply = new Promise<{ error?: { message: string } }>((resolve) =>
        replies.set(id, resolve),
      );
      await cdp.send("Target.sendMessageToTarget", {
        sessionId: event.sessionId,
        message: JSON.stringify({
          id,
          method: "Emulation.setCPUThrottlingRate",
          params: { rate: THROTTLE },
        }),
      });
      const msg = await reply;
      state.workers.push(msg.error ? `refused: ${msg.error.message}` : "applied");
    },
  );
  await cdp.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: false,
  });
  return state;
}

// The same fixed CPU loop on the main thread and in a fresh dedicated worker, after the scenario.
// This is the check that the throttle reached each thread: a throttled thread is ~THROTTLE x slower.
async function calibrate(page: Page): Promise<{ mainMs: number; workerMs: number }> {
  return page.evaluate(async () => {
    const work = () => {
      const t = performance.now();
      let x = 0;
      for (let i = 0; i < 3e7; i++) x += i % 7;
      return { ms: performance.now() - t, x };
    };
    const src = `self.onmessage = () => { const t = performance.now(); let x = 0; for (let i = 0; i < 3e7; i++) x += i % 7; self.postMessage(performance.now() - t); };`;
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    const workerMs = await new Promise<number>((resolve) => {
      const w = new Worker(url);
      w.onmessage = (e) => {
        resolve(e.data);
        w.terminate();
      };
      w.postMessage(0);
    });
    URL.revokeObjectURL(url);
    return { mainMs: work().ms, workerMs };
  });
}

async function runScenario(page: Page, fixture: string) {
  await page.goto(`/perf/index.html?fixture=${encodeURIComponent(fixture)}`);
  await page.waitForFunction(() => (window as any).__perf?.done === true, null, {
    timeout: 60 * 60_000,
  });
  return page.evaluate(() => (window as any).__perf);
}

function appendRun(file: string, header: object, run: object) {
  fs.mkdirSync(OUT, { recursive: true });
  const current = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : { ...header, runs: [] };
  current.runs.push(run);
  fs.writeFileSync(file, JSON.stringify(current, null, 2));
}

for (const fixture of FIXTURES) {
  test(`fixture ${fixture}`, async ({ browser, browserName }) => {
    test.setTimeout(90 * 60_000);
    const staged = path.join(STAGED, fixture);
    test.skip(!fs.existsSync(staged), `${fixture} is not staged (local-only sample)`);

    const file = path.join(
      OUT,
      `perf-${ENV}${browserName === "chromium" ? "" : `-${browserName}`}.json`,
    );
    const cpus = os.cpus();
    const header = {
      env: ENV,
      browser: browserName,
      browserVersion: browser.version(),
      machine: {
        platform: `${os.platform()} ${os.release()}`,
        cpu: cpus[0]?.model ?? "unknown",
        cores: cpus.length,
        ramBytes: os.totalmem(),
      },
      runsRequested: RUNS,
      fixtureBytes: fs.statSync(staged).size,
      cpuThrottle: THROTTLE || null,
    };

    const launcher = LAUNCHERS[browserName as keyof typeof LAUNCHERS];
    for (let run = 1; run <= RUNS; run++) {
      // A new, empty profile per run: the cold load really starts with an empty HTTP cache.
      const profile = path.join(OUT, "profiles", `${browserName}-${fixture}-${run}`);
      fs.rmSync(profile, { recursive: true, force: true });
      fs.mkdirSync(profile, { recursive: true });
      const context: BrowserContext = await launcher.launchPersistentContext(profile, {
        headless: true,
      });
      const page = context.pages()[0] ?? (await context.newPage());
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      page.on("pageerror", (err) => pageErrors.push(err.message));
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
      const throttled = await throttle(page);

      const cold = await runScenario(page, fixture);
      await page.reload();
      const warm = await runScenario(page, fixture);
      const calibration = throttled ? await calibrate(page) : null;
      await context.close();
      fs.rmSync(profile, { recursive: true, force: true });

      appendRun(file, header, {
        fixture,
        run,
        cold,
        warm,
        pageErrors,
        consoleErrors,
        throttle: throttled ? { ...throttled, calibration } : null,
      });
    }

    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    const recorded = written.runs.filter((r: { fixture: string }) => r.fixture === fixture);
    expect(recorded.length, "runs recorded").toBe(RUNS);
  });
}
