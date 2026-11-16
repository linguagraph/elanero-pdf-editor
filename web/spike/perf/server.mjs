// W0.2 static server (spike-only). Serves web/spike/ the way GitHub Pages does for the measured
// bytes: gzip (level 9, when the client accepts it) and long-lived immutable caching. Nothing is
// fetched from a CDN at run time. Not cross-origin isolated, like the W0.1 harness.
//
//   node perf/server.mjs [port]        (default 8766, bound to 127.0.0.1)

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".py": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".zip": "application/zip",
  ".whl": "application/octet-stream",
  ".pdf": "application/pdf",
};

// Compressed bodies are cached in memory, so gzip -9 runs once per file, not once per request.
const gzipCache = new Map();

function body(filePath, acceptsGzip) {
  const raw = fs.readFileSync(filePath);
  if (!acceptsGzip) return { data: raw, encoding: null };
  if (!gzipCache.has(filePath)) {
    gzipCache.set(filePath, zlib.gzipSync(raw, { level: 9 }));
  }
  return { data: gzipCache.get(filePath), encoding: "gzip" };
}

export function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const filePath = path.join(ROOT, rel);
    if (!filePath.startsWith(ROOT + path.sep) || !fs.existsSync(filePath)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const accepts = String(req.headers["accept-encoding"] ?? "").includes("gzip");
    const { data, encoding } = body(filePath, accepts);
    const headers = {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "content-length": data.length,
      "cache-control": "max-age=31536000, immutable",
      vary: "Accept-Encoding",
    };
    if (encoding) headers["content-encoding"] = encoding;
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : data);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 8766);
  createServer().listen(port, "127.0.0.1", () => {
    console.log(`serving ${ROOT} on http://127.0.0.1:${port}`);
  });
}
