// The layers side panel (W5.2, W7.9 S3 and L2): the document's optional content layers as a list, in
// the engine's UI order. Each row shows the layer's name, whether it is visible in the document's
// default view, and whether it is locked. Nesting is shown as indentation. A checkbox shows or hides
// a layer through layers.set_visible. That is view state only: nothing is saved, no Undo entry, and
// the document is not marked changed. The names come from the file and are untrusted text, shown as
// text.
import { useEffect, useState } from 'react';
import type { PageRpc } from '../engine/engineConnection';
import { reportRpcError, toasts } from '../feedback/toasts';
import { t } from '../i18n/t';
import { Panel } from '../layout/Panel';
import { RpcError } from '../rpc/client';
import type { LayerEntry } from '../rpc/generated';
import './layers.css';

export interface LayersPanelProps {
  readonly rpc: PageRpc;
  readonly handle: string;
  // Changes when the document's structure changes (a snapshot restore): the list is read again.
  readonly revision: number;
  readonly onClose: () => void;
}

// Deeper levels share the last indent step, so a very deep tree stays inside the panel.
const MAX_INDENT = 5;

function displayName(entry: LayerEntry): string {
  return entry.name === '' ? t('layers.unnamed') : entry.name;
}

interface LayerRowProps {
  readonly entry: LayerEntry;
  // True while a toggle is in flight: every checkbox waits for its reply.
  readonly busy: boolean;
  readonly onToggle: (entry: LayerEntry, visible: boolean) => void;
}

function LayerRow({ entry, busy, onToggle }: LayerRowProps) {
  const indent = Math.min(entry.depth, MAX_INDENT);
  return (
    <li className={`layers-item layers-indent-${indent}`}>
      <label className="layers-toggle">
        <input
          type="checkbox"
          className="layers-check"
          checked={entry.visible}
          disabled={entry.locked || busy}
          onChange={(event) => onToggle(entry, event.currentTarget.checked)}
        />
        <span className="layers-name">{displayName(entry)}</span>
      </label>
      <span className="layers-state">
        <span>{entry.visible ? t('layers.visible') : t('layers.hidden')}</span>
        {entry.locked && <span className="layers-locked">{t('layers.locked')}</span>}
      </span>
    </li>
  );
}

function LayerList({ rpc, handle, revision }: Omit<LayersPanelProps, 'onClose'>) {
  const [layers, setLayers] = useState<readonly LayerEntry[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  // Bumped when a toggle finds the list out of date, so the list is read again.
  const [rereadToken, setRereadToken] = useState(0);

  useEffect(() => {
    let active = true;
    rpc.call('layers.list', { handle }).then(
      (reply) => {
        if (!active) return;
        setLoadFailed(false);
        setLayers(reply.layers);
      },
      () => {
        if (active) setLoadFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, handle, revision, rereadToken]);

  // The reply carries the whole list again, so it replaces the rows. A refusal (locked, no layers)
  // or a failure leaves the list as it was: the checkbox shows the state the engine still has.
  const toggle = (entry: LayerEntry, visible: boolean) => {
    if (busy) return;
    setBusy(true);
    void rpc
      .call('layers.set_visible', { handle, id: entry.id, visible })
      .then(
        (reply) => {
          setLayers(reply.layers);
        },
        (error: unknown) => {
          if (error instanceof RpcError) {
            if (error.code === 'STALE_OBJECT') setRereadToken((value) => value + 1);
            reportRpcError(toasts, error);
          } else {
            toasts.push('error', t('layers.toggleFailed'));
          }
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };

  if (loadFailed) {
    return (
      <p role="alert" className="layers-status">
        {t('layers.loadFailed')}
      </p>
    );
  }
  if (layers === null) {
    return (
      <p role="status" className="layers-status">
        {t('layers.loading')}
      </p>
    );
  }
  if (layers.length === 0) {
    return (
      <p role="status" className="layers-status">
        {t('layers.empty')}
      </p>
    );
  }
  return (
    <div className="layers-body panel-fill">
      <p className="layers-status">{t('layers.viewOnly')}</p>
      <ul className="layers-list" aria-label={t('layers.list')}>
        {layers.map((entry) => (
          <LayerRow key={entry.id} entry={entry} busy={busy} onToggle={toggle} />
        ))}
      </ul>
    </div>
  );
}

export function LayersPanel({ onClose, ...list }: LayersPanelProps) {
  return (
    <Panel title={t('layers.title')} onClose={onClose}>
      <LayerList {...list} />
    </Panel>
  );
}
