// W0.2 performance driver (spike-only). Opens perf/index.html for each fixture, once in a new
// browser context (cold: empty HTTP cache) and once after a reload in that context (warm), five
// times over. Writes out/perf-<env>[-<browser>].json: the raw numbers that perf/report.py turns into
// the tables of docs/web/spikes/W0.2-results.md. Budgets are not asserted here: a missed budget is
// a finding, so the job fails only when the harness itself cannot run.
//
// Environment: PERF_ENV (ci | laptop), PERF_RUNS (default 5), PERF_FIXTURES (comma list; the
// local-only scanned sample is skipped when it is not staged).
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ENV = process.env.PERF_ENV ?? "local";
const RUNS = Number(process.env.PERF_RUNS ?? 5);
const FIXTURES = (
  process.env.PERF_FIXTURES ??
  "perf_mixed_10.pdf,perf_mixed_200.pdf,perf_mixed_1000.pdf,scanned_dryer.pdf"
).split(",");
const OUT = path.join(__dirname, "out");
const STAGED = path.join(__dirname, "dist", "perf", "fixtures");

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
    };

    for (let run = 1; run <= RUNS; run++) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      page.on("pageerror", (err) => pageErrors.push(err.message));
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });

      const cold = await runScenario(page, fixture);
      await page.reload();
      const warm = await runScenario(page, fixture);
      await context.close();

      appendRun(file, header, { fixture, run, cold, warm, pageErrors, consoleErrors });
    }

    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    const recorded = written.runs.filter((r: { fixture: string }) => r.fixture === fixture);
    expect(recorded.length, "runs recorded").toBe(RUNS);
  });
}
