import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { createToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import type { SecurityResult } from '../rpc/generated';
import { EncryptDialog } from './EncryptDialog';

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

// A fake engine: session.security returns `security`, unlock_owner accepts only `owner`, and
// actions.run returns an executed step (or throws `refusal`).
function fakeRpc(security: SecurityResult, options: { owner?: string; refusal?: RpcError } = {}) {
  let unlocked = false;
  const call = vi.fn(async (method: string, args?: unknown) => {
    if (method === 'session.security')
      return { ...security, owner_access: unlocked || security.owner_access };
    if (method === 'session.unlock_owner') {
      const password = (args as { password: string }).password;
      const ok = password === options.owner;
      unlocked = unlocked || ok;
      return { unlocked: ok };
    }
    if (method === 'actions.run') {
      if (options.refusal) throw options.refusal;
      return {
        label: 'Encrypt with Password',
        executed: true,
        value: null,
        changed: null,
        state: { history: 4 },
      };
    }
    return {};
  });
  return { call, rpc: { call } as unknown as PageRpc };
}

function render(rpc: PageRpc, isOpen = true, onClose = vi.fn()) {
  const store = createToastStore();
  const element = (open: boolean) => (
    <EncryptDialog isOpen={open} onClose={onClose} rpc={rpc} handle="h1" store={store} />
  );
  act(() => {
    root.render(element(isOpen));
  });
  return { onClose, rerender: (open: boolean) => act(() => root.render(element(open))) };
}

function input(id: string): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>(`input[id$="-${id}"]`);
  if (el === null) throw new Error(`no input ${id}`);
  return el;
}

function checkbox(label: string): HTMLInputElement {
  const el = [...document.body.querySelectorAll('label')]
    .find((node) => node.textContent?.trim() === label)
    ?.querySelector('input');
  if (el === null || el === undefined) throw new Error(`no checkbox ${label}`);
  return el;
}

function button(text: string): HTMLButtonElement {
  const el = [...document.body.querySelectorAll('button')].find((b) => b.textContent === text);
  if (el === undefined) throw new Error(`no button ${text}`);
  return el;
}

// React only sees a change made through the native setter, as in the properties tests.
function typeInto(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function check(el: HTMLInputElement, checked: boolean): void {
  act(() => {
    el.click();
  });
  if (el.checked !== checked) throw new Error('checkbox did not change');
}

function alertText(): string | null {
  return document.querySelector('[role="alert"]')?.textContent ?? null;
}

describe('EncryptDialog', () => {
  it('refuses a signed document with no form', async () => {
    const { rpc } = fakeRpc(state({ has_signatures: true }));
    render(rpc);
    await flush();
    expect(document.body.textContent).toContain(t('security.refused.signed'));
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0);
  });

  it('asks for the owner password first, refuses a repeat of a wrong one, then shows the form', async () => {
    const security = state({ encryption: 'aes-256', owner_access: false });
    const { call, rpc } = fakeRpc(security, { owner: 'boss' });
    render(rpc);
    await flush();
    const field = document.querySelector<HTMLInputElement>('input[autocomplete="off"]');
    if (field === null) throw new Error('no unlock field');
    expect(field.type).toBe('password');

    typeInto(field, 'wrong');
    await act(async () => void button(t('security.owner.unlock')).click());
    await flush();
    expect(alertText()).toBe(t('security.owner.wrong'));
    expect(button(t('security.owner.unlock')).disabled).toBe(true);

    typeInto(field, 'boss');
    await act(async () => void button(t('security.owner.unlock')).click());
    await flush();
    expect(input('open')).toBeDefined();
    const unlocks = call.mock.calls.filter(([m]) => m === 'session.unlock_owner');
    expect(unlocks).toHaveLength(2);
  });

  it('keeps the open fields disabled until their box is ticked, and shows the inline problem on Apply', async () => {
    const { call, rpc } = fakeRpc(state());
    render(rpc);
    await flush();
    expect(input('open').disabled).toBe(true);
    check(checkbox(t('security.open.require')), true);
    expect(input('open').disabled).toBe(false);

    await act(async () => void button(t('security.encrypt.apply')).click());
    await flush();
    expect(alertText()).toBe(t('security.problem.openMissing'));
    expect(call.mock.calls.some(([m]) => m === 'actions.run')).toBe(false);
  });

  it('sends one security.set with the typed open password and every permission', async () => {
    const { call, rpc } = fakeRpc(state());
    const { onClose } = render(rpc);
    await flush();
    check(checkbox(t('security.open.require')), true);
    typeInto(input('open'), 'open me');
    typeInto(input('openConfirm'), 'open me');
    await act(async () => void button(t('security.encrypt.apply')).click());
    await flush();
    const run = call.mock.calls.find(([m]) => m === 'actions.run');
    expect(run?.[1]).toEqual({
      handle: 'h1',
      name: 'security.set',
      args: {
        settings: {
          method: 'aes-256',
          user_password: 'open me',
          owner_password: 'open me',
          permissions: ALL,
        },
      },
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('sends the chosen permissions with a permissions password', async () => {
    const { call, rpc } = fakeRpc(state());
    render(rpc);
    await flush();
    check(checkbox(t('security.perms.restrict')), true);
    typeInto(input('owner'), 'boss');
    typeInto(input('ownerConfirm'), 'boss');
    check(checkbox(t('security.perm.copy')), false);
    await act(async () => void button(t('security.encrypt.apply')).click());
    await flush();
    const args = call.mock.calls.find(([m]) => m === 'actions.run')?.[1] as {
      args: { settings: { owner_password: string; permissions: Record<string, boolean> } };
    };
    expect(args.args.settings.owner_password).toBe('boss');
    expect(args.args.settings.permissions).toMatchObject({
      copy: false,
      print: true,
      accessibility: true,
      print_high_quality: true,
    });
  });

  it('shows a length or encoding problem through t() and sends nothing', async () => {
    const { call, rpc } = fakeRpc(state());
    render(rpc);
    await flush();
    typeInto(input('owner'), 'pässwörd');
    typeInto(input('ownerConfirm'), 'pässwörd');
    check(checkbox(t('security.perms.restrict')), true);
    const method = document.querySelector('select') as HTMLSelectElement;
    act(() => {
      method.value = 'aes-128';
      method.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => void button(t('security.encrypt.apply')).click());
    await flush();
    expect(alertText()).toBe(t('security.problem.encoding'));
    expect(call.mock.calls.some(([m]) => m === 'actions.run')).toBe(false);
  });

  it('shows a refusal from the engine as its message', async () => {
    const refusal = new RpcError('REFUSED', 'x', { reason: 'invalid_settings' });
    const { rpc } = fakeRpc(state(), { refusal });
    render(rpc);
    await flush();
    check(checkbox(t('security.perms.restrict')), true);
    typeInto(input('owner'), 'boss');
    typeInto(input('ownerConfirm'), 'boss');
    await act(async () => void button(t('security.encrypt.apply')).click());
    await flush();
    expect(alertText()).toBe(t('security.refused.invalid'));
  });

  it('does not keep the passwords once the dialog is closed', async () => {
    const { rpc } = fakeRpc(state());
    const { rerender } = render(rpc);
    await flush();
    check(checkbox(t('security.open.require')), true);
    typeInto(input('open'), 'secret-open-123');
    rerender(false);
    expect(document.body.innerHTML).not.toContain('secret-open-123');
    rerender(true);
    await flush();
    expect(input('open').value).toBe('');
  });
});
