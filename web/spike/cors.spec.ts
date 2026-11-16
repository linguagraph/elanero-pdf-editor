// W0.3 browser probe (spike-only). Serves cors/probe.html under the real origins (page.route, so
// nothing is deployed) and runs each service request from there, in Chromium, Firefox and WebKit.
// The external API calls go to the network. Writes out/cors-browser-<browser>.json.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { ENDPOINTS, ORIGINS, secretsInUse } from "./cors/services.mjs";
import { redactText, redactHeaders } from "./cors/redact.mjs";

const OUT = path.join(__dirname, "out");
const PROBE_HTML = fs.readFileSync(path.join(__dirname, "cors", "probe.html"), "utf8");

// Every string the page returned goes through the redaction too (an error message can echo a key).
function deepRedact(value: unknown): any {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(deepRedact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepRedact(v)]));
  }
  return value;
}

test("translation CORS from each origin", async ({ page, browserName }) => {
  const consoleLines: { type: string; text: string }[] = [];
  page.on("console", (msg) => {
    consoleLines.push({ type: msg.type(), text: redactText(msg.text()) });
  });

  for (const target of ORIGINS) {
    const pattern = target.pageUrl;
    await page.route(pattern, (route) =>
      route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: PROBE_HTML }),
    );
  }

  const byOrigin: Record<string, Record<string, unknown>> = {};
  for (const target of ORIGINS) {
    await page.goto(target.pageUrl);
    const origin = await page.evaluate(() => window.location.origin);
    expect(origin, "probe page origin").toBe(target.origin);
    const results: Record<string, unknown> = {};
    consoleLines.length = 0;
    for (const endpoint of ENDPOINTS) {
      const request = endpoint.build();
      // A browser cannot set User-Agent, so the request leaves it out (the raw probe sends it).
      const headers = { ...request.headers };
      delete (headers as Record<string, string>)["User-Agent"];
      const sent = await page.evaluate(
        (req) => (window as any).runOne(req),
        { url: request.url, method: request.method, headers, body: request.body },
      );
      results[endpoint.id] = {
        service: endpoint.service,
        method: request.method,
        url: redactText(request.url),
        sentHeaders: redactHeaders(headers),
        ...deepRedact(sent),
      };
    }
    byOrigin[target.id] = {
      origin: target.origin,
      endpoints: results,
      console: consoleLines.map((line) => ({ ...line })),
    };
  }

  const version = page.context().browser()?.version() ?? "unknown";
  const out = {
    browser: browserName,
    version,
    generatedAt: new Date().toISOString(),
    origins: byOrigin,
  };
  const text = JSON.stringify(out, null, 2) + "\n";
  for (const secret of secretsInUse()) {
    expect(text.includes(secret), "no secret value in the browser output").toBe(false);
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `cors-browser-${browserName}.json`), text);
});
