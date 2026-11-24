// The stamp menu and the stamp tool's placement (W7.3 S6): the menu's keyboard, the args a
// chosen stamp sends, and Enter placing a stamp at the page centre.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToastStore, type ToastStore } from '../feedback/toasts';
import { pickFile } from '../files/pickFile';
import { t } from '../i18n/t';
import { createStampStore } from '../storage/stampStore';
import { MemoryDir, memoryRoot } from '../storage/testRoot';
import { CSS_PX_PER_POINT } from '../view/zoom';
import { CommentLayer } from './CommentLayer';
import { placeComment } from './placement';
import { STANDARD_STAMPS } from './stamps';
import { StampMenu } from './stampTool';
import { createStampLibrary, type StampLibrary } from './stampLibrary';

vi.mock('../files/pickFile', () => ({ pickFile: vi.fn(async () => null) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a popover opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) },
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the stamp menu', () => {
  it('lists the 14 standard stamps and reports the one chosen', async () => {
    const onChoose = vi.fn();
    act(() =>
      root.render(<StampMenu library={emptyLibrary()} onChoose={onChoose} onRemoved={vi.fn()} />),
    );
    const button = container.querySelector<HTMLButtonElement>('button');
    act(() => {
      button?.focus();
      button?.click();
    });
    const items = document.querySelectorAll('[role="menuitem"]');
    // The 14 standard stamps, then Add Custom Stamp and Remove Custom Stamp (the library is empty).
    expect(items.length).toBe(STANDARD_STAMPS.length + 2);
    // Enter on the menu's first item chooses it; the arrow key moves the focus to the next one.
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    act(() => {
      menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    const focused = document.activeElement;
    expect(focused?.getAttribute('role')).toBe('menuitem');
    act(() => {
      focused?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onChoose).toHaveBeenCalledTimes(1);
    const [chosen] = onChoose.mock.calls[0] ?? [];
    expect(chosen).toMatchObject({ kind: 'standard' });
    expect(STANDARD_STAMPS).toContain(chosen?.name);
  });
});

describe('the stamp tool on a page', () => {
  const layer = () => container.querySelector<HTMLDivElement>('.comment-layer');
  const px = CSS_PX_PER_POINT;

  it('a click places the stamp at the click point, as a zero-size rect', () => {
    const onPlace = vi.fn();
    act(() =>
      root.render(
        <CommentLayer tool="stamp" zoom={1} widthPt={612} heightPt={792} onPlace={onPlace} />,
      ),
    );
    const el = layer();
    if (el === null) throw new Error('no layer');
    act(() => {
      el.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, clientX: 300 * px, clientY: 200 * px }),
      );
    });
    const [rect, text, points] = onPlace.mock.calls[0] ?? [];
    // The pointer offset is in CSS pixels, so the page point can be a float's rounding away.
    expect(rect.x0).toBeCloseTo(300);
    expect(rect.y0).toBeCloseTo(200);
    expect(rect.x1).toBe(rect.x0);
    expect(rect.y1).toBe(rect.y0);
    expect(text).toBe('');
    expect(points).toEqual([]);
  });

  it('Enter places the stamp at the centre of the page', () => {
    const onPlace = vi.fn();
    act(() =>
      root.render(
        <CommentLayer tool="stamp" zoom={1} widthPt={612} heightPt={792} onPlace={onPlace} />,
      ),
    );
    const el = layer();
    if (el === null) throw new Error('no layer');
    act(() => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onPlace).toHaveBeenCalledWith({ x0: 306, y0: 396, x1: 306, y1: 396 }, '', []);
  });

  it('Space places the stamp at the centre of the page, as Enter does', () => {
    const onPlace = vi.fn();
    act(() =>
      root.render(
        <CommentLayer tool="stamp" zoom={1} widthPt={612} heightPt={792} onPlace={onPlace} />,
      ),
    );
    const el = layer();
    if (el === null) throw new Error('no layer');
    act(() => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(onPlace).toHaveBeenCalledWith({ x0: 306, y0: 396, x1: 306, y1: 396 }, '', []);
  });
});

describe('placing a stamp', () => {
  it('sends the chosen stamp name with the stamp tool', async () => {
    const call = vi.fn(async () => ({
      label: 'Add Stamp',
      executed: false,
      value: null,
      changed: { changes: [], revisions: {} },
      state: { history: 1 },
    }));
    const deps = {
      rpc: { call } as never,
      handle: 'h1',
      scheduler: { noteRevisions: vi.fn() },
      stamps: { read: async () => undefined },
    };
    const rect = { x0: 72, y0: 72, x1: 72, y1: 72 };
    await placeComment(deps, 'stamp', 0, rect, '', [], 'Draft');
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h1',
      name: 'annotations.create',
      args: { tool: 'stamp', page: 0, rect, text: '', points: [], stamp: 'Draft', author: '' },
    });
  });
});

describe('the stamp placement report and args', () => {
  const rect = { x0: 72, y0: 72, x1: 72, y1: 72 };
  const reply = {
    label: 'Add Annotation',
    executed: true,
    value: null,
    changed: { changes: [], revisions: {} },
    state: { history: 1 },
  };

  it('toasts the placed stamp with its label and the 1-based page', async () => {
    const call = vi.fn(async () => reply);
    const push = vi.fn(() => 1);
    const deps = {
      rpc: { call } as never,
      handle: 'h1',
      scheduler: { noteRevisions: vi.fn() },
      stamps: { read: async () => undefined },
      store: { push } as never,
    };
    await placeComment(deps, 'stamp', 0, rect, '', [], 'Draft');
    expect(push).toHaveBeenCalledWith('info', 'Draft stamp added on page 1.', expect.anything());
  });

  it('sends no stamp key for a sticky note', async () => {
    const call = vi.fn<(method: string, params: unknown) => Promise<typeof reply>>(
      async () => reply,
    );
    const deps = {
      rpc: { call } as never,
      handle: 'h1',
      scheduler: { noteRevisions: vi.fn() },
      stamps: { read: async () => undefined },
      store: { push: vi.fn(() => 1) } as never,
    };
    await placeComment(deps, 'note', 0, rect, 'Check this', [], '');
    expect(call.mock.calls[0]?.[1]).toHaveProperty('args.tool', 'note');
    expect(call.mock.calls[0]?.[1]).not.toHaveProperty('args.stamp');
  });
});

describe('the stamp key on other tools', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const layer = () => container.querySelector<HTMLDivElement>('.comment-layer');

  it('every comment tool layer is a focusable application (W7.1a slice 9)', () => {
    for (const tool of ['note', 'rectangle', 'polygon'] as const) {
      act(() =>
        root.render(
          <CommentLayer tool={tool} zoom={1} widthPt={612} heightPt={792} onPlace={vi.fn()} />,
        ),
      );
      expect(layer()?.getAttribute('tabindex')).toBe('0');
      expect(layer()?.getAttribute('role')).toBe('application');
    }
    act(() =>
      root.render(
        <CommentLayer tool="stamp" zoom={1} widthPt={612} heightPt={792} onPlace={vi.fn()} />,
      ),
    );
    expect(layer()?.getAttribute('tabindex')).toBe('0');
  });

  it('Enter places nothing for a note or a rectangle', () => {
    for (const tool of ['note', 'rectangle'] as const) {
      const onPlace = vi.fn();
      act(() =>
        root.render(
          <CommentLayer tool={tool} zoom={1} widthPt={612} heightPt={792} onPlace={onPlace} />,
        ),
      );
      const el = layer();
      if (el === null) throw new Error('no layer');
      act(() => {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      expect(onPlace).not.toHaveBeenCalled();
    }
  });

  it('a held Enter key places one stamp, not one per repeat', () => {
    const onPlace = vi.fn();
    act(() =>
      root.render(
        <CommentLayer tool="stamp" zoom={1} widthPt={612} heightPt={792} onPlace={onPlace} />,
      ),
    );
    const el = layer();
    if (el === null) throw new Error('no layer');
    act(() => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true }));
    });
    expect(onPlace).not.toHaveBeenCalled();
    act(() => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onPlace).toHaveBeenCalledTimes(1);
  });
});

// A library over a fake folder with room to spare; the stamp menu reads it when it opens.
function emptyLibrary(): StampLibrary {
  const store = createStampStore(memoryRoot(new MemoryDir()), async () => ({
    quota: 1e9,
    usage: 0,
  }));
  return createStampLibrary({ store, persist: async () => undefined });
}

// A PNG file whose header declares a 40 x 30 picture, which the library's imageSize reads.
function pngFile(name: string): File {
  const bytes = new Uint8Array(34);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 40);
  view.setUint32(20, 30);
  return new File([bytes], name, { type: 'image/png' });
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('the custom stamps in the stamp menu', () => {
  let container: HTMLDivElement;
  let root: Root;
  let toastStore: ToastStore;
  let library: StampLibrary;
  const revoke = vi.fn();

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    toastStore = createToastStore();
    library = emptyLibrary();
    URL.createObjectURL = vi.fn(() => 'blob:logo');
    URL.revokeObjectURL = revoke;
    revoke.mockClear();
    vi.mocked(pickFile).mockResolvedValue(null);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(onChoose = vi.fn(), onRemoved = vi.fn()) {
    act(() =>
      root.render(
        <StampMenu
          library={library}
          onChoose={onChoose}
          onRemoved={onRemoved}
          store={toastStore}
        />,
      ),
    );
    return { onChoose, onRemoved };
  }

  function openMenu(): void {
    const button = container.querySelector<HTMLButtonElement>('button');
    act(() => {
      button?.focus();
      button?.click();
    });
  }

  function itemWithText(text: string): HTMLElement | undefined {
    return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      el.textContent?.includes(text),
    );
  }

  it('lists a kept stamp with its thumbnail, and chooses it by its id', async () => {
    const added = await library.add(pngFile('Logo_big.png'));
    if (added.kind !== 'added') throw new Error('the stamp was not kept');
    const { onChoose } = render();
    openMenu();
    await flush();
    expect(document.querySelector('.stamp-menu-thumb')?.getAttribute('src')).toBe('blob:logo');
    act(() => itemWithText('Logo big')?.click());
    expect(onChoose).toHaveBeenCalledWith({
      kind: 'custom',
      id: added.stamp.id,
      label: 'Logo big',
    });
  });

  it('revokes the thumbnail URLs when the menu closes', async () => {
    await library.add(pngFile('Logo.png'));
    render();
    openMenu();
    await flush();
    act(() => {
      document
        .querySelector<HTMLElement>('[role="menu"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await flush();
    expect(revoke).toHaveBeenCalledWith('blob:logo');
  });

  it('Add Custom Stamp keeps the picked file, toasts it and chooses it', async () => {
    vi.mocked(pickFile).mockResolvedValue(pngFile('Seal.png'));
    const { onChoose } = render();
    openMenu();
    await flush();
    act(() => itemWithText(t('stamp.custom.add'))?.click());
    await flush();
    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'custom', label: 'Seal' }),
    );
    expect(toastStore.getState().visible[0]?.text).toBe(t('stamp.custom.added', { name: 'Seal' }));
    expect((await library.list()).map((stamp) => stamp.label)).toEqual(['Seal']);
  });

  it('a file the library refuses is toasted with its reason and not chosen', async () => {
    vi.mocked(pickFile).mockResolvedValue(new File([new Uint8Array(12)], 'notes.png'));
    const { onChoose } = render();
    openMenu();
    await flush();
    act(() => itemWithText(t('stamp.custom.add'))?.click());
    await flush();
    expect(onChoose).not.toHaveBeenCalled();
    expect(toastStore.getState().visible[0]?.text).toBe(t('stamp.custom.wrongType'));
  });

  it('Remove Custom Stamp deletes the stamp and reports it to the caller', async () => {
    const added = await library.add(pngFile('Old.png'));
    if (added.kind !== 'added') throw new Error('the stamp was not kept');
    const { onRemoved } = render();
    openMenu();
    await flush();
    act(() => itemWithText(t('stamp.custom.remove'))?.click());
    await flush();
    // The submenu is its own menu; the main menu also lists the stamp, so look only in the submenu.
    const submenu = document.querySelector<HTMLElement>(
      `[role="menu"][aria-label="${t('stamp.custom.remove')}"]`,
    );
    const entry = [...(submenu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    act(() => entry.find((el) => el.textContent === 'Old')?.click());
    await flush();
    expect(await library.list()).toEqual([]);
    expect(onRemoved).toHaveBeenCalledWith(added.stamp.id);
    expect(toastStore.getState().visible.at(-1)?.text).toBe(
      t('stamp.custom.removed', { name: 'Old' }),
    );
  });

  it('shows the session-only note when the browser keeps nothing', async () => {
    library = { ...emptyLibrary(), storage: async () => 'session' as const };
    render();
    openMenu();
    await flush();
    expect(document.querySelector('.app-menu-note')?.textContent).toBe(
      t('stamp.custom.sessionOnly'),
    );
  });

  it('shows no session-only note when the browser keeps the stamps', async () => {
    library = { ...emptyLibrary(), storage: async () => 'persistent' as const };
    render();
    openMenu();
    await flush();
    expect(document.querySelector('.app-menu-note')).toBeNull();
  });

  it('Remove Custom Stamp works from the keyboard: open, move, submenu, Enter', async () => {
    const added = await library.add(pngFile('Keys.png'));
    if (added.kind !== 'added') throw new Error('the stamp was not kept');
    const { onRemoved } = render();
    const button = container.querySelector<HTMLButtonElement>('button');
    const press = (key: string) =>
      act(() => {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      });
    // Enter on the trigger opens the menu with focus on its first item.
    act(() => {
      button?.focus();
      button?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();
    const focusedText = () => document.activeElement?.textContent ?? '';
    for (let i = 0; i < 40 && !focusedText().includes(t('stamp.custom.remove')); i++) {
      press('ArrowDown');
    }
    expect(focusedText()).toContain(t('stamp.custom.remove'));
    // ArrowRight opens the submenu; its one stamp is then moved to and chosen with Enter.
    press('ArrowRight');
    await flush();
    for (let i = 0; i < 5 && focusedText() !== 'Keys'; i++) press('ArrowDown');
    expect(focusedText()).toBe('Keys');
    press('Enter');
    await flush();
    expect(await library.list()).toEqual([]);
    expect(onRemoved).toHaveBeenCalledWith(added.stamp.id);
  });

  it('Remove Custom Stamp is disabled while the library is empty', async () => {
    render();
    openMenu();
    await flush();
    expect(itemWithText(t('stamp.custom.remove'))?.getAttribute('aria-disabled')).toBe('true');
  });
});
