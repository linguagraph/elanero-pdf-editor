// The download helper every file-producing dialog shares (W6.2, W7.7): a result file becomes an
// object URL and an anchor with the file's name. The URLs are freed when the result goes away.

// A file a job wrote. The name is the path inside the job's folder, relative to it.
export interface ResultFile {
  readonly name: string;
  readonly mime: string;
  readonly data: ArrayBuffer;
}

export interface DownloadLink {
  readonly name: string;
  readonly href: string;
}

// The file name a download gets: the last part of the path the job wrote.
export function downloadName(file: Pick<ResultFile, 'name'>): string {
  return file.name.split('/').pop() ?? file.name;
}

// One object URL per result file. The caller frees them with revokeLinks.
export function downloadLinks(files: readonly ResultFile[]): DownloadLink[] {
  return files.map((file) => ({
    name: downloadName(file),
    href: URL.createObjectURL(new Blob([file.data], { type: file.mime })),
  }));
}

export function revokeLinks(links: readonly DownloadLink[]): void {
  for (const link of links) URL.revokeObjectURL(link.href);
}

// Hands bytes to the browser as a file (the Combine, Compare and organizer downloads). The object
// URL is released after the click has started the download.
export function downloadBytes(name: string, bytes: ArrayBuffer, type = 'application/pdf'): void {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
