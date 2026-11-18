import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOST_WORK } from '../engine/restart';
import { RpcError, RpcTimeoutError } from '../rpc/client';
import { NotRespondingDialog, isNotRespondingError } from './NotRespondingDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) },
  });
}

// The caller's side: it holds the failure, clears it on Wait, and counts restarts.
function Host({ initial, onRestart }: { initial: unknown; onRestart: () => void }) {
  const [error, setError] = useState<unknown>(initial);
  return (
    <NotRespondingDialog error={error} onWait={() => setError(undefined)} onRestart={onRestart} />
  );
}

function dialogButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (button) => button.textContent === label,
  );
}

describe('isNotRespondingError', () => {
  it('is true only for a deadline error', () => {
    expect(isNotRespondingError(new RpcTimeoutError('render', 5000))).toBe(true);
    expect(isNotRespondingError(new RpcError('BUSY', 'busy'))).toBe(false);
    expect(isNotRespondingError(undefined)).toBe(false);
  });
});

describe('NotRespondingDialog', () => {
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

  it('opens on a timeout error, with the lost work listed', () => {
    act(() => {
      root.render(
        <Host initial={new RpcTimeoutError('render', 5000)} onRestart={() => undefined} />,
      );
    });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Elanero is still working');
    expect(dialog?.textContent).toContain('If you restart, this is lost:');
    // The dialog lists the restart helper's items; this fails if the helper's list changes, so
    // the catalogue text can be added for the new item.
    expect(LOST_WORK.items).toEqual([
      'the changes made since the last autosave',
      'the undo history',
    ]);
    expect([...(dialog?.querySelectorAll('li') ?? [])].map((li) => li.textContent)).toEqual([
      'The changes made since the last autosave',
      'The undo history',
    ]);
  });

  it('stays closed for any other error', () => {
    act(() => {
      root.render(<Host initial={new RpcError('BUSY', 'busy')} onRestart={() => undefined} />);
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('Wait closes the dialog without restarting the engine', () => {
    const onRestart = vi.fn();
    act(() => {
      root.render(<Host initial={new RpcTimeoutError('render', 5000)} onRestart={onRestart} />);
    });
    act(() => {
      dialogButton('Wait')?.click();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(onRestart).not.toHaveBeenCalled();
  });

  it('Restart engine calls the restart handler', () => {
    const onRestart = vi.fn();
    act(() => {
      root.render(<Host initial={new RpcTimeoutError('render', 5000)} onRestart={onRestart} />);
    });
    act(() => {
      dialogButton('Restart engine')?.click();
    });
    expect(onRestart).toHaveBeenCalledTimes(1);
  });
});
