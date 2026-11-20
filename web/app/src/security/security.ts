// The security dialogs' logic (W7.5 S3, no UI): the form model, the checks that repeat the
// engine's security.set rules for inline messages, the argument builder, and the calls behind
// Encrypt with Password and Remove Security. The engine's rule is the single source (actions/
// security.py `_check_settings`); this file only mirrors it so the user sees the problem before a
// call is sent.
//
// Passwords live only in the caller's form state. Nothing here stores, logs or quotes them: a
// message is a fixed id, and a toast never carries a password.
import type { PageRpc } from '../engine/engineConnection';
import { offerUndo, undoOffered, type UndoOutcome } from '../feedback/undoToast';
import { reportRpcError, toasts, type ToastStore } from '../feedback/toasts';
import type { MessageId } from '../i18n/en';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import type { Permissions, SecurityResult } from '../rpc/generated';

export type EncryptMethod = 'aes-256' | 'aes-128';

export type PermissionKey = 'print' | 'modify' | 'copy' | 'annotate' | 'fill_forms' | 'assemble';

// The six boxes the dialog shows. accessibility is always allowed, and print_high_quality follows
// print, as on the desktop (ui/dialogs/security.py).
export const PERMISSION_KEYS: readonly PermissionKey[] = [
  'print',
  'modify',
  'copy',
  'annotate',
  'fill_forms',
  'assemble',
];

export const PERMISSION_LABEL: Readonly<Record<PermissionKey, MessageId>> = {
  print: 'security.perm.print',
  modify: 'security.perm.modify',
  copy: 'security.perm.copy',
  annotate: 'security.perm.annotate',
  fill_forms: 'security.perm.fill_forms',
  assemble: 'security.perm.assemble',
};

// Mirrors actions/security.py. AES-256 takes UTF-8 up to 127 bytes; AES-128 takes at most 32
// ASCII characters.
const AES_256_MAX_BYTES = 127;
const AES_128_MAX_CHARS = 32;

export interface EncryptForm {
  readonly method: EncryptMethod;
  readonly requireOpen: boolean;
  readonly openPassword: string;
  readonly openConfirm: string;
  readonly restrict: boolean;
  readonly ownerPassword: string;
  readonly ownerConfirm: string;
  readonly permissions: Readonly<Record<PermissionKey, boolean>>;
}

export type SecurityArgs = {
  readonly settings: {
    readonly method: EncryptMethod;
    readonly user_password: string;
    readonly owner_password: string;
    readonly permissions: Permissions;
  };
};

// The same deps shape the properties feature uses: the engine connection, the document handle and
// an optional toast store (tests pass their own).
export interface SecurityDeps {
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly store?: ToastStore;
}

// What a change did. `invalid` means nothing was sent: the message is shown inline.
export type SecurityOutcome =
  | { readonly status: 'applied' }
  | { readonly status: 'unchanged' }
  | { readonly status: 'invalid'; readonly message: MessageId }
  | { readonly status: 'refused'; readonly message: MessageId }
  | { readonly status: 'failed' };

export type UnlockOutcome = 'unlocked' | 'wrong' | 'failed';

function utf8Length(password: string): number {
  return new TextEncoder().encode(password).length;
}

function isAscii(password: string): boolean {
  return Array.from(password).every((ch) => (ch.codePointAt(0) ?? 0) < 128);
}

// The length and encoding rule for one password under the chosen method. '' has no problem.
function passwordProblem(method: EncryptMethod, password: string): MessageId | null {
  if (method === 'aes-256') {
    return utf8Length(password) > AES_256_MAX_BYTES ? 'security.problem.tooLong' : null;
  }
  if (Array.from(password).length > AES_128_MAX_CHARS) return 'security.problem.tooLong';
  return isAscii(password) ? null : 'security.problem.encoding';
}

// Why the form can't be applied, in the desktop's order (SecurityDialog.problem), then the length
// and encoding rules. null when it can.
export function encryptProblem(form: EncryptForm): MessageId | null {
  if (!form.requireOpen && !form.restrict) return 'security.problem.nothing';
  if (form.requireOpen) {
    if (!form.openPassword) return 'security.problem.openMissing';
    if (form.openPassword !== form.openConfirm) return 'security.problem.openMismatch';
  }
  if (form.restrict) {
    if (!form.ownerPassword) return 'security.problem.ownerMissing';
    if (form.ownerPassword !== form.ownerConfirm) return 'security.problem.ownerMismatch';
    if (form.requireOpen && form.ownerPassword === form.openPassword) {
      return 'security.problem.samePassword';
    }
  }
  const open = form.requireOpen ? form.openPassword : '';
  const owner = form.restrict ? form.ownerPassword : '';
  return passwordProblem(form.method, open) ?? passwordProblem(form.method, owner);
}

// The security.set arguments. All eight permission keys are sent. With only an open password,
// the owner password is the open one and everything is allowed (desktop parity).
export function securityArgs(form: EncryptForm): SecurityArgs {
  const open = form.requireOpen ? form.openPassword : '';
  if (!form.restrict) {
    const everything: Permissions = {
      print: true,
      modify: true,
      copy: true,
      annotate: true,
      fill_forms: true,
      accessibility: true,
      assemble: true,
      print_high_quality: true,
    };
    return {
      settings: {
        method: form.method,
        user_password: open,
        owner_password: open,
        permissions: everything,
      },
    };
  }
  const p = form.permissions;
  return {
    settings: {
      method: form.method,
      user_password: open,
      owner_password: form.ownerPassword,
      permissions: {
        print: p.print,
        modify: p.modify,
        copy: p.copy,
        annotate: p.annotate,
        fill_forms: p.fill_forms,
        accessibility: true,
        assemble: p.assemble,
        print_high_quality: p.print,
      },
    },
  };
}

// The six boxes, prefilled from the file's own permissions.
export function initialPermissions(state: SecurityResult): Record<PermissionKey, boolean> {
  const perms = state.permissions;
  return {
    print: perms.print,
    modify: perms.modify,
    copy: perms.copy,
    annotate: perms.annotate,
    fill_forms: perms.fill_forms,
    assemble: perms.assemble,
  };
}

// The engine's REFUSED reasons (W7.5 section 4) as message ids; null for anything else.
export function securityErrorMessage(error: unknown): MessageId | null {
  if (!(error instanceof RpcError) || error.code !== 'REFUSED') return null;
  switch (error.details.reason) {
    case 'signed_document':
      return 'security.refused.signed';
    case 'owner_password_needed':
      return 'security.refused.owner';
    case 'no_security':
      return 'security.none';
    case 'invalid_settings':
      return 'security.refused.invalid';
    default:
      return null;
  }
}

function reportFailure(store: ToastStore, error: unknown): void {
  if (error instanceof RpcError) reportRpcError(store, error);
  else store.push('error', t('security.failed'));
}

// The security state (session.security). Undefined when the call failed; the failure is reported.
export async function loadSecurity(deps: SecurityDeps): Promise<SecurityResult | undefined> {
  const store = deps.store ?? toasts;
  try {
    return await deps.rpc.call('session.security', { handle: deps.handle });
  } catch (error) {
    reportFailure(store, error);
    return undefined;
  }
}

// Checks the owner (permissions) password with session.unlock_owner. The password is never kept.
export async function unlockOwner(deps: SecurityDeps, password: string): Promise<UnlockOutcome> {
  const store = deps.store ?? toasts;
  try {
    const reply = await deps.rpc.call('session.unlock_owner', {
      handle: deps.handle,
      password,
    });
    return reply.unlocked ? 'unlocked' : 'wrong';
  } catch (error) {
    reportFailure(store, error);
    return 'failed';
  }
}

// One security action through actions.run. Its info toast offers Undo for this step only, as
// properties/apply.ts does. A refusal is shown as its own message; anything else is reported.
async function runChange(
  deps: SecurityDeps,
  name: 'security.set' | 'security.remove',
  args: Record<string, unknown>,
  queuedText: MessageId,
): Promise<SecurityOutcome> {
  const store = deps.store ?? toasts;
  try {
    const reply = await deps.rpc.call('actions.run', { handle: deps.handle, name, args });
    if (!reply.executed) return { status: 'unchanged' };
    offerUndo('info', t(queuedText), {
      rpc: deps.rpc,
      handle: deps.handle,
      history: reply.state.history,
      store,
    });
    return { status: 'applied' };
  } catch (error) {
    const message = securityErrorMessage(error);
    if (message) {
      store.push('error', t(message));
      return { status: 'refused', message };
    }
    reportFailure(store, error);
    return { status: 'failed' };
  }
}

// Encrypt with Password. A form problem is returned without any call.
export async function applyEncrypt(
  deps: SecurityDeps,
  form: EncryptForm,
): Promise<SecurityOutcome> {
  const problem = encryptProblem(form);
  if (problem) return { status: 'invalid', message: problem };
  return runChange(deps, 'security.set', securityArgs(form), 'security.queued');
}

// Remove Security. `encrypted` picks the toast text: a pending change that is only dropped says so.
export async function applyRemove(
  deps: SecurityDeps,
  encrypted: boolean,
): Promise<SecurityOutcome> {
  return runChange(
    deps,
    'security.remove',
    {},
    encrypted ? 'security.removeQueued' : 'security.pendingDropped',
  );
}

// Undo of one security step, by the history number its toast offered.
export async function undoSecurity(deps: SecurityDeps, history: number): Promise<UndoOutcome> {
  return undoOffered({
    rpc: deps.rpc,
    handle: deps.handle,
    history,
    store: deps.store ?? toasts,
  });
}
