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

function reply(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(text);
}

export function createServer() {
  return http.createServer((req, res) => {
    // A malformed path (a bad % escape), a directory, or a read error must answer, not throw: an
    // uncaught error in a request handler would take the whole server down.
    try {
      let rel;
      try {
        rel = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
      } catch {
        return reply(res, 400, "bad request");
      }
      if (rel.endsWith("/")) rel += "index.html";
      const filePath = path.join(ROOT, rel);
      if (!filePath.startsWith(ROOT + path.sep)) return reply(res, 404, "not found");
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return reply(res, 404, "not found");
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
    } catch (err) {
      console.error(`request failed: ${err instanceof Error ? err.message : err}`);
      if (res.headersSent) res.destroy();
      else reply(res, 500, "server error");
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 8766);
  createServer().listen(port, "127.0.0.1", () => {
    console.log(`serving ${ROOT} on http://127.0.0.1:${port}`);
  });
}
