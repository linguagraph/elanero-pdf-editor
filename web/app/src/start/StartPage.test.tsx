import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoadingScreen } from '../feedback/LoadingScreen';
import { t } from '../i18n/t';
import { APP_VERSION } from '../version';
import { StartPage, type StartPageProps } from './StartPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

function renderPage(props: Partial<StartPageProps> = {}): void {
  const base: StartPageProps = {
    recent: [],
    pickHint: null,
    onOpen: () => undefined,
    onRecent: () => undefined,
    onFiles: () => undefined,
    onAbout: () => undefined,
  };
  act(() => {
    root.render(<StartPage {...base} {...props} />);
  });
}

describe('StartPage while the engine loads', () => {
  it('shows the load panel inline, not as a modal, and keeps the Open button usable', () => {
    renderPage({
      loading: (
        <LoadingScreen state={{ status: 'loading', stage: 'packages' }} onRetry={() => {}} />
      ),
    });
    const panel = host.querySelector('.loading-screen');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('aria-modal')).toBeNull();
    const open = host.querySelector<HTMLButtonElement>('.start-open');
    expect(open?.disabled).toBe(false);
    expect(open?.closest('[inert]')).toBeNull();
  });

  it('keeps the failure state with Try again inline', () => {
    const onRetry = vi.fn();
    renderPage({
      loading: <LoadingScreen state={{ status: 'failed', stage: 'packages' }} onRetry={onRetry} />,
    });
    const retry = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === t('loading.retry'),
    );
    expect(retry).toBeDefined();
    act(() => {
      retry?.click();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("lists the waiting files in order, each with its own Don't open button", () => {
    const onCancelPending = vi.fn();
    renderPage({
      pending: [
        { id: 1, name: 'a.pdf' },
        { id: 2, name: 'b.pdf' },
      ],
      onCancelPending,
    });
    const rows = host.querySelectorAll('.start-pending-list li');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain(t('start.pending.row', { name: 'a.pdf' }));
    const cancel = host.querySelector<HTMLButtonElement>(
      `button[aria-label="${t('start.pending.cancelLabel', { name: 'b.pdf' })}"]`,
    );
    expect(cancel?.textContent).toBe(t('start.pending.cancel'));
    act(() => {
      cancel?.click();
    });
    expect(onCancelPending).toHaveBeenCalledWith(2);
  });

  it('shows no waiting list when nothing is waiting', () => {
    renderPage();
    expect(host.querySelector('.start-pending')).toBeNull();
  });
});

describe('StartPage layout (#626 S1)', () => {
  it('has one h1, first in the outline, and no skipped heading level', () => {
    renderPage();
    const headings = Array.from(host.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    expect(headings.filter((heading) => heading.tagName === 'H1')).toHaveLength(1);
    expect(headings[0]?.tagName).toBe('H1');
    expect(headings[0]?.textContent).toBe(t('app.name'));
    const levels = headings.map((heading) => Number(heading.tagName.slice(1)));
    for (let index = 1; index < levels.length; index += 1) {
      expect((levels[index] ?? 0) - (levels[index - 1] ?? 0)).toBeLessThanOrEqual(1);
    }
  });

  it('shows the version, licence and About button in the footer', () => {
    const onAbout = vi.fn();
    renderPage({ onAbout });
    const footer = host.querySelector('footer');
    expect(footer?.textContent).toContain(t('start.footer.version', { version: APP_VERSION }));
    expect(footer?.textContent).toContain(t('about.licence'));
    const source = footer?.querySelector('a');
    expect(source?.getAttribute('rel')).toBe('noopener noreferrer');
    const button = Array.from(footer?.querySelectorAll('button') ?? []).find(
      (item) => item.textContent === t('about.title'),
    );
    act(() => {
      button?.click();
    });
    expect(onAbout).toHaveBeenCalledTimes(1);
  });

  it('lights the drop card while a drag is over the page and clears it on drop', () => {
    const onFiles = vi.fn();
    renderPage({ onFiles });
    const section = host.querySelector('.start-page') as HTMLElement;
    const card = host.querySelector<HTMLElement>('.start-drop');
    const dropEvent = (type: string, extra: Record<string, unknown> = {}) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, extra);
      return event;
    };
    act(() => {
      section.dispatchEvent(dropEvent('dragenter'));
    });
    expect(card?.dataset.dragging).toBe('true');
    const file = new File(['%PDF'], 'a.pdf', { type: 'application/pdf' });
    act(() => {
      section.dispatchEvent(dropEvent('drop', { dataTransfer: { files: [file] } }));
    });
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(card?.dataset.dragging).toBeUndefined();
  });
});
