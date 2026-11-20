import { describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { createToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import type { SecurityResult } from '../rpc/generated';
import {
  applyEncrypt,
  applyRemove,
  type EncryptForm,
  encryptProblem,
  initialPermissions,
  loadSecurity,
  securityArgs,
  securityErrorMessage,
  type SecurityDeps,
  unlockOwner,
  undoSecurity,
} from './security';

const ALL = {
  print: true,
  modify: true,
  copy: true,
  annotate: true,
  fill_forms: true,
  assemble: true,
};

function form(over: Partial<EncryptForm> = {}): EncryptForm {
  return {
    method: 'aes-256',
    requireOpen: true,
    openPassword: 'open me',
    openConfirm: 'open me',
    restrict: true,
    ownerPassword: 'boss',
    ownerConfirm: 'boss',
    permissions: { ...ALL, print: false, copy: false },
    ...over,
  };
}

function refused(reason: string): RpcError {
  return new RpcError('REFUSED', 'Refused', { reason });
}

function setup(call: (method: string, params: unknown) => Promise<unknown>) {
  const store = createToastStore();
  const fake = vi.fn(call);
  const deps: SecurityDeps = { rpc: { call: fake } as unknown as PageRpc, handle: 'h1', store };
  return { fake, store, deps };
}

const runOk = async (_m: string, p: unknown) => {
  const { name } = p as { name: string };
  return {
    label: name === 'security.set' ? 'Encrypt with Password' : 'Remove Security',
    executed: true,
    value: null,
    changed: null,
    state: { history: 4 },
  };
};

describe('encryptProblem', () => {
  it('follows the desktop order of checks', () => {
    expect(encryptProblem(form({ requireOpen: false, restrict: false }))).toBe(
      'security.problem.nothing',
    );
    expect(encryptProblem(form({ openPassword: '', openConfirm: '' }))).toBe(
      'security.problem.openMissing',
    );
    expect(encryptProblem(form({ openConfirm: 'x' }))).toBe('security.problem.openMismatch');
    expect(encryptProblem(form({ ownerPassword: '', ownerConfirm: '' }))).toBe(
      'security.problem.ownerMissing',
    );
    expect(encryptProblem(form({ ownerConfirm: 'x' }))).toBe('security.problem.ownerMismatch');
    expect(encryptProblem(form({ ownerPassword: 'open me', ownerConfirm: 'open me' }))).toBe(
      'security.problem.samePassword',
    );
    expect(encryptProblem(form())).toBeNull();
  });

  it('applies the AES-256 byte limit and the AES-128 length and ASCII rules', () => {
    const long = 'a'.repeat(128);
    expect(encryptProblem(form({ openPassword: long, openConfirm: long }))).toBe(
      'security.problem.tooLong',
    );
    const wide = 'é'.repeat(64); // 128 bytes in UTF-8
    expect(encryptProblem(form({ openPassword: wide, openConfirm: wide }))).toBe(
      'security.problem.tooLong',
    );
    expect(
      encryptProblem(
        form({ method: 'aes-128', openPassword: 'a'.repeat(33), openConfirm: 'a'.repeat(33) }),
      ),
    ).toBe('security.problem.tooLong');
    expect(
      encryptProblem(
        form({ method: 'aes-128', openPassword: 'pässwörd', openConfirm: 'pässwörd' }),
      ),
    ).toBe('security.problem.encoding');
    expect(
      encryptProblem(form({ method: 'aes-128', openPassword: 'plain-1', openConfirm: 'plain-1' })),
    ).toBeNull();
    expect(
      encryptProblem(form({ openPassword: 'pässwörd-密码', openConfirm: 'pässwörd-密码' })),
    ).toBeNull();
  });
});

describe('securityArgs', () => {
  it('sends all eight permission keys, with accessibility on and print_high_quality on print', () => {
    const { settings } = securityArgs(form({ permissions: { ...ALL, print: false } }));
    expect(Object.keys(settings.permissions).sort()).toEqual(
      [
        'accessibility',
        'annotate',
        'assemble',
        'copy',
        'fill_forms',
        'modify',
        'print',
        'print_high_quality',
      ].sort(),
    );
    expect(settings.permissions.accessibility).toBe(true);
    expect(settings.permissions.print_high_quality).toBe(false);
    expect(settings.owner_password).toBe('boss');
    expect(settings.user_password).toBe('open me');
  });

  it('with only an open password, the owner is the open password and everything is allowed', () => {
    const { settings } = securityArgs(
      form({ restrict: false, ownerPassword: '', ownerConfirm: '' }),
    );
    expect(settings.owner_password).toBe('open me');
    expect(settings.user_password).toBe('open me');
    expect(Object.values(settings.permissions).every((v) => v === true)).toBe(true);
  });

  it('with only a permissions password, there is no open password', () => {
    const { settings } = securityArgs(
      form({ requireOpen: false, openPassword: '', openConfirm: '' }),
    );
    expect(settings.user_password).toBe('');
    expect(settings.owner_password).toBe('boss');
  });
});

describe('initialPermissions', () => {
  it('prefills the six boxes from the file', () => {
    const state = {
      encryption: 'none',
      permissions: { ...ALL, print: false, print_high_quality: false, accessibility: true },
      owner_access: true,
      pending: null,
      pending_method: null,
      has_signatures: false,
    } as SecurityResult;
    expect(initialPermissions(state)).toEqual({ ...ALL, print: false });
  });
});

describe('applyEncrypt', () => {
  it('sends one security.set and offers Undo that calls actions.undo', async () => {
    const { fake, store, deps } = setup(runOk);
    expect(await applyEncrypt(deps, form())).toEqual({ status: 'applied' });
    expect(fake).toHaveBeenCalledTimes(1);
    expect(fake).toHaveBeenCalledWith('actions.run', {
      handle: 'h1',
      name: 'security.set',
      args: securityArgs(form()),
    });
    const toast = store.getState().visible[0];
    expect(toast?.text).toBe(t('security.queued'));
    toast?.action?.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake).toHaveBeenLastCalledWith('actions.undo', { handle: 'h1', expect_history: 4 });
  });

  it('returns an invalid form without calling the engine', async () => {
    const { fake, deps } = setup(runOk);
    expect(await applyEncrypt(deps, form({ openConfirm: 'nope' }))).toEqual({
      status: 'invalid',
      message: 'security.problem.openMismatch',
    });
    expect(fake).not.toHaveBeenCalled();
  });

  it('maps a refusal reason to its message and shows no password', async () => {
    const { store, deps } = setup(async () => {
      throw refused('signed_document');
    });
    const outcome = await applyEncrypt(deps, form());
    expect(outcome).toEqual({ status: 'refused', message: 'security.refused.signed' });
    const texts = store
      .getState()
      .visible.map((toast) => toast.text)
      .join(' ');
    expect(texts).toBe(t('security.refused.signed'));
    expect(texts).not.toContain('open me');
    expect(texts).not.toContain('boss');
  });

  it('reports an unknown RPC failure without its message being a password', async () => {
    const { store, deps } = setup(async () => {
      throw new RpcError('BUSY', 'Busy');
    });
    expect(await applyEncrypt(deps, form())).toEqual({ status: 'failed' });
    expect(store.getState().visible.length).toBe(1);
    expect(store.getState().visible[0]?.text).not.toContain('boss');
  });
});

describe('applyRemove', () => {
  it('sends one security.remove with the text for the case', async () => {
    const { fake, store, deps } = setup(runOk);
    expect(await applyRemove(deps, true)).toEqual({ status: 'applied' });
    expect(fake).toHaveBeenCalledWith('actions.run', {
      handle: 'h1',
      name: 'security.remove',
      args: {},
    });
    expect(store.getState().visible[0]?.text).toBe(t('security.removeQueued'));
  });

  it('a pending change that is only dropped says so', async () => {
    const { store, deps } = setup(runOk);
    await applyRemove(deps, false);
    expect(store.getState().visible[0]?.text).toBe(t('security.pendingDropped'));
  });

  it('maps no_security to its message', async () => {
    const { deps } = setup(async () => {
      throw refused('no_security');
    });
    expect(await applyRemove(deps, false)).toEqual({ status: 'refused', message: 'security.none' });
  });
});

describe('securityErrorMessage', () => {
  it('maps each engine reason and ignores other codes', () => {
    expect(securityErrorMessage(refused('owner_password_needed'))).toBe('security.refused.owner');
    expect(securityErrorMessage(refused('invalid_settings'))).toBe('security.refused.invalid');
    expect(securityErrorMessage(refused('something_else'))).toBeNull();
    expect(securityErrorMessage(new RpcError('BUSY', 'Busy'))).toBeNull();
    expect(securityErrorMessage(new Error('x'))).toBeNull();
  });
});

describe('loadSecurity and unlockOwner', () => {
  it('loads the state with session.security', async () => {
    const state = { encryption: 'aes-256' };
    const { fake, deps } = setup(async () => state);
    expect(await loadSecurity(deps)).toEqual(state);
    expect(fake).toHaveBeenCalledWith('session.security', { handle: 'h1' });
  });

  it('reports unlocked, wrong, and a failure', async () => {
    const ok = setup(async () => ({ unlocked: true })).deps;
    expect(await unlockOwner(ok, 'boss')).toBe('unlocked');
    const wrong = setup(async () => ({ unlocked: false })).deps;
    expect(await unlockOwner(wrong, 'nope')).toBe('wrong');
    const failed = setup(async () => {
      throw new RpcError('SAVE_FAILED', 'x');
    }).deps;
    expect(await unlockOwner(failed, 'boss')).toBe('failed');
  });

  it('sends the password only to session.unlock_owner', async () => {
    const { fake, deps } = setup(async () => ({ unlocked: true }));
    await unlockOwner(deps, 'boss');
    expect(fake).toHaveBeenCalledWith('session.unlock_owner', { handle: 'h1', password: 'boss' });
  });
});

describe('undoSecurity', () => {
  it('undoes the offered history number', async () => {
    const { fake, deps } = setup(async () => ({
      done: true,
      label: 'x',
      changed: null,
      state: {},
    }));
    expect(await undoSecurity(deps, 9)).toBe('undone');
    expect(fake).toHaveBeenCalledWith('actions.undo', { handle: 'h1', expect_history: 9 });
  });
});

describe('password storage', () => {
  it('never writes a password to localStorage or sessionStorage', async () => {
    const local = vi.spyOn(Storage.prototype, 'setItem');
    const { deps } = setup(runOk);
    await applyEncrypt(deps, form());
    await unlockOwner(deps, 'boss');
    expect(local).not.toHaveBeenCalled();
    local.mockRestore();
  });
});
