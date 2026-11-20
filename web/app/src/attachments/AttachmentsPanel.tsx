// The attachments side panel (W5.2, W7.9 S2): the document's embedded files as a list. Selecting one
// shows its name, size and description, and Save downloads its bytes through the shared download
// helper. The panel is read-only: adding and removing attachments come later. The file is never
// opened or run; its name and description are untrusted text, shown as text only.
import { useEffect, useState } from 'react';
import { reportActionError } from '../actionJob/errors';
import type { PageRpc } from '../engine/engineConnection';
import { toasts, type ToastStore } from '../feedback/toasts';
import { downloadBytes } from '../files/downloads';
import { t } from '../i18n/t';
import { Panel } from '../layout/Panel';
import type { AttachmentEntry } from '../rpc/generated';
import './attachments.css';

export interface AttachmentsPanelProps {
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly onClose: () => void;
  readonly store?: ToastStore;
  // Hands the saved bytes to the browser. The default makes a download.
  readonly download?: (name: string, bytes: ArrayBuffer, type?: string) => void;
}

// A byte count for people: bytes below 1 KB, then KB, MB and GB to one decimal place.
export function formatSize(bytes: number): string {
  if (bytes < 1024) return t('attachments.size.bytes', { count: bytes });
  const kb = bytes / 1024;
  if (kb < 1024) return t('attachments.size.kb', { value: kb.toFixed(1) });
  const mb = kb / 1024;
  if (mb < 1024) return t('attachments.size.mb', { value: mb.toFixed(1) });
  return t('attachments.size.gb', { value: (mb / 1024).toFixed(1) });
}

// The name the file is saved under: the last part of the declared name, without path separators
// or control characters, since the declared name is untrusted text.
export function saveName(declared: string): string {
  // The control characters are stripped on purpose, so the pattern names them.
  // eslint-disable-next-line no-control-regex
  const base = (declared.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return base === '' || base === '.' || base === '..' ? 'attachment' : base;
}

function displayName(entry: AttachmentEntry): string {
  return entry.filename === '' ? t('attachments.unnamed') : entry.filename;
}

type ListProps = Required<Omit<AttachmentsPanelProps, 'onClose'>>;

function AttachmentList({ rpc, handle, store, download }: ListProps) {
  const [entries, setEntries] = useState<readonly AttachmentEntry[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    rpc.call('attachments.list', { handle }).then(
      (reply) => {
        if (active) setEntries(reply.entries);
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
      <p role="alert" className="attachments-status">
        {t('attachments.loadFailed')}
      </p>
    );
  }
  if (entries === null) {
    return (
      <p role="status" className="attachments-status">
        {t('attachments.loading')}
      </p>
    );
  }
  if (entries.length === 0) {
    return (
      <p role="status" className="attachments-status">
        {t('attachments.empty')}
      </p>
    );
  }

  const chosen = selected === null ? undefined : entries[selected];
  const save = (entry: AttachmentEntry) => {
    setSaving(true);
    rpc.call('attachments.get', { handle, name: entry.name }).then(
      (file) => {
        setSaving(false);
        // The file is not known to be a PDF: it goes out as the generic binary type.
        download(saveName(file.filename), file.data, 'application/octet-stream');
      },
      (error: unknown) => {
        setSaving(false);
        reportActionError(store, error, 'attachments.saveFailed');
      },
    );
  };

  return (
    <div className="attachments-body panel-fill">
      <ul className="attachments-list" aria-label={t('attachments.list')}>
        {entries.map((entry, index) => (
          <li key={entry.name}>
            <button
              type="button"
              className="attachments-item"
              aria-pressed={index === selected}
              onClick={() => setSelected(index)}
            >
              <span className="attachments-name">{displayName(entry)}</span>
              <span className="attachments-size">{formatSize(entry.size)}</span>
            </button>
          </li>
        ))}
      </ul>
      {chosen !== undefined && (
        <section className="attachments-details" aria-label={t('attachments.details')}>
          <dl>
            <dt>{t('attachments.field.name')}</dt>
            <dd>{displayName(chosen)}</dd>
            <dt>{t('attachments.field.size')}</dt>
            <dd>{formatSize(chosen.size)}</dd>
            <dt>{t('attachments.field.description')}</dt>
            <dd>
              {chosen.description === '' ? t('attachments.noDescription') : chosen.description}
            </dd>
          </dl>
          <button
            type="button"
            className="attachments-save"
            disabled={saving}
            onClick={() => save(chosen)}
          >
            {t('attachments.save')}
          </button>
        </section>
      )}
    </div>
  );
}

export function AttachmentsPanel({
  onClose,
  store = toasts,
  download = downloadBytes,
  ...list
}: AttachmentsPanelProps) {
  return (
    <Panel title={t('attachments.title')} onClose={onClose}>
      <AttachmentList {...list} store={store} download={download} />
    </Panel>
  );
}
