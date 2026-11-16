// W0.1 browser smoke (spike-only). Opens smoke/index.html, which runs the engine in a Web Worker,
// and asserts each of the six steps. Writes out/smoke.pdf (the saved bytes) and
// out/smoke-summary.json for the host-side check (verify_host.py) and the results report.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.join(__dirname, "out");
const STEPS = ["open", "render", "edit", "annotate", "save", "reopen"];

test("Pyodide worker: open, render, edit, annotate, save, reopen", async ({ page }) => {
  for (const needed of ["dist/wheel.json", "dist/input.pdf", "dist/src-manifest.json"]) {
    expect(fs.existsSync(path.join(__dirname, needed)), `${needed} (run prepare first)`).toBe(
      true,
    );
  }

  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await page.goto("/smoke/index.html");
  await page.waitForFunction(() => (window as any).__smoke?.done === true, null, {
    timeout: 10 * 60_000,
  });
  const smoke = await page.evaluate(() => (window as any).__smoke);

  fs.mkdirSync(OUT, { recursive: true });
  const { savedBase64, ...summary } = smoke;
  fs.writeFileSync(
    path.join(OUT, "smoke-summary.json"),
    JSON.stringify({ ...summary, pageErrors, consoleErrors }, null, 2),
  );
  if (savedBase64) {
    fs.writeFileSync(path.join(OUT, "smoke.pdf"), Buffer.from(savedBase64, "base64"));
  }

  expect(smoke.errors, "page and worker errors").toEqual([]);
  expect(pageErrors, "uncaught page errors").toEqual([]);
  expect(smoke.crossOriginIsolated, "no SharedArrayBuffer (not cross-origin isolated)").toBe(
    false,
  );
  expect(smoke.result, "engine result").toBeDefined();
  expect(smoke.result.steps.map((s: { step: string }) => s.step)).toEqual(STEPS);
  for (const s of smoke.result.steps as { step: string; ok: boolean; error: string | null }[]) {
    expect(s.error, `step ${s.step}`).toBeNull();
    expect(s.ok, `step ${s.step}`).toBe(true);
  }
  expect(savedBase64, "saved bytes").toBeTruthy();
});
