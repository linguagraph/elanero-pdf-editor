import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoadingScreen } from '../feedback/LoadingScreen';
import { t } from '../i18n/t';
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
