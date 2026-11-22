import { describe, expect, it } from 'vitest';
import { pickFile } from './pickFile';

// jsdom has no file dialog: the test plays the browser's part by firing the input's events.
function theInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input was added');
  return input;
}

describe('pickFile', () => {
  it('adds a hidden file input that accepts the given types, and resolves with the chosen file', async () => {
    const picked = pickFile('image/png,image/jpeg');
    const input = theInput();
    expect(input.accept).toBe('image/png,image/jpeg');
    expect(input.hidden).toBe(true);
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new Event('change'));
    expect(await picked).toBe(file);
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('resolves with null when the user cancels, and removes the input', async () => {
    const picked = pickFile('image/png');
    theInput().dispatchEvent(new Event('cancel'));
    expect(await picked).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('resolves with null when a change brings no file', async () => {
    const picked = pickFile('image/png');
    const input = theInput();
    Object.defineProperty(input, 'files', { value: null });
    input.dispatchEvent(new Event('change'));
    expect(await picked).toBeNull();
  });
});
