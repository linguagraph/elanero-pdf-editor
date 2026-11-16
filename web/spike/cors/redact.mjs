// W0.3 (spike-only): every recorded output passes through here. Key headers are replaced whole,
// and any secret value that appears anywhere else (an error message, a console line) is replaced.
import { secretsInUse } from "./services.mjs";

const KEY_HEADERS = new Set([
  "authorization",
  "ocp-apim-subscription-key",
  "ocp-apim-subscription-region",
]);
export const REDACTED = "[redacted]";

export function redactText(text) {
  let out = String(text ?? "");
  for (const secret of secretsInUse()) {
    if (secret) out = out.split(secret).join(REDACTED);
  }
  return out;
}

export function redactHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    out[name] = KEY_HEADERS.has(name.toLowerCase()) ? REDACTED : redactText(value);
  }
  return out;
}

// The access-control-* response headers as [name, value] pairs, lower case, values redacted.
export function corsHeaders(pairs) {
  const out = {};
  for (const [name, value] of pairs) {
    const lower = name.toLowerCase();
    if (lower.startsWith("access-control-")) out[lower] = redactText(value);
  }
  return out;
}
