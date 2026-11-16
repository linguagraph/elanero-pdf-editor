// W0.3 probe 1 (spike-only): Node fetch, which does not enforce CORS, so every Access-Control-*
// header the service sends is visible. For each endpoint and origin: the preflight a browser would
// send (when one is needed), then the real request with the same Origin. Writes out/cors-raw.json.
// Exit 0 when the run completes, whatever the services answer; non-zero only on a harness error.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENDPOINTS, ORIGINS, corsRequestHeaders, needsPreflight, credential, secretsInUse } from "./services.mjs";
import { corsHeaders, redactHeaders, redactText } from "./redact.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "..", "out");
const TIMEOUT_MS = 20_000;
const USER_AGENT = "Elanero"; // generic on purpose: http.py USER_AGENT

async function send(url, init) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    return {
      status: res.status,
      finalUrl: redactText(res.url),
      cors: corsHeaders(res.headers),
      bodyStart: redactText(text.slice(0, 200)),
      error: null,
    };
  } catch (err) {
    // A network failure is a result, not a harness error: record its kind and move on.
    return { status: null, cors: {}, bodyStart: null, error: redactText(`${err.name}: ${err.cause?.code ?? err.message}`) };
  }
}

const records = [];
for (const endpoint of ENDPOINTS) {
  for (const target of ORIGINS) {
    const req = endpoint.build();
    const cors = corsRequestHeaders(req.headers);
    const preflightNeeded = needsPreflight(req.method, req.headers);
    const record = {
      endpoint: endpoint.id,
      service: endpoint.service,
      label: endpoint.label,
      origin: target.id,
      method: req.method,
      url: redactText(req.url),
      sentHeaders: redactHeaders({ "User-Agent": USER_AGENT, Origin: target.origin, ...req.headers }),
      realKey: credential(endpoint.service).real,
      preflightNeeded,
      preflight: null,
      actual: null,
    };
    if (preflightNeeded) {
      record.preflight = {
        requestHeaders: cors.join(","),
        ...(await send(req.url, {
          method: "OPTIONS",
          redirect: "follow",
          headers: {
            Origin: target.origin,
            "Access-Control-Request-Method": req.method,
            "Access-Control-Request-Headers": cors.join(","),
          },
        })),
      };
    }
    record.actual = await send(req.url, {
      method: req.method,
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Origin: target.origin, ...req.headers },
      body: req.body,
    });
    records.push(record);
    console.log(
      `${endpoint.id} ${target.id}: preflight ${record.preflight ? record.preflight.status ?? record.preflight.error : "none"}, actual ${record.actual.status ?? record.actual.error}`,
    );
  }
}

// Last guard: the output must not contain any secret value. A hit here is a bug in this file.
fs.mkdirSync(outDir, { recursive: true });
const text = JSON.stringify(
  { generatedAt: new Date().toISOString(), node: process.version, records },
  null,
  2,
);
for (const secret of secretsInUse()) {
  if (secret && text.includes(secret)) {
    console.error("::error::a secret value reached the raw output; not written");
    process.exit(3);
  }
}
fs.writeFileSync(path.join(outDir, "cors-raw.json"), text + "\n");
console.log(`wrote ${path.join(outDir, "cors-raw.json")}`);
