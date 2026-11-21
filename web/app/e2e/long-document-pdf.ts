// W5.1a S5: builds the many-page PDF the long-document check opens. It is written in memory so no
// generated file is committed (plan decision 4). Pages mix Letter, A4 and landscape sizes, and every
// 7th page carries /Rotate 90, so the visible size of those pages is the stored size turned over.

export interface PageSpec {
  readonly width: number;
  readonly height: number;
  readonly rotate: 0 | 90;
}

const SIZES: readonly [number, number][] = [
  [612, 792], // Letter
  [595, 842], // A4
  [792, 612], // landscape Letter
];

export function pageSpecs(count: number): PageSpec[] {
  return Array.from({ length: count }, (_, index) => {
    const [width, height] = SIZES[index % SIZES.length] ?? [612, 792];
    return { width, height, rotate: (index + 1) % 7 === 0 ? 90 : 0 };
  });
}

// The size the viewer lays out (points, visible space): /Rotate 90 swaps the stored width and height.
export function visibleSize(page: PageSpec): { width: number; height: number } {
  return page.rotate === 90
    ? { width: page.height, height: page.width }
    : { width: page.width, height: page.height };
}

// A blue square on each page, so a rendered page has pixels that are not white.
const CONTENT = '0 0.4 0.8 rg 20 20 100 100 re f';

export function buildPdf(pages: readonly PageSpec[]): Buffer {
  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = pages.map((_, index) => `${3 + 2 * index} 0 R`).join(' ');
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  pages.forEach((page, index) => {
    const pageId = 3 + 2 * index;
    const contentId = pageId + 1;
    const rotate = page.rotate === 0 ? '' : ` /Rotate ${page.rotate}`;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}]${rotate}` +
      ` /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${CONTENT.length} >>\nstream\n${CONTENT}\nendstream`;
  });

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) {
    out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
