// The Remove Security dialog (W7.5 S4), as ui/protect_controller.py remove_security: a file with
// no security says so; a pending change that was never saved is dropped with no confirmation; an
// encrypted file needs the owner password, then a confirmation, then one security.remove call.
import { useEffect, useId, useMemo, useState } from 'react';
import type { PageRpc } from '../engine/engineConnection';
import type { MessageId } from '../i18n/en';
import { t } from '../i18n/t';
import { type ToastStore } from '../feedback/toasts';
import { Overlay } from '../layout/Overlay';
import { OwnerUnlock } from './OwnerUnlock';
import { applyRemove, loadSecurity, type SecurityDeps } from './security';
import './security.css';

export interface RemoveSecurityDialogProps {
  isOpen: boolean;
  onClose: () => void;
  rpc: PageRpc;
  handle: string;
  // The document's display name, for the confirmation text.
  name: string;
  store?: ToastStore;
}

type Stage = 'loading' | 'none' | 'unlock' | 'confirm' | 'done' | 'failed';

// The decision the dialog opens with. A pending change that was never saved is dropped here, with
// no password and no confirmation.
interface Next {
  readonly stage: Stage;
  readonly message?: MessageId;
}

async function decideRemove(deps: SecurityDeps): Promise<Next> {
  const state = await loadSecurity(deps);
  if (state === undefined) return { stage: 'failed' };
  const encrypted = state.encryption !== 'none';
  if (!encrypted && (state.pending === null || state.pending_method === 'none')) {
    return { stage: 'none' };
  }
  if (!encrypted) {
    const outcome = await applyRemove(deps, false);
    if (outcome.status === 'applied') return { stage: 'done' };
    return outcome.status === 'refused'
      ? { stage: 'failed', message: outcome.message }
      : { stage: 'failed' };
  }
  return { stage: state.owner_access ? 'confirm' : 'unlock' };
}

export function RemoveSecurityDialog({
  isOpen,
  onClose,
  rpc,
  handle,
  name,
  store,
}: RemoveSecurityDialogProps) {
  // Memoised: the body's load effect runs once per dialog open, not on every parent render.
  const deps = useMemo(() => ({ rpc, handle, store }), [rpc, handle, store]);
  return (
    <Overlay
      isOpen={isOpen}
      onClose={onClose}
      title={t('security.remove.title')}
      showCloseButton={false}
    >
      <RemoveBody deps={deps} name={name} onDone={onClose} />
    </Overlay>
  );
}

interface BodyProps {
  readonly deps: SecurityDeps;
  readonly name: string;
  readonly onDone: () => void;
}

function RemoveBody({ deps, name, onDone }: BodyProps) {
  const id = useId();
  const [stage, setStage] = useState<Stage>('loading');
  const [message, setMessage] = useState<MessageId | null>(null);
  const [busy, setBusy] = useState(false);

  // Bumped after an unlock, so the state (and the owner access) is read again.
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    void decideRemove(deps).then((next) => {
      if (!live) return;
      setStage(next.stage);
      setMessage(next.message ?? null);
    });
    return () => {
      live = false;
    };
  }, [deps, reload]);

  const remove = async () => {
    setBusy(true);
    const outcome = await applyRemove(deps, true);
    setBusy(false);
    if (outcome.status === 'applied') {
      onDone();
    } else {
      setMessage(outcome.status === 'refused' ? outcome.message : 'security.failed');
    }
  };

  const close = (
    <div className="overlay-actions">
      <button type="button" className="overlay-close" onClick={onDone}>
        {t('action.cancel')}
      </button>
    </div>
  );

  if (stage === 'none' || stage === 'failed' || stage === 'done') {
    const text: MessageId | null =
      message ??
      (stage === 'none'
        ? 'security.none'
        : stage === 'failed'
          ? 'security.failed'
          : 'security.pendingDropped');
    return (
      <div className="security-form">
        <p>{t(text)}</p>
        {close}
      </div>
    );
  }
  if (stage === 'unlock') {
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
  if (stage !== 'confirm') return null;
  return (
    <div className="security-form">
      <p id={`${id}-body`}>{t('security.remove.body', { name })}</p>
      {message !== null ? (
        <p className="security-problem" role="alert">
          {t(message)}
        </p>
      ) : null}
      <div className="overlay-actions">
        <button type="button" className="overlay-close" onClick={onDone}>
          {t('action.cancel')}
        </button>
        <button
          type="button"
          className="feedback-primary"
          disabled={busy}
          onClick={() => void remove()}
        >
          {t('security.remove.confirm')}
        </button>
      </div>
    </div>
  );
}
