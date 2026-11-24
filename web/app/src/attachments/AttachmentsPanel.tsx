// The attachments side panel (W5.2, W7.9 S2, A2): the document's embedded files as a list. Selecting
// one shows its name, size and description, and Save downloads its bytes through the shared download
// helper. A PDF attachment can also be opened as a new tab. Add embeds a picked file; Remove asks
// first and then removes it, with an Undo toast. A signed document refuses both, so they are disabled
// there. The file is never run; its name and description are untrusted text, shown as text only.
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { ActionJobWorker } from '../actionJob/actionJob';
import { reportActionError } from '../actionJob/errors';
import type { PageRpc } from '../engine/engineConnection';
import type { JobProgressStore } from '../feedback/jobRun';
import { toasts, type ToastStore } from '../feedback/toasts';
import { pickFile } from '../files/pickFile';
import { downloadBytes } from '../files/downloads';
import { t } from '../i18n/t';
import { Panel } from '../layout/Panel';
import type { AttachmentEntry, HistoryResult } from '../rpc/generated';
import {
  addFile,
  openPdfAttachment,
  probePdf,
  removeAttachment,
  type AttachmentDeps,
} from './attachmentActions';
import { RemoveDialog } from './RemoveDialog';
import { displayName, formatSize, saveName } from './format';
import './attachments.css';

export { formatSize, saveName } from './format';

export interface AttachmentsPanelProps {
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly onClose: () => void;
  // Changes when the document's history moved (App's counter): the list reloads, so an Undo or a
  // Redo of an add or a remove shows at once.
  readonly revision?: number;
  // A signed document refuses adding and removing: both are disabled, with the reason shown.
  readonly signed?: boolean;
  // The app's Undo handler, run by the Undo toast of an add or a remove.
  readonly onHistoryStep: (reply: HistoryResult) => void;
  // The job worker for a remove (App's jobs.acquire).
  readonly startWorker: () => ActionJobWorker;
  // Opens the given files as new tabs (App's openFiles).
  readonly onOpenFiles: (files: readonly File[]) => void;
  readonly store?: ToastStore;
  readonly progress?: JobProgressStore;
  // Hands the saved bytes to the browser. The default makes a download.
  readonly download?: (name: string, bytes: ArrayBuffer, type?: string) => void;
}

type ListProps = Omit<
  AttachmentsPanelProps,
  'onClose' | 'revision' | 'signed' | 'store' | 'download'
> & {
  readonly revision: number;
  readonly signed: boolean;
  readonly store: ToastStore;
  readonly download: NonNullable<AttachmentsPanelProps['download']>;
};

function AttachmentList({
  rpc,
  handle,
  store,
  download,
  revision,
  signed,
  onHistoryStep,
  startWorker,
  onOpenFiles,
  progress,
}: ListProps) {
  const [entries, setEntries] = useState<readonly AttachmentEntry[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  // Bumped after an add or a remove, so the list reads the document again.
  const [reloadToken, setReloadToken] = useState(0);
  const [confirming, setConfirming] = useState<AttachmentEntry | null>(null);
  // The names of the PDF attachments found so far, and the ones already read.
  const [pdfNames, setPdfNames] = useState<ReadonlySet<string>>(() => new Set());
  const probed = useRef(new Set<string>());

  useEffect(() => {
    let active = true;
    rpc.call('attachments.list', { handle }).then(
      (reply) => {
        if (!active) return;
        setEntries(reply.entries);
        setLoadFailed(false);
      },
      () => {
        if (active) setLoadFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, handle, revision, reloadToken]);

  const chosen = entries?.find((entry) => entry.name === selectedName);
  const chosenName = chosen?.name;

  // Reads the chosen attachment once to learn whether it is a PDF (Open is shown only for one).
  useEffect(() => {
    if (chosenName === undefined || probed.current.has(chosenName)) return undefined;
    probed.current.add(chosenName);
    let active = true;
    void probePdf(rpc, handle, chosenName).then((pdf) => {
      if (!active || !pdf) return;
      setPdfNames((known) => new Set(known).add(chosenName));
    });
    return () => {
      active = false;
    };
  }, [rpc, handle, chosenName]);

  const deps: AttachmentDeps = {
    rpc,
    handle,
    store,
    onHistoryStep,
    startWorker,
    ...(progress === undefined ? {} : { progress }),
  };
  const editable = !signed && !busy;

  // The list changed: read it again, and forget the PDF checks, since a name may now be another file.
  const listChanged = () => {
    probed.current.clear();
    setPdfNames(new Set());
    setReloadToken((value) => value + 1);
  };

  const addPicked = async () => {
    const file = await pickFile('');
    if (file === null) return;
    setBusy(true);
    const name = await addFile(deps, file);
    setBusy(false);
    if (name !== null) {
      setSelectedName(name);
      listChanged();
    }
  };

  const runRemove = async (entry: AttachmentEntry) => {
    setBusy(true);
    await removeAttachment(deps, entry);
    setBusy(false);
    setSelectedName(null);
    listChanged();
  };

  const runOpen = async (entry: AttachmentEntry) => {
    setBusy(true);
    await openPdfAttachment(deps, entry, onOpenFiles);
    setBusy(false);
  };

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

  const footer = (
    <div className="attachments-footer">
      {signed ? <p className="attachments-hint">{t('attachments.signedHint')}</p> : null}
      <button
        type="button"
        className="attachments-add"
        disabled={!editable}
        onClick={() => void addPicked()}
      >
        {t('attachments.add')}
      </button>
    </div>
  );

  let content: ReactNode;
  if (loadFailed) {
    content = (
      <p role="alert" className="attachments-status">
        {t('attachments.loadFailed')}
      </p>
    );
  } else if (entries === null) {
    content = (
      <p role="status" className="attachments-status">
        {t('attachments.loading')}
      </p>
    );
  } else if (entries.length === 0) {
    content = (
      <p role="status" className="attachments-status">
        {t('attachments.empty')}
      </p>
    );
  } else {
    content = (
      <>
        <ul className="attachments-list" aria-label={t('attachments.list')}>
          {entries.map((entry) => (
            <li key={entry.name}>
              <button
                type="button"
                className="attachments-item"
                aria-pressed={entry.name === selectedName}
                onClick={() => setSelectedName(entry.name)}
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
            <div className="attachments-actions">
              <button
                type="button"
                className="attachments-save"
                disabled={saving || busy}
                onClick={() => save(chosen)}
              >
                {t('attachments.save')}
              </button>
              {pdfNames.has(chosen.name) ? (
                <button
                  type="button"
                  className="attachments-open"
                  disabled={busy}
                  onClick={() => void runOpen(chosen)}
                >
                  {t('attachments.open')}
                </button>
              ) : null}
              <button
                type="button"
                className="attachments-remove"
                disabled={!editable}
                onClick={() => setConfirming(chosen)}
              >
                {t('attachments.remove')}
              </button>
            </div>
          </section>
        )}
      </>
    );
  }

  return (
    <div className="attachments-body panel-fill">
      {content}
      {footer}
      <RemoveDialog
        entry={confirming}
        onCancel={() => setConfirming(null)}
        onConfirm={(entry) => {
          setConfirming(null);
          void runRemove(entry);
        }}
      />
    </div>
  );
}

export function AttachmentsPanel({
  onClose,
  revision = 0,
  signed = false,
  store = toasts,
  download = downloadBytes,
  ...list
}: AttachmentsPanelProps) {
  return (
    <Panel title={t('attachments.title')} onClose={onClose}>
      <AttachmentList
        {...list}
        revision={revision}
        signed={signed}
        store={store}
        download={download}
      />
    </Panel>
  );
}
