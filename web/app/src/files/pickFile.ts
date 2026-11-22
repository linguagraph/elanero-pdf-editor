// Asks the user for one file through the browser's own picker (W6.7b). The picker opens from the
// click that calls this, so the browser allows it; the promise resolves with the file, or null when
// the user cancels. Browsers without the cancel event leave the promise open, and the element is
// simply dropped with the page, so nothing else waits on it.

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.hidden = true;
    const finish = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => finish(null), { once: true });
    document.body.append(input);
    input.click();
  });
}
