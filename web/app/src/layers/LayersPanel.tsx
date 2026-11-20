// The layers side panel (W5.2, W7.9 S3): the document's optional content layers as a list, in the
// engine's UI order. Each row shows the layer's name, whether it is visible in the document's
// default view, and whether it is locked. Nesting is shown as indentation. The panel is read-only:
// toggling a layer is W7.9 S4. The names come from the file and are untrusted text, shown as text.
import { useEffect, useState } from 'react';
import type { PageRpc } from '../engine/engineConnection';
import { t } from '../i18n/t';
import { Panel } from '../layout/Panel';
import type { LayerEntry } from '../rpc/generated';
import './layers.css';

export interface LayersPanelProps {
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly onClose: () => void;
}

// Deeper levels share the last indent step, so a very deep tree stays inside the panel.
const MAX_INDENT = 5;

function displayName(entry: LayerEntry): string {
  return entry.name === '' ? t('layers.unnamed') : entry.name;
}

function LayerRow({ entry }: { readonly entry: LayerEntry }) {
  const indent = Math.min(entry.depth, MAX_INDENT);
  return (
    <li className={`layers-item layers-indent-${indent}`}>
      <span className="layers-name">{displayName(entry)}</span>
      <span className="layers-state">
        <span>{entry.visible ? t('layers.visible') : t('layers.hidden')}</span>
        {entry.locked && <span className="layers-locked">{t('layers.locked')}</span>}
      </span>
    </li>
  );
}

function LayerList({ rpc, handle }: Omit<LayersPanelProps, 'onClose'>) {
  const [layers, setLayers] = useState<readonly LayerEntry[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let active = true;
    rpc.call('layers.list', { handle }).then(
      (reply) => {
        if (active) setLayers(reply.layers);
      },
      () => {
        if (active) setLoadFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, handle]);

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
      <ul className="layers-list" aria-label={t('layers.list')}>
        {layers.map((entry) => (
          <LayerRow key={entry.id} entry={entry} />
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
