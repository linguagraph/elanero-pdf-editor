// W0.3 (spike-only): the four translation services as the desktop clients send them. Nothing here
// is imported by the app. Each entry names the desktop file it mirrors:
//   mymemory.py       MyMemoryTranslator.translate, test_connection ("Hello", en -> fr)
//   deepl.py          DeepLTranslator.translate, test_connection (GET /v2/usage), host_for
//   azure.py          AzureTranslator._url, _headers, _request, test_connection ("Hello", en -> de)
//   libretranslate.py _body, translate, fetch_languages (GET /languages)
//   http.py           request_json: User-Agent "Elanero", Accept application/json, JSON bodies
//                     sent as "application/json; charset=utf-8" (Azure: "...charset=UTF-8")
// The text is always the word "Hello". Keys are fake unless the maintainer opts in (realValue).

export const ORIGINS = [
  {
    id: "production",
    origin: "https://linguagraph.github.io",
    // Fulfilled locally by the spec (page.route): the origin is real, nothing is deployed.
    pageUrl: "https://linguagraph.github.io/elanero-pdf-editor/app/cors-probe.html",
  },
  {
    id: "dev",
    origin: "http://localhost:5173",
    pageUrl: "http://localhost:5173/elanero-pdf-editor/app/cors-probe.html",
  },
];

export const FAKE_KEY = "fake-key-for-cors-probe";
// Keys ending ":fx" use DeepL's free host (deepl.py host_for). The fake key carries that suffix so
// the probe reaches the host the design names (api-free.deepl.com).
const DEEPL_FAKE = `${FAKE_KEY}:fx`;
const AZURE_FAKE_REGION = "fake-region-for-cors-probe";

// The maintainer's optional real-key path. A value is used only when its service is named in
// ELANERO_PROBE_REAL_SERVICES (for example "deepl,azure"), its variable is set, and the run is
// not in CI. Nothing here prints a value; redact.mjs replaces every value in every output.
const REAL_VARS = {
  deepl: "ELANERO_PROBE_DEEPL_KEY",
  azure: "ELANERO_PROBE_AZURE_KEY",
  libretranslate: "ELANERO_PROBE_LIBRE_KEY",
};
const REAL_REGION_VAR = "ELANERO_PROBE_AZURE_REGION";

function realValue(service, variable) {
  if (process.env.CI || process.env.GITHUB_ACTIONS) return null;
  const named = (process.env.ELANERO_PROBE_REAL_SERVICES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!named.includes(service)) return null;
  const value = (process.env[variable] ?? "").trim();
  return value || null;
}

// The value a service's requests carry, and whether it is real.
export function credential(service) {
  const fake = service === "deepl" ? DEEPL_FAKE : FAKE_KEY;
  const real = REAL_VARS[service] ? realValue(service, REAL_VARS[service]) : null;
  return { value: real ?? fake, real: real !== null };
}

function azureRegion() {
  const real = realValue("azure", REAL_REGION_VAR);
  return { value: real ?? AZURE_FAKE_REGION, real: real !== null };
}

// deepl.py host_for: keys ending ":fx" go to the free host, anything else to the Pro host.
function deeplHost(key) {
  return key.trim().endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com";
}

// Every secret value in use in this run, for redaction (the fake and any real ones).
export function secretsInUse() {
  const values = [FAKE_KEY, DEEPL_FAKE, AZURE_FAKE_REGION];
  for (const service of Object.keys(REAL_VARS)) values.push(credential(service).value);
  values.push(azureRegion().value);
  return [...new Set(values)];
}

// The endpoints. build() returns the request as the desktop sends it.
export const ENDPOINTS = [
  {
    id: "mymemory-get",
    service: "mymemory",
    label: "MyMemory GET /get (translate)",
    build: () => ({
      method: "GET",
      url: `https://api.mymemory.translated.net/get?${new URLSearchParams({
        q: "Hello",
        langpair: "en|fr",
      })}`,
      headers: { Accept: "application/json" },
      body: undefined,
    }),
  },
  {
    id: "deepl-translate",
    service: "deepl",
    label: "DeepL POST /v2/translate",
    build: () => {
      const key = credential("deepl").value;
      return {
        method: "POST",
        url: `${deeplHost(key)}/v2/translate`,
        headers: {
          Authorization: `DeepL-Auth-Key ${key}`,
          Accept: "application/json",
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ text: ["Hello"], target_lang: "DE", source_lang: "EN" }),
      };
    },
  },
  {
    id: "deepl-usage",
    service: "deepl",
    label: "DeepL GET /v2/usage (Test connection)",
    build: () => {
      const key = credential("deepl").value;
      return {
        method: "GET",
        url: `${deeplHost(key)}/v2/usage`,
        headers: {
          Authorization: `DeepL-Auth-Key ${key}`,
          Accept: "application/json",
        },
        body: undefined,
      };
    },
  },
  {
    id: "azure-translate",
    service: "azure",
    label: "Azure POST /translate (api-version 3.0)",
    build: () => ({
      method: "POST",
      url: `https://api.cognitive.microsofttranslator.com/translate?${new URLSearchParams([
        ["api-version", "3.0"],
        ["to", "de"],
        ["from", "en"],
      ])}`,
      // The region header is sent only when one is configured (azure.py _headers). The probe
      // always sends it so the preflight covers it; the value is a placeholder unless real.
      headers: {
        "Ocp-Apim-Subscription-Key": credential("azure").value,
        "Ocp-Apim-Subscription-Region": azureRegion().value,
        Accept: "application/json",
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify([{ Text: "Hello" }]),
    }),
  },
  {
    id: "libre-languages",
    service: "libretranslate",
    label: "LibreTranslate GET /languages",
    build: () => ({
      method: "GET",
      url: "https://libretranslate.com/languages",
      headers: { Accept: "application/json" },
      body: undefined,
    }),
  },
  {
    id: "libre-translate",
    service: "libretranslate",
    label: "LibreTranslate POST /translate (key in the body)",
    build: () => ({
      method: "POST",
      url: "https://libretranslate.com/translate",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        q: "Hello",
        source: "en",
        target: "de",
        format: "text",
        api_key: credential("libretranslate").value,
      }),
    }),
  },
];

// A browser cannot set User-Agent (the raw probe sends it, as the desktop does). Accept and
// Accept-Language are safelisted, and a JSON Content-Type is not, so it is listed.
const SAFELISTED = new Set(["accept", "accept-language", "content-language"]);
const SIMPLE_TYPES = new Set([
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain",
]);

// The names a browser lists in Access-Control-Request-Headers: the non-safelisted ones, lower
// case, sorted, comma-separated.
export function corsRequestHeaders(headers) {
  const names = [];
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (lower === "user-agent" || SAFELISTED.has(lower)) continue;
    if (lower === "content-type") {
      const mime = headers[name].split(";")[0].trim().toLowerCase();
      if (SIMPLE_TYPES.has(mime)) continue;
    }
    names.push(lower);
  }
  return names.sort();
}

// A simple request (GET, HEAD or POST, no non-safelisted headers) needs no preflight.
export function needsPreflight(method, headers) {
  return !(["GET", "HEAD", "POST"].includes(method) && corsRequestHeaders(headers).length === 0);
}
