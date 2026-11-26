// The print path (W6.5, W1.4 section 11): one <img> per page in a hidden same-origin iframe, sized
// to the page in points, then the browser's print dialog. No PDF library: the browser prints the
// PNG pages. The iframe's document takes styles through CSSOM only, since the page's CSP has no
// 'unsafe-inline' for style.

export interface PrintFile {
  readonly name: string;
  readonly mime: string;
  readonly data: ArrayBuffer;
}

export interface PrintImagesOptions {
  // The resolution the pages were rendered at; sizes each page in points.
  readonly dpi: number;
  readonly document?: Document;
  // Opens the print dialog for the iframe's window. The default calls window.print().
  readonly print?: (win: Window) => void;
  // Resolves once every image has loaded. The default waits for each load or error event.
  readonly waitForImages?: (images: readonly HTMLImageElement[]) => Promise<void>;
}

// Width and height of a PNG in points, read from its IHDR chunk. undefined for anything else, so
// the image then takes its natural size.
export function pngSizeInPoints(
  data: ArrayBuffer,
  dpi: number,
): { readonly width: number; readonly height: number } | undefined {
  if (data.byteLength < 24) return undefined;
  const view = new DataView(data);
  const signature = [0x89, 0x50, 0x4e, 0x47];
  if (signature.some((byte, index) => view.getUint8(index) !== byte)) return undefined;
  if (view.getUint32(12) !== 0x49484452) return undefined; // "IHDR"
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0 || dpi <= 0) return undefined;
  return { width: (width * 72) / dpi, height: (height * 72) / dpi };
}

function loadedOrFailed(image: HTMLImageElement): Promise<void> {
  if (image.complete) return Promise.resolve();
  return new Promise((resolve) => {
    image.addEventListener('load', () => resolve(), { once: true });
    image.addEventListener('error', () => resolve(), { once: true });
  });
}

const defaultPrint = (win: Window): void => {
  win.print();
};

// Prints the pages in order. The iframe is removed after the print dialog closes (afterprint),
// or at once when the browser refuses to print. The blob URLs are revoked with it.
export async function printImages(
  files: readonly PrintFile[],
  options: PrintImagesOptions,
): Promise<void> {
  const doc = options.document ?? document;
  const print = options.print ?? defaultPrint;
  const waitForImages =
    options.waitForImages ??
    (async (images: readonly HTMLImageElement[]) => {
      await Promise.all(images.map(loadedOrFailed));
    });

  const frame = doc.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.position = 'absolute';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  frame.style.visibility = 'hidden';
  doc.body.append(frame);

  const urls: string[] = [];
  let removed = false;
  const cleanup = (): void => {
    if (removed) return;
    removed = true;
    for (const url of urls) URL.revokeObjectURL(url);
    frame.remove();
  };

  try {
    const win = frame.contentWindow;
    const body = frame.contentDocument?.body;
    if (win === null || body === null || body === undefined) {
      throw new Error('the print frame has no document');
    }
    win.addEventListener('afterprint', cleanup, { once: true });

    // The @page rule removes the browser's margins; CSSOM only, so the CSP is not touched.
    // The sheet must be built by the print frame's own window: WebKit refuses to adopt a sheet
    // from another document (NotAllowedError), so it is built there, not with the app's
    // CSSStyleSheet. The catch covers that refusal and browsers without constructable sheets;
    // either way the browser's own margins apply.
    try {
      const sheet = new (win as Window & typeof globalThis).CSSStyleSheet();
      sheet.replaceSync('@page { margin: 0; }');
      win.document.adoptedStyleSheets = [sheet];
    } catch {
      // The browser's own margins apply.
    }

    const images: HTMLImageElement[] = [];
    for (const file of files) {
      const url = URL.createObjectURL(new Blob([file.data], { type: file.mime }));
      urls.push(url);
      const image = win.document.createElement('img');
      image.alt = '';
      image.src = url;
      image.style.display = 'block';
      image.style.breakAfter = 'page';
      const size = pngSizeInPoints(file.data, options.dpi);
      if (size !== undefined) {
        image.style.width = `${size.width}pt`;
        image.style.height = `${size.height}pt`;
      }
      body.append(image);
      images.push(image);
    }

    await waitForImages(images);
    print(win);
  } catch (error) {
    cleanup();
    throw error;
  }
}
