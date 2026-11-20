// The name a saved or downloaded document gets (W4.8). It is the tab's name, lightly cleaned: the
// characters a file system refuses are removed and the .pdf suffix is kept. This is not the Python
// safe_name, which would turn "report (1).pdf" into "report _1_.pdf" and so defeat "same name".

// The characters no common file system accepts in a name.
const REFUSED = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|']);

// The text without the refused characters and the control characters (below the space).
function withoutRefused(text: string): string {
  return Array.from(text)
    .filter((ch) => !REFUSED.has(ch) && ch.charCodeAt(0) >= 32)
    .join('')
    .trim();
}

// A name for a download: trimmed and cleaned, with the .pdf suffix. A blank name gives the fallback
// (also cleaned, with the suffix).
export function pdfFileName(raw: string, fallback: string): string {
  const cleaned = withoutRefused(raw);
  const stem = cleaned === '' ? withoutRefused(fallback) : cleaned;
  return /\.pdf$/i.test(stem) ? stem : `${stem}.pdf`;
}
