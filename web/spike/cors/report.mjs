// W0.3 (spike-only): combines out/cors-raw.json and out/cors-browser-*.json into the verdicts and
// the Markdown tables that docs/web/spikes/W0.3-results.md quotes. Writes out/cors-report.md and
// out/cors-verdicts.json, and prints the Markdown. Exit 0 unless an input file is missing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENDPOINTS, ORIGINS, secretsInUse } from "./services.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "..", "out");
const raw = JSON.parse(fs.readFileSync(path.join(outDir, "cors-raw.json"), "utf8"));
const BROWSERS = ["chromium", "firefox", "webkit"];
const browsers = Object.fromEntries(
  BROWSERS.map((b) => [b, JSON.parse(fs.readFileSync(path.join(outDir, `cors-browser-${b}.json`), "utf8"))]),
);

const acaoAllows = (acao, origin) => acao === "*" || acao === origin;
const listHas = (list, name) => {
  const items = (list ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return items.includes("*") || items.includes(name.toLowerCase());
};

// The raw verdict for one endpoint and origin, from the preflight (when one is needed) and the
// real response. Rules (docs/web/design/W0.3.md): a preflight that is rejected, or lacks the origin
// or a needed header, is blocked; the origin on the response is allowed, on any status; no origin on
// a 2xx is blocked; no origin on an error status (or a network failure) is inconclusive.
function rawVerdict(rec, origin) {
  if (rec.preflightNeeded) {
    const pf = rec.preflight;
    if (pf.error) return { verdict: "inconclusive", why: `preflight: ${pf.error}` };
    const acao = pf.cors["access-control-allow-origin"];
    if (!acao) return { verdict: "blocked", why: "preflight: no Access-Control-Allow-Origin" };
    if (!acaoAllows(acao, origin)) return { verdict: "blocked", why: `preflight: origin not allowed (${acao})` };
    if (pf.status < 200 || pf.status > 299) return { verdict: "blocked", why: `preflight: HTTP ${pf.status}` };
    const acah = pf.cors["access-control-allow-headers"] ?? "";
    const missingHeaders = pf.requestHeaders.split(",").filter((h) => h && !listHas(acah, h));
    if (missingHeaders.length) {
      return { verdict: "blocked", why: `preflight: headers not allowed (${missingHeaders.join(", ")})` };
    }
    if (!listHas(pf.cors["access-control-allow-methods"], rec.method)) {
      return { verdict: "blocked", why: `preflight: method ${rec.method} not allowed` };
    }
  }
  const actual = rec.actual;
  if (actual.error) return { verdict: "inconclusive", why: `request: ${actual.error}` };
  const acao = actual.cors["access-control-allow-origin"];
  if (acao) {
    if (acaoAllows(acao, origin)) return { verdict: "allowed", why: `Access-Control-Allow-Origin on HTTP ${actual.status}` };
    return { verdict: "blocked", why: `response: origin not allowed (${acao})` };
  }
  if (actual.status >= 200 && actual.status < 300) {
    return { verdict: "blocked", why: `HTTP ${actual.status} without Access-Control-Allow-Origin` };
  }
  return { verdict: "inconclusive", why: `no Access-Control-Allow-Origin on HTTP ${actual.status}` };
}

// The browser result for an endpoint and origin: resolved (CORS passed) or rejected (TypeError).
function browserResult(browser, originId, endpointId) {
  const entry = browsers[browser].origins[originId].endpoints[endpointId];
  return entry.result === "rejected" ? "rejected" : `resolved ${entry.status}`;
}

// Final verdict: the raw verdict, unless the browsers disagree with it. Every engine has to agree.
function finalVerdict(raw, originId, endpointId) {
  const results = BROWSERS.map((b) => browserResult(b, originId, endpointId));
  const passed = results.filter((r) => r.startsWith("resolved")).length;
  if (raw.verdict === "allowed" && passed === BROWSERS.length) return { verdict: "allowed", why: raw.why, results };
  if (raw.verdict === "blocked" && passed === 0) return { verdict: "blocked", why: raw.why, results };
  if (raw.verdict === "inconclusive") return { verdict: "inconclusive", why: raw.why, results };
  return { verdict: "inconclusive", why: `${raw.why}; browsers disagree (${results.join(" / ")})`, results };
}

const verdicts = [];
for (const endpoint of ENDPOINTS) {
  const perOrigin = {};
  for (const target of ORIGINS) {
    const rec = raw.records.find((r) => r.endpoint === endpoint.id && r.origin === target.id);
    const raw1 = rawVerdict(rec, target.origin);
    perOrigin[target.id] = { raw: raw1, final: finalVerdict(raw1, target.id, endpoint.id), record: rec };
  }
  verdicts.push({ endpoint, perOrigin });
}

// Service level: a service is in the web build only if every endpoint it uses is allowed.
// A service is allowed when all its endpoints are, blocked when any is blocked, else inconclusive.
const services = {};
for (const { endpoint, perOrigin } of verdicts) {
  const states = ORIGINS.map((o) => perOrigin[o.id].final.verdict);
  const own = states.includes("blocked") ? "blocked" : states.every((s) => s === "allowed") ? "allowed" : "inconclusive";
  const previous = services[endpoint.service] ?? "allowed";
  const order = ["allowed", "inconclusive", "blocked"];
  services[endpoint.service] = order[Math.max(order.indexOf(previous), order.indexOf(own))];
}

const lines = [];
const line = (s = "") => lines.push(s);
line("## Verdicts per endpoint and origin");
line();
line("| Service | Endpoint | Origin | Preflight | Access-Control-Allow-Origin | Browsers (Chromium / Firefox / WebKit) | Verdict | Reason |");
line("|---|---|---|---|---|---|---|---|");
for (const { endpoint, perOrigin } of verdicts) {
  for (const target of ORIGINS) {
    const v = perOrigin[target.id];
    const rec = v.record;
    const pf = rec.preflightNeeded
      ? rec.preflight.error ? `error` : `HTTP ${rec.preflight.status}`
      : "none (simple)";
    const acao = (rec.preflightNeeded ? rec.preflight.cors["access-control-allow-origin"] : undefined)
      ?? rec.actual.cors["access-control-allow-origin"] ?? "-";
    line(
      `| ${endpoint.service} | ${endpoint.label} | ${target.origin} | ${pf} | ${acao} | ${v.final.results.join(" / ")} | **${v.final.verdict}** | ${v.final.why} |`,
    );
  }
}
line();
line("## Services");
line();
line("| Service | Verdict (every endpoint, both origins) |");
line("|---|---|");
for (const [service, state] of Object.entries(services)) line(`| ${service} | **${state}** |`);
line();
line("## Response headers (production origin, raw probe)");
line();
line("| Endpoint | Preflight status | Preflight allow-origin | Preflight allow-headers | Preflight allow-methods | Response status | Response allow-origin |");
line("|---|---|---|---|---|---|---|");
for (const { endpoint, perOrigin } of verdicts) {
  const rec = perOrigin.production.record;
  const pf = rec.preflight;
  line(
    `| ${endpoint.id} | ${pf ? pf.status ?? pf.error : "none"} | ${pf?.cors["access-control-allow-origin"] ?? "-"} | ${pf?.cors["access-control-allow-headers"] ?? "-"} | ${pf?.cors["access-control-allow-methods"] ?? "-"} | ${rec.actual.status ?? rec.actual.error} | ${rec.actual.cors["access-control-allow-origin"] ?? "-"} |`,
  );
}
line();
line("## Browser versions");
line();
for (const b of BROWSERS) line(`- ${b}: ${browsers[b].version}`);

const markdown = lines.join("\n") + "\n";
const verdictsJson =
  JSON.stringify(
    verdicts.map(({ endpoint, perOrigin }) => ({
      endpoint: endpoint.id,
      service: endpoint.service,
      origins: Object.fromEntries(
        Object.entries(perOrigin).map(([id, v]) => [id, { verdict: v.final.verdict, why: v.final.why, browsers: v.final.results }]),
      ),
    })),
    null,
    2,
  ) + "\n";

// Refuse to write a file that still holds a secret value (the same guard as raw_probe.mjs).
for (const [name, text] of [["cors-report.md", markdown], ["cors-verdicts.json", verdictsJson]]) {
  for (const secret of secretsInUse()) {
    if (secret && text.includes(secret)) {
      console.error(`::error::a secret value reached ${name}; not written`);
      process.exit(3);
    }
  }
}
fs.writeFileSync(path.join(outDir, "cors-report.md"), markdown);
fs.writeFileSync(path.join(outDir, "cors-verdicts.json"), verdictsJson);
process.stdout.write(markdown);
