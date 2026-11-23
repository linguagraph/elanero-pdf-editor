// The preview face of an uploaded font (W6.8b 8b-3, design section 10). The bytes come from the
// tab's private store through the font library, and load as a FontFace named by the font id. One
// face per id for the life of the page; a face the browser rejects is cached as null.
import type { FontLibrary } from '../fonts/fontLibrary';
import type { FontRefArg } from './textStyle';

// An uploaded font's path is /fonts/<sha256>.<ext> (the engine's catalogue path).
const UPLOAD_PATH = /\/fonts\/([0-9a-f]{64})\./;

const faces = new Map<string, Promise<string | null>>();

// The font id of an uploaded face's ref, or null for any other ref.
export function uploadedIdOf(ref: FontRefArg | null): string | null {
  if (ref?.kind !== 'file') return null;
  return UPLOAD_PATH.exec(ref.path)?.[1] ?? null;
}

// The CSS family name the uploaded font's face loads under, or null when the browser can't use it.
export function uploadedPreviewFace(library: FontLibrary, id: string): Promise<string | null> {
  let face = faces.get(id);
  if (face === undefined) {
    face = loadFace(library, id);
    faces.set(id, face);
  }
  return face;
}

async function loadFace(library: FontLibrary, id: string): Promise<string | null> {
  try {
    const blob = await library.bytes(id);
    if (blob === undefined) return null;
    const name = `upl-${id}`;
    const face = new FontFace(name, await blob.arrayBuffer());
    await face.load();
    document.fonts.add(face);
    return name;
  } catch {
    return null;
  }
}
