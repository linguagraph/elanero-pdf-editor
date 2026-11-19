// The Import Comments dialog (W7.2 A5, W1.5 section 10). The user picks an XFDF file. Its size is
// checked before it is read; the engine then counts the comments it holds (a read that changes
// nothing). Import adds them as one undoable action, redraws the pages it changed and says how many
// came in. A file with no comments, or one the engine refuses, says so and offers no import.
import { useRef, useState } from 'react';
import { reportActionError } from '../actionJob/errors';
import type { PageRpc } from '../engine/engineConnection';
import { toasts, type ToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { Overlay } from '../layout/Overlay';
import type { ChangedDto } from '../rpc/generated';
import { RpcError } from '../rpc/client';
import '../redaction/redaction.css';
import {
  importedCount,
  importXfdf,
  MAX_XFDF_BYTES,
  previewXfdf,
  readXfdf,
  XfdfTooLarge,
  type XfdfPreview,
} from './xfdfImport';

export interface CommentsImportDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly engine: PageRpc;
  readonly handle: string;
  // Redraws the pages the import changed. The app passes the view's scheduler here.
  readonly onChanged?: (changed: ChangedDto | null) => void;
  readonly store?: ToastStore;
}

const ACCEPT = '.xfdf,.xml,application/vnd.adobe.xfdf,text/xml,application/xml';

// Where the dialog is. The text is kept from the preview to the import, so the file is read once.
type Phase =
  | { readonly status: 'pick' }
  | { readonly status: 'reading' }
  | { readonly status: 'preview'; readonly text: string; readonly counts: XfdfPreview }
  | { readonly status: 'empty' }
  | { readonly status: 'invalid' }
  | { readonly status: 'tooLarge' }
  | { readonly status: 'importing' };

export function CommentsImportDialog(props: CommentsImportDialogProps) {
  return (
    <Overlay
      isOpen={props.isOpen}
      onClose={props.onClose}
      title={t('commentsImport.title')}
      showCloseButton={false}
    >
      <CommentsImportBody {...props} />
    </Overlay>
  );
}

// Mounted only while the dialog is open, so each open starts from the file picker.
function CommentsImportBody({
  onClose,
  engine,
  handle,
  onChanged,
  store = toasts,
}: CommentsImportDialogProps) {
  const [phase, setPhase] = useState<Phase>({ status: 'pick' });
  const inputRef = useRef<HTMLInputElement>(null);

  // Reads and previews one picked file. A failure other than the two the dialog words itself goes
  // to a toast, and the dialog returns to the picker.
  const choose = async (file: File) => {
    setPhase({ status: 'reading' });
    let text: string;
    try {
      text = await readXfdf(file);
    } catch (error) {
      if (error instanceof XfdfTooLarge) {
        setPhase({ status: 'tooLarge' });
        return;
      }
      reportActionError(store, error, 'commentsImport.failed');
      setPhase({ status: 'pick' });
      return;
    }
    try {
      const counts = await previewXfdf(engine, handle, text);
      if (counts.comments === 0) {
        setPhase({ status: 'empty' });
      } else {
        setPhase({ status: 'preview', text, counts });
      }
    } catch (error) {
      if (error instanceof RpcError && error.code === 'FILE_TOO_LARGE') {
        setPhase({ status: 'tooLarge' });
      } else if (error instanceof RpcError && error.code === 'REFUSED') {
        setPhase({ status: 'invalid' });
      } else {
        reportActionError(store, error, 'commentsImport.failed');
        setPhase({ status: 'pick' });
      }
    }
  };

  // Adds the comments. The dialog closes on success; a failure keeps it open with the message.
  const importComments = async (text: string) => {
    setPhase({ status: 'importing' });
    try {
      const reply = await importXfdf(engine, handle, text);
      onChanged?.(reply.changed);
      onClose();
      store.push('info', t('commentsImport.done', { count: importedCount(reply.value) }));
    } catch (error) {
      if (error instanceof RpcError && error.code === 'REFUSED') {
        setPhase({ status: 'invalid' });
      } else {
        reportActionError(store, error, 'commentsImport.failed');
        setPhase({ status: 'pick' });
      }
    }
  };

  if (phase.status === 'reading') {
    return <p role="status">{t('commentsImport.reading')}</p>;
  }
  if (phase.status === 'importing') {
    return <p role="status">{t('commentsImport.importing')}</p>;
  }
  if (phase.status === 'preview') {
    return (
      <div className="redact-confirm">
        <p role="status">
          {t('commentsImport.preview', {
            count: phase.counts.comments,
            replies: phase.counts.replies,
            pages: phase.counts.pages.length,
          })}
        </p>
        <div className="redact-actions">
          <button type="button" onClick={() => void importComments(phase.text)}>
            {t('commentsImport.import')}
          </button>
          <button type="button" autoFocus onClick={onClose}>
            {t('commentsImport.cancel')}
          </button>
        </div>
      </div>
    );
  }

  // The message for the outcomes that offer no import, then the picker again.
  const message =
    phase.status === 'empty'
      ? t('commentsImport.empty')
      : phase.status === 'invalid'
        ? t('commentsImport.invalid')
        : phase.status === 'tooLarge'
          ? t('commentsImport.tooLarge', { limit: MAX_XFDF_BYTES / (1024 * 1024) })
          : null;

  return (
    <div className="redact-confirm">
      {message !== null ? <p role="alert">{message}</p> : null}
      <p>{t('commentsImport.choose')}</p>
      <div className="redact-actions">
        <button type="button" onClick={() => inputRef.current?.click()}>
          {t('commentsImport.choose.button')}
        </button>
        <button type="button" onClick={onClose}>
          {t('commentsImport.cancel')}
        </button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        hidden
        aria-label={t('commentsImport.choose.button')}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file !== undefined) void choose(file);
        }}
      />
    </div>
  );
}
