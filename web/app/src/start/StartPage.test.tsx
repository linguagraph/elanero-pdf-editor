import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoadingScreen } from '../feedback/LoadingScreen';
import { t } from '../i18n/t';
import { APP_VERSION } from '../version';
import { formatOpened, StartPage, type StartPageProps } from './StartPage';

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
  // Design section 6: one h1, first in the outline, and no skipped level, in every state the page shows.
  const outlineStates: readonly [string, Partial<StartPageProps>][] = [
    ['the default state', {}],
    [
      'the engine loading state',
      {
        loading: (
          <LoadingScreen state={{ status: 'loading', stage: 'packages' }} onRetry={() => {}} />
        ),
      },
    ],
    [
      'the pending-files state',
      {
        pending: [
          { id: 1, name: 'a.pdf' },
          { id: 2, name: 'b.pdf' },
        ],
      },
    ],
    [
      'the recent-files state',
      {
        recent: [{ name: 'first.pdf', openedAt: 1_700_000_000_000 }],
      },
    ],
  ];
  for (const [name, props] of outlineStates) {
    it(`has one h1, first in the outline, and no skipped heading level in ${name}`, () => {
      renderPage(props);
      const headings = Array.from(host.querySelectorAll('h1, h2, h3, h4, h5, h6'));
      expect(headings.filter((heading) => heading.tagName === 'H1')).toHaveLength(1);
      expect(headings[0]?.tagName).toBe('H1');
      expect(headings[0]?.textContent).toBe(t('app.name'));
      const levels = headings.map((heading) => Number(heading.tagName.slice(1)));
      for (let index = 1; index < levels.length; index += 1) {
        expect((levels[index] ?? 0) - (levels[index - 1] ?? 0)).toBeLessThanOrEqual(1);
      }
    });
  }

  // The drag-over colours are tokens only (design section 4): the focus ring for the border, and
  // the surface-alt background the design allows. Read from the stylesheet itself, so a literal
  // colour or another token fails here.
  it('draws the drag-over state with the focus-ring token only (surface-alt background allowed)', () => {
    const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'start.css'), 'utf8');
    const rule = /\.start-drop\[data-dragging='true'\]\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    const body = rule?.[1] ?? '';
    expect(body).toContain('var(--color-focus-ring)');
    const tokens = [...body.matchAll(/var\(--color-([a-z-]+)\)/g)].map((match) => match[1]);
    for (const token of tokens) {
      expect(['focus-ring', 'surface-alt']).toContain(token);
    }
    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
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
      section.dispatchEvent(dropEvent('dragenter', { dataTransfer: { types: ['Files'] } }));
    });
    expect(card?.dataset.dragging).toBe('true');
    const file = new File(['%PDF'], 'a.pdf', { type: 'application/pdf' });
    act(() => {
      section.dispatchEvent(
        dropEvent('drop', { dataTransfer: { files: [file], types: ['Files'] } }),
      );
    });
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(card?.dataset.dragging).toBeUndefined();
  });

  it('does not light the card for a drag that carries no files', () => {
    renderPage();
    const section = host.querySelector('.start-page') as HTMLElement;
    const card = host.querySelector<HTMLElement>('.start-drop');
    const textDrag = new Event('dragenter', { bubbles: true, cancelable: true });
    Object.assign(textDrag, { dataTransfer: { types: ['text/plain'] } });
    act(() => {
      section.dispatchEvent(textDrag);
    });
    expect(card?.dataset.dragging).toBeUndefined();
  });

  it('keeps the drag state when the drag moves onto a child of the page', () => {
    renderPage();
    const section = host.querySelector('.start-page') as HTMLElement;
    const card = host.querySelector<HTMLElement>('.start-drop');
    const enter = new Event('dragenter', { bubbles: true, cancelable: true });
    Object.assign(enter, { dataTransfer: { types: ['Files'] } });
    act(() => {
      section.dispatchEvent(enter);
    });
    const leave = new Event('dragleave', { bubbles: true, cancelable: true });
    Object.assign(leave, { relatedTarget: card });
    act(() => {
      section.dispatchEvent(leave);
    });
    expect(card?.dataset.dragging).toBe('true');
  });

  it('clears the drag state when the drag leaves the page', () => {
    renderPage();
    const section = host.querySelector('.start-page') as HTMLElement;
    const card = host.querySelector<HTMLElement>('.start-drop');
    const enter = new Event('dragenter', { bubbles: true, cancelable: true });
    Object.assign(enter, { dataTransfer: { types: ['Files'] } });
    act(() => {
      section.dispatchEvent(enter);
    });
    expect(card?.dataset.dragging).toBe('true');
    // Leaving to nothing (relatedTarget null) and leaving to an element outside the page both clear it.
    const leaveToNothing = new Event('dragleave', { bubbles: true, cancelable: true });
    Object.assign(leaveToNothing, { relatedTarget: null });
    act(() => {
      section.dispatchEvent(leaveToNothing);
    });
    expect(card?.dataset.dragging).toBeUndefined();
    act(() => {
      section.dispatchEvent(enter);
    });
    const leaveOutside = new Event('dragleave', { bubbles: true, cancelable: true });
    Object.assign(leaveOutside, { relatedTarget: document.body });
    act(() => {
      section.dispatchEvent(leaveOutside);
    });
    expect(card?.dataset.dragging).toBeUndefined();
  });

  it('accepts a PDF dropped on a child element, and clears the drag state', () => {
    const onFiles = vi.fn();
    renderPage({ onFiles });
    const card = host.querySelector<HTMLElement>('.start-drop');
    const title = host.querySelector<HTMLElement>('.start-title');
    const enter = new Event('dragenter', { bubbles: true, cancelable: true });
    Object.assign(enter, { dataTransfer: { types: ['Files'] } });
    act(() => {
      title?.dispatchEvent(enter);
    });
    expect(card?.dataset.dragging).toBe('true');
    const file = new File(['%PDF'], 'b.pdf', { type: 'application/pdf' });
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.assign(drop, { dataTransfer: { files: [file], types: ['Files'] } });
    act(() => {
      card?.dispatchEvent(drop);
    });
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles.mock.calls[0]?.[0]).toEqual([file]);
    expect(card?.dataset.dragging).toBeUndefined();
  });
});

describe('StartPage recent previews', () => {
  const recent = [{ name: 'a.pdf', openedAt: 1 }];

  it('shows the first-page preview image in the recent row when one exists', () => {
    renderPage({ recent, thumbs: new Map([['a.pdf', 'blob:preview-a']]) });
    const image = host.querySelector<HTMLImageElement>('.start-recent-list img');
    expect(image).not.toBeNull();
    expect(image?.getAttribute('src')).toBe('blob:preview-a');
    expect(image?.getAttribute('alt')).toBe('');
  });

  it('shows the file icon in the same box when there is no preview', () => {
    renderPage({ recent });
    expect(host.querySelector('.start-recent-list img')).toBeNull();
    const thumb = host.querySelector('.start-recent-list .start-recent-thumb');
    expect(thumb).not.toBeNull();
    expect(thumb?.querySelector('svg')).not.toBeNull();
  });

  it('draws each recent file as a card whose button is named by the file name', () => {
    renderPage({ recent: [...recent, { name: 'b.pdf', openedAt: 2 }] });
    const cards = host.querySelectorAll('.start-recent-list > li.start-recent-card');
    expect(cards).toHaveLength(2);
    const button = cards[0]?.querySelector<HTMLButtonElement>('button.start-recent-name');
    expect(button?.textContent).toBe('a.pdf');
    expect(button?.getAttribute('aria-label')).toBeNull();
  });

  it('keeps the opened time outside the card button, so the button name is the file name', () => {
    renderPage({ recent });
    const card = host.querySelector('.start-recent-card');
    const time = card?.querySelector('.start-recent-time');
    expect(time?.textContent).toBe(t('start.recent.opened', { time: formatOpened(1) }));
    expect(card?.querySelector('button.start-recent-name')?.textContent).not.toContain(
      t('start.recent.opened', { time: formatOpened(1) }),
    );
  });

  it('opens the recent file by its name when the card button is clicked', () => {
    const onRecent = vi.fn();
    renderPage({ recent, onRecent });
    const button = host.querySelector<HTMLButtonElement>('.start-recent-card button');
    act(() => {
      button?.click();
    });
    expect(onRecent).toHaveBeenCalledWith('a.pdf');
  });
});
