// First-page previews of the recent files (issue 757). A preview is document content, so it is kept
// only in this browser's private storage, is never uploaded, and is never made for an encrypted
// file. The file name is the sha256 of the recent name, so the folder shows no names. Every call
// can fail (no private storage, a full disk, a refused render), and a failure only means no preview:
// the start page then shows the file icon.
import type { EngineClient } from '../engine/engineConnection';
import { cleanRecentName, type RecentFile } from './recentFiles';
import { type DirectoryLike, privateRoot } from '../storage/opfs';
import { drawPixels } from '../view/pixels';
import { MAX_RENDER_SCALE_MILLI, quantizeScale } from '../view/zoom';

export const RECENT_THUMBS_FOLDER = 'recent-thumbs';
// The preview box in CSS pixels, scaled by the device pixel ratio (capped at 2).
export const THUMB_WIDTH_CSS_PX = 112;
export const THUMB_HEIGHT_CSS_PX = 144;
const THUMB_QUALITY = 0.8;
const MAX_DEVICE_RATIO = 2;

export interface RecentThumbs {
  // Keeps a preview for a name. An encrypted file is never kept; the result is false then, and
  // false too when the browser refuses the write.
  save(name: string, jpeg: Blob, encrypted: boolean): Promise<boolean>;
  // The previews that exist for these names. A missing or unreadable one is left out.
  load(names: readonly string[]): Promise<Map<string, Blob>>;
  // Deletes every preview whose name is not in the list.
  prune(names: readonly string[]): Promise<void>;
  // Deletes the preview of one name, if any. Used when the file now under that name has no preview
  // (encrypted, or it would not render): the old file's preview must not stay under the name.
  remove(name: string): Promise<void>;
}

// The file name of a recent name: its sha256 in hex, with the .jpg extension.
export async function thumbFileName(name: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'));
  return `${hex.join('')}.jpg`;
}

// The store over the browser's private root. A test passes its own root.
export function createRecentThumbs(root: () => Promise<DirectoryLike> = privateRoot): RecentThumbs {
  // The preview folder, or null when it cannot be reached (none is made when create is false).
  async function folder(create: boolean): Promise<DirectoryLike | null> {
    try {
      return await (await root()).getDirectoryHandle(RECENT_THUMBS_FOLDER, { create });
    } catch {
      return null;
    }
  }

  return {
    async save(name, jpeg, encrypted) {
      if (encrypted) return false;
      try {
        const dir = await folder(true);
        if (dir === null) return false;
        const file = await dir.getFileHandle(await thumbFileName(name), { create: true });
        const writable = await file.createWritable();
        await writable.write(jpeg);
        await writable.close();
        return true;
      } catch {
        return false;
      }
    },

    async load(names) {
      const found = new Map<string, Blob>();
      const dir = await folder(false);
      if (dir === null) return found;
      for (const name of names) {
        try {
          const file = await dir.getFileHandle(await thumbFileName(name));
          // The browser's file is a Blob (a File); the storage types only name what the store uses.
          found.set(name, (await file.getFile()) as Blob);
        } catch {
          // Not kept, or unreadable: the row shows the file icon.
        }
      }
      return found;
    },

    async remove(name) {
      try {
        const dir = await folder(false);
        if (dir === null) return;
        await dir.removeEntry(await thumbFileName(name));
      } catch {
        // No preview was kept under this name, or the browser refused the delete.
      }
    },

    async prune(names) {
      try {
        const dir = await folder(false);
        if (dir === null || dir.keys === undefined) return;
        const keep = new Set(await Promise.all(names.map((name) => thumbFileName(name))));
        // Listed first, then removed: the folder is not changed while it is read.
        const stale: string[] = [];
        for await (const key of dir.keys()) {
          if (!keep.has(key)) stale.push(key);
        }
        for (const key of stale) await dir.removeEntry(key);
      } catch {
        // A failed prune keeps the old previews until the next one.
      }
    },
  };
}

// Renders the first page as a JPEG preview that fits the preview box (issue 757). One render_page
// call at the page's own rotation with annotations on. Returns undefined when the page cannot be
// drawn (the engine's revision changed, or the page is empty).
export async function renderRecentThumb(
  client: EngineClient,
  handle: string,
): Promise<Blob | undefined> {
  const reply = await client.call('session.pages', { handle });
  const page = reply.pages[0];
  if (page === undefined || !(page.width > 0) || !(page.height > 0)) return undefined;
  const ratio = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_RATIO);
  // The device pixels per point that fit the page into the box, quantized as every render is.
  const fit = Math.min(
    (THUMB_WIDTH_CSS_PX * ratio) / page.width,
    (THUMB_HEIGHT_CSS_PX * ratio) / page.height,
  );
  const scaleMilli = Math.min(quantizeScale(fit), MAX_RENDER_SCALE_MILLI);
  const image = await client.call('render.page', {
    handle,
    page: 0,
    revision: 0,
    scale_milli: scaleMilli,
    rotation: 0,
    annotations: true,
  });
  // The worker may send the page as an ImageBitmap (W5.1b S5) with empty pixels: that is drawable
  // too. The bitmap is ours to close, once it is drawn.
  const bitmap = image.bitmap;
  if (
    image.width === 0 ||
    image.height === 0 ||
    (bitmap === undefined && image.pixels.byteLength === 0)
  ) {
    bitmap?.close();
    return undefined;
  }
  const source = document.createElement('canvas');
  try {
    drawPixels(source, { width: image.width, height: image.height, pixels: image.pixels, bitmap });
  } finally {
    bitmap?.close();
  }
  // A JPEG has no alpha: the page is drawn over white, not over black.
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  if (context === null) return undefined;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, image.width, image.height);
  context.drawImage(source, 0, 0);
  return await new Promise<Blob | undefined>((resolve) => {
    canvas.toBlob((blob) => resolve(blob ?? undefined), 'image/jpeg', THUMB_QUALITY);
  });
}

// Runs a job when the browser is idle, so a preview never delays the first page (issue 757).
export function whenIdle(job: () => void): void {
  const idle = (
    globalThis as {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => void;
    }
  ).requestIdleCallback;
  if (typeof idle === 'function') idle(job, { timeout: 2000 });
  else setTimeout(job, 0);
}

// Makes and keeps the preview of a file just opened, then drops the previews of names that left
// the recent list. An encrypted file gets none, and a render or write failure gets none. The file
// name is the sha256 of the recent name, so the old file's preview would otherwise stay under this
// name: each of these cases removes it first (issue 757). Other failures only mean no preview.
// The preview is keyed by the cleaned name, the one the list and load use. `listed` is the list
// just written for this open: pruning with it keeps this preview even when the write failed.
export async function keepRecentThumb(
  store: RecentThumbs,
  client: EngineClient,
  handle: string,
  name: string,
  encrypted: boolean,
  listed: readonly RecentFile[],
): Promise<void> {
  const key = cleanRecentName(name);
  if (key === null) return;
  if (encrypted) {
    await store.remove(key);
    return;
  }
  try {
    const jpeg = await renderRecentThumb(client, handle);
    if (jpeg === undefined) {
      await store.remove(key);
      return;
    }
    if (await store.save(key, jpeg, encrypted)) {
      await store.prune(listed.map((entry) => entry.name));
    } else {
      // The browser refused the write: the old file's preview must not stay under this name.
      await store.remove(key);
    }
  } catch {
    // The render failed: no preview for this file, and no old one left under its name.
    await store.remove(key);
  }
}
