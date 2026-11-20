// The Encrypt with Password dialog (W7.5 S4, the desktop's SecurityDialog): the method, an open
// password with its confirm, and the permissions password with its confirm and six boxes. Apply
// queues one security.set; the info toast offers Undo (security.ts). A signed document is refused
// up front, and an encrypted one without owner access asks for the owner password first.
// The passwords live in the form's state only: closing the dialog unmounts it with them.
import { type FormEvent, useEffect, useId, useMemo, useState } from 'react';
import type { PageRpc } from '../engine/engineConnection';
import type { ToastStore } from '../feedback/toasts';
import type { MessageId } from '../i18n/en';
import { t } from '../i18n/t';
import { Overlay } from '../layout/Overlay';
import type { SecurityResult } from '../rpc/generated';
import { OwnerUnlock } from './OwnerUnlock';
import {
  applyEncrypt,
  type EncryptForm,
  type EncryptMethod,
  encryptProblem,
  initialPermissions,
  loadSecurity,
  PERMISSION_KEYS,
  PERMISSION_LABEL,
  type PermissionKey,
  type SecurityDeps,
} from './security';
import './security.css';

export interface EncryptDialogProps {
  isOpen: boolean;
  onClose: () => void;
  rpc: PageRpc;
  handle: string;
  store?: ToastStore;
}

export function EncryptDialog({ isOpen, onClose, rpc, handle, store }: EncryptDialogProps) {
  // Memoised: the body's load effect runs once per dialog open, not on every parent render.
  const deps = useMemo(() => ({ rpc, handle, store }), [rpc, handle, store]);
  return (
    <Overlay
      isOpen={isOpen}
      onClose={onClose}
      title={t('security.encrypt.title')}
      showCloseButton={false}
    >
      <EncryptBody deps={deps} onDone={onClose} />
    </Overlay>
  );
}

type Stage =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'signed' }
  | { readonly kind: 'unlock' }
  | { readonly kind: 'form'; readonly state: SecurityResult };

function stageOf(state: SecurityResult | undefined): Stage {
  if (state === undefined) return { kind: 'failed' };
  if (state.has_signatures) return { kind: 'signed' };
  if (!state.owner_access) return { kind: 'unlock' };
  return { kind: 'form', state };
}

interface BodyProps {
  readonly deps: SecurityDeps;
  readonly onDone: () => void;
}

function EncryptBody({ deps, onDone }: BodyProps) {
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  // Bumped after an unlock, so the state (and the owner access) is read again.
  const [reload, setReload] = useState(0);

  useEffect(() => {
    void loadSecurity(deps).then((state) => {
      setStage(stageOf(state));
    });
  }, [deps, reload]);

  if (stage.kind === 'loading') return null;
  if (stage.kind === 'failed' || stage.kind === 'signed') {
    const text: MessageId = stage.kind === 'signed' ? 'security.refused.signed' : 'security.failed';
    return (
      <div className="security-form">
        <p>{t(text)}</p>
        <div className="overlay-actions">
          <button type="button" className="overlay-close" onClick={onDone}>
            {t('action.cancel')}
          </button>
        </div>
      </div>
    );
  }
  if (stage.kind === 'unlock') {
    return (
      <OwnerUnlock
        deps={deps}
        onUnlocked={() => {
          setReload((n) => n + 1);
        }}
        onCancel={onDone}
      />
    );
  }
  return <EncryptFields deps={deps} state={stage.state} onDone={onDone} />;
}

// One password field. Its value is the form's state, never the document's.
function PasswordField(props: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="security-field">
      <label htmlFor={props.id}>{props.label}</label>
      <input
        id={props.id}
        type="password"
        autoComplete="new-password"
        disabled={props.disabled}
        value={props.value}
        onChange={(event) => {
          props.onChange(event.currentTarget.value);
        }}
      />
    </div>
  );
}

function EncryptFields({ deps, state, onDone }: BodyProps & { readonly state: SecurityResult }) {
  const id = useId();
  const [form, setForm] = useState<EncryptForm>(() => ({
    method: 'aes-256',
    requireOpen: false,
    openPassword: '',
    openConfirm: '',
    restrict: false,
    ownerPassword: '',
    ownerConfirm: '',
    permissions: initialPermissions(state),
  }));
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<MessageId | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (patch: Partial<EncryptForm>) => {
    setForm((current) => ({ ...current, ...patch }));
  };
  // Once Apply has been tried, the inline problem follows the fields as they change.
  const message = submitted ? (encryptProblem(form) ?? error) : null;

  const apply = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    setError(null);
    setBusy(true);
    const outcome = await applyEncrypt(deps, form);
    setBusy(false);
    if (outcome.status === 'applied') onDone();
    else if (outcome.status === 'refused' || outcome.status === 'invalid') {
      setError(outcome.message);
    }
  };

  const toggle = (key: PermissionKey, checked: boolean) => {
    set({ permissions: { ...form.permissions, [key]: checked } });
  };

  return (
    <form className="security-form" noValidate onSubmit={(event) => void apply(event)}>
      <p className="security-note">{t('security.encrypt.note')}</p>
      <div className="security-field">
        <label htmlFor={`${id}-method`}>{t('security.method.label')}</label>
        <select
          id={`${id}-method`}
          value={form.method}
          onChange={(event) => {
            set({ method: event.currentTarget.value as EncryptMethod });
          }}
        >
          <option value="aes-256">{t('security.method.aes-256')}</option>
          <option value="aes-128">{t('security.method.aes-128')}</option>
        </select>
      </div>
      <fieldset className="security-group">
        <legend>{t('security.open.group')}</legend>
        <label className="security-check">
          <input
            type="checkbox"
            checked={form.requireOpen}
            onChange={(event) => {
              set({ requireOpen: event.currentTarget.checked });
            }}
          />
          {t('security.open.require')}
        </label>
        <PasswordField
          id={`${id}-open`}
          label={t('security.open.password')}
          value={form.openPassword}
          disabled={!form.requireOpen}
          onChange={(value) => {
            set({ openPassword: value });
          }}
        />
        <PasswordField
          id={`${id}-openConfirm`}
          label={t('security.open.confirm')}
          value={form.openConfirm}
          disabled={!form.requireOpen}
          onChange={(value) => {
            set({ openConfirm: value });
          }}
        />
      </fieldset>
      <fieldset className="security-group">
        <legend>{t('security.perms.group')}</legend>
        <label className="security-check">
          <input
            type="checkbox"
            checked={form.restrict}
            onChange={(event) => {
              set({ restrict: event.currentTarget.checked });
            }}
          />
          {t('security.perms.restrict')}
        </label>
        <PasswordField
          id={`${id}-owner`}
          label={t('security.perms.password')}
          value={form.ownerPassword}
          disabled={!form.restrict}
          onChange={(value) => {
            set({ ownerPassword: value });
          }}
        />
        <PasswordField
          id={`${id}-ownerConfirm`}
          label={t('security.perms.confirm')}
          value={form.ownerConfirm}
          disabled={!form.restrict}
          onChange={(value) => {
            set({ ownerConfirm: value });
          }}
        />
        <p>{t('security.perms.allowed')}</p>
        {PERMISSION_KEYS.map((key) => (
          <label className="security-check" key={key}>
            <input
              type="checkbox"
              checked={form.permissions[key]}
              disabled={!form.restrict}
              onChange={(event) => {
                toggle(key, event.currentTarget.checked);
              }}
            />
            {t(PERMISSION_LABEL[key])}
          </label>
        ))}
      </fieldset>
      {message !== null ? (
        <p className="security-problem" role="alert">
          {t(message)}
        </p>
      ) : null}
      <div className="overlay-actions">
        <button type="button" className="overlay-close" onClick={onDone}>
          {t('action.cancel')}
        </button>
        <button type="submit" className="feedback-primary" disabled={busy}>
          {t('security.encrypt.apply')}
        </button>
      </div>
    </form>
  );
}
