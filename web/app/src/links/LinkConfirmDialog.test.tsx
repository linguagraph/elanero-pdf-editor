import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t';
import { LinkConfirmDialog } from './LinkConfirmDialog';
import type { LinkConfirm } from './linkTarget';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens (see layout.test.tsx).
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) },
  });
}

const WEB: LinkConfirm = {
  action: 'confirm',
  href: 'https://evil.example/login',
  scheme: 'https:',
  host: 'evil.example',
};
const MAIL: LinkConfirm = {
  action: 'confirm',
  href: 'mailto:a@example.org',
  scheme: 'mailto:',
  host: '',
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

// The dialog opens and takes its focus after a tick.
async function render(target: LinkConfirm | null, onClose = vi.fn()): Promise<void> {
  act(() => {
    root.render(<LinkConfirmDialog target={target} onClose={onClose} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

function button(label: string): HTMLButtonElement {
  const found = [...(dialog()?.querySelectorAll('button') ?? [])].find(
    (b) => b.textContent === label,
  );
  if (found === undefined) throw new Error(`no button ${label}`);
  return found;
}

describe('LinkConfirmDialog', () => {
  it('shows the host in bold and the full address as text', async () => {
    await render(WEB);
    expect(dialog()?.querySelector('strong')?.textContent).toBe('evil.example');
    expect(dialog()?.textContent).toContain(t('links.confirm.web', { host: 'evil.example' }));
    const address = dialog()?.querySelector<HTMLElement>('.link-confirm-address');
    expect(address?.textContent).toBe('https://evil.example/login');
    expect(address?.getAttribute('dir')).toBe('ltr');
    expect(dialog()?.querySelector('a[href]')).toBeNull();
  });

  it('says it starts an email for a mail link, with the address shown', async () => {
    await render(MAIL);
    expect(dialog()?.textContent).toContain(t('links.confirm.mail'));
    expect(dialog()?.querySelector('strong')).toBeNull();
    expect(dialog()?.querySelector('.link-confirm-address')?.textContent).toBe(
      'mailto:a@example.org',
    );
  });

  it('gives Cancel the initial focus, before Open', async () => {
    await render(WEB);
    const buttons = [...(dialog()?.querySelectorAll('button') ?? [])];
    expect(buttons.map((b) => b.textContent)).toEqual([
      t('links.confirm.cancel'),
      t('links.confirm.open'),
    ]);
    expect(document.activeElement).toBe(button(t('links.confirm.cancel')));
  });

  it('does not open anything until Open is pressed, then opens once with noopener and noreferrer', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const onClose = vi.fn();
    await render(WEB, onClose);
    expect(open).not.toHaveBeenCalled();
    act(() => {
      button(t('links.confirm.open')).click();
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      'https://evil.example/login',
      '_blank',
      'noopener,noreferrer',
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a second press of Open before the dialog closes does not open again', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    // The parent keeps the dialog up here, so the second press lands while it is still open.
    const onClose = vi.fn();
    await render(WEB, onClose);
    act(() => {
      button(t('links.confirm.open')).click();
      button(t('links.confirm.open')).click();
    });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('Cancel closes without opening anything', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const onClose = vi.fn();
    await render(WEB, onClose);
    act(() => {
      button(t('links.confirm.cancel')).click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });

  it('Escape closes the dialog without opening anything', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const onClose = vi.fn();
    await render(WEB, onClose);
    // The overlay takes focus after a tick; a key sent before that would miss the modal.
    const cancel = button(t('links.confirm.cancel'));
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(cancel);
    });
    // The key goes to the focused element, as a real keypress does, and bubbles up to the modal.
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });

  it('renders nothing when there is no link to confirm', async () => {
    await render(null);
    expect(dialog()).toBeNull();
  });
});
