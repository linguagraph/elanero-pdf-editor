// The combine dialog's source list (W6.3, R6). Pure: no DOM, no engine. Each function returns a new
// list, so React state can take it as it is. The engine's own suffix check (services/assembly.py)
// is the authority; this list only keeps the dialog from offering a file the engine would refuse.
export const PDF_SUFFIX = '.pdf';
export const IMAGE_SUFFIXES: readonly string[] = [
  '.png',
  '.jpg',
  '.jpeg',
  '.tif',
  '.tiff',
  '.bmp',
  '.gif',
  '.webp',
  '.jxr',
];
export const SUPPORTED_SUFFIXES: readonly string[] = [PDF_SUFFIX, ...IMAGE_SUFFIXES];
// The value of the file input's accept attribute, the same list.
export const ACCEPT = SUPPORTED_SUFFIXES.join(',');

// A combine needs at least this many sources (the engine refuses fewer too).
export const MIN_SOURCES = 2;

export const DEFAULT_OUTPUT_NAME = 'merged.pdf';

export interface SourceItem {
  readonly id: number;
  readonly name: string;
  readonly file: File;
  // The Pages box of a PDF row, as typed: "" or "all" means every page. Images never use it.
  readonly pages: string;
}

// The lower-cased suffix of a file name, with its dot, or "" when it has none.
function suffixOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

export function isSupportedSourceName(name: string): boolean {
  return SUPPORTED_SUFFIXES.includes(suffixOf(name));
}

// An image file, which has no page ranges. The name decides, as the engine's suffix check does.
export function isImageSourceName(name: string): boolean {
  return IMAGE_SUFFIXES.includes(suffixOf(name));
}

// Appends the supported files, in the order given. Unsupported files are skipped and returned by
// name so the dialog can say which ones were left out. Ids count up from firstId.
export function addSources(
  items: readonly SourceItem[],
  files: readonly File[],
  firstId: number,
): { readonly items: readonly SourceItem[]; readonly rejected: readonly string[] } {
  const next = [...items];
  const rejected: string[] = [];
  let id = firstId;
  for (const file of files) {
    if (!isSupportedSourceName(file.name)) {
      rejected.push(file.name);
      continue;
    }
    next.push({ id, name: file.name, file, pages: '' });
    id += 1;
  }
  return { items: next, rejected };
}

// Moves the item at index by delta (-1 up, +1 down). A move past either end changes nothing.
export function moveSource(
  items: readonly SourceItem[],
  index: number,
  delta: -1 | 1,
): readonly SourceItem[] {
  const to = index + delta;
  if (index < 0 || index >= items.length || to < 0 || to >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(index, 1);
  if (moved !== undefined) next.splice(to, 0, moved);
  return next;
}

// Sets the Pages box of one row. The other rows, and their boxes, are left as they are.
export function setSourcePages(
  items: readonly SourceItem[],
  id: number,
  pages: string,
): readonly SourceItem[] {
  return items.map((item) => (item.id === id ? { ...item, pages } : item));
}

export function removeSource(items: readonly SourceItem[], index: number): readonly SourceItem[] {
  if (index < 0 || index >= items.length) return items;
  return items.filter((_, position) => position !== index);
}

// The name the result is offered under. A blank name gives the default; a name without .pdf gets
// it, so the download always opens as a PDF.
export function outputFileName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return DEFAULT_OUTPUT_NAME;
  return trimmed.toLowerCase().endsWith(PDF_SUFFIX) ? trimmed : `${trimmed}${PDF_SUFFIX}`;
}
