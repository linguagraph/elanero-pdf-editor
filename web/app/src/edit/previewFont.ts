// The paragraph editor's font preview (W6.8a 8a-1, design section 4.1). The box shows the
// document's own embedded font when the browser can load it: the program comes from
// `content.preview_font`, and is loaded as a private, in-memory FontFace that never leaves the tab.
// Until then, and when the browser rejects the program (bare CFF, Type 1, broken tables), the box
// uses a generic family, so it is always usable. The committed text is typeset by the engine, not
// by this preview.
import type { PageRpc } from '../engine/engineConnection';
import type { PreviewFamily } from '../rpc/generated';

// The generic family a font name maps to before the reply arrives, ported from the desktop's
// font-family guess: monospace names, then serif names, otherwise sans-serif.
export function familyOf(font: string): PreviewFamily {
  const name = font.toLowerCase();
  if (/mono|courier/.test(name)) return 'monospace';
  if (/times|georgia|serif/.test(name) && !/sans/.test(name)) return 'serif';
  return 'sans-serif';
}

// Loaded faces, by the hash of their program, for the life of the page: reopening the same font
// costs nothing. A face the browser rejects is cached as null, so it is not tried again.
const faces = new Map<string, Promise<string | null>>();

async function sha1Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function loadFace(name: string, program: ArrayBuffer): Promise<string | null> {
  try {
    const face = new FontFace(name, program);
    await face.load();
    document.fonts.add(face);
    return name;
  } catch {
    return null;
  }
}

// The CSS family name of the loaded program, or null when the browser cannot use it.
export async function loadPreviewFace(program: ArrayBuffer): Promise<string | null> {
  const hash = await sha1Hex(program);
  const name = `pdf-${hash.slice(0, 12)}`;
  let face = faces.get(hash);
  if (face === undefined) {
    face = loadFace(name, program);
    faces.set(hash, face);
  }
  return face;
}

// The font-family list for the editor's textarea: the document's face first, then the generic
// family the engine names. Asks the engine for the program of `font` on `page`.
export async function previewFamilyCss(
  rpc: PageRpc,
  handle: string,
  page: number,
  font: string,
): Promise<string> {
  const reply = await rpc.call('content.preview_font', { handle, page, font_name: font });
  if (!reply.found || reply.program === null) return reply.family;
  const name = await loadPreviewFace(reply.program);
  return name === null ? reply.family : `"${name}", ${reply.family}`;
}
