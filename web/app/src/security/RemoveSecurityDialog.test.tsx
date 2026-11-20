import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { createToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import type { SecurityResult } from '../rpc/generated';
import { RemoveSecurityDialog } from './RemoveSecurityDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) },
  });
}

const ALL = {
  print: true,
  modify: true,
  copy: true,
  annotate: true,
  fill_forms: true,
  accessibility: true,
  assemble: true,
  print_high_quality: true,
};

function state(patch: Partial<SecurityResult> = {}): SecurityResult {
  return {
    encryption: 'none',
    permissions: ALL,
    owner_access: true,
    pending: null,
    pending_method: null,
    has_signatures: false,
    ...patch,
  };
}

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

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function fakeRpc(security: SecurityResult, owner = 'boss') {
  let unlocked = false;
  const call = vi.fn(async (method: string, args?: unknown) => {
    if (method === 'session.security')
      return { ...security, owner_access: unlocked || security.owner_access };
    if (method === 'session.unlock_owner') {
      const ok = (args as { password: string }).password === owner;
      unlocked = unlocked || ok;
      return { unlocked: ok };
    }
    if (method === 'actions.run') {
      return {
        label: 'Remove Security',
        executed: true,
        value: null,
        changed: null,
        state: { history: 5 },
      };
    }
    return {};
  });
  return { call, rpc: { call } as unknown as PageRpc };
}

function render(rpc: PageRpc, onClose = vi.fn()) {
  const store = createToastStore();
  act(() => {
    root.render(
      <RemoveSecurityDialog
        isOpen
        onClose={onClose}
        rpc={rpc}
        handle="h1"
        name="Report.pdf"
        store={store}
      />,
    );
  });
  return { onClose };
}

function button(text: string): HTMLButtonElement {
  const el = [...document.body.querySelectorAll('button')].find((b) => b.textContent === text);
  if (el === undefined) throw new Error(`no button ${text}`);
  return el;
}

function typeInto(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function removeCalls(call: ReturnType<typeof fakeRpc>['call']) {
  return call.mock.calls.filter(
    ([m, a]) => m === 'actions.run' && (a as { name: string }).name === 'security.remove',
  );
}

describe('RemoveSecurityDialog', () => {
  it('says a plain document has no security and changes nothing', async () => {
    const { call, rpc } = fakeRpc(state());
    render(rpc);
    await flush();
    expect(document.body.textContent).toContain(t('security.none'));
    expect(removeCalls(call)).toHaveLength(0);
  });

  it('drops a pending change that was never saved, with no confirmation', async () => {
    const { call, rpc } = fakeRpc(state({ pending: 'encrypt', pending_method: 'aes-256' }));
    render(rpc);
    await flush();
    expect(removeCalls(call)).toHaveLength(1);
    expect(document.body.textContent).toContain(t('security.pendingDropped'));
    expect(button(t('action.cancel'))).toBeDefined();
  });

  it('asks for the owner password, then confirms, then removes once', async () => {
    const { call, rpc } = fakeRpc(state({ encryption: 'aes-256', owner_access: false }));
    const { onClose } = render(rpc);
    await flush();
    const field = document.querySelector<HTMLInputElement>('input[autocomplete="off"]');
    if (field === null) throw new Error('no unlock field');
    typeInto(field, 'boss');
    await act(async () => void button(t('security.owner.unlock')).click());
    await flush();
    expect(document.body.textContent).toContain(t('security.remove.body', { name: 'Report.pdf' }));
    expect(removeCalls(call)).toHaveLength(0);

    await act(async () => void button(t('security.remove.confirm')).click());
    await flush();
    const runs = removeCalls(call);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.[1]).toEqual({ handle: 'h1', name: 'security.remove', args: {} });
    expect(onClose).toHaveBeenCalled();
  });
});
