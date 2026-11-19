// The Export Comments dialog (W7.2 A5, W1.5 section 10). It offers the three comment exports: the
// XFDF (the default), the CSV summary and the PDF summary. Export closes the dialog and runs the
// comments_export job, so the job bar shows its progress and Cancel. The finished file is handed to
// the browser as a download. A cancel ends silently. The PDF summary needs the HTML layout engine;
// where it is missing the job says NOT_SUPPORTED, and the dialog says so in a toast.
import { useState, type FormEvent } from 'react';
import { Label, Radio, RadioGroup } from 'react-aria-components';
import { reportActionError } from '../actionJob/errors';
import type { JobProgressStore } from '../feedback/jobRun';
import { toasts, type ToastStore } from '../feedback/toasts';
import { downloadBytes, downloadName } from '../files/downloads';
import {
  FileJobCancelled,
  type FileJobDeps,
  type FileJobEngine,
  type JobWorker,
} from '../files/fileJob';
import type { MessageId } from '../i18n/en';
import { t } from '../i18n/t';
import { Overlay } from '../layout/Overlay';
import { RpcError } from '../rpc/client';
import '../export/export.css';
import {
  COMMENTS_EXPORT_FORMATS,
  type CommentsExportFormat,
  commentsExportFileName,
  runCommentsExport,
} from './commentsExport';

export interface CommentsExportDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly engine: FileJobEngine;
  readonly handle: string;
  // The document's display name: the XFDF's file link and the stem of the file names.
  readonly name: string;
  readonly startWorker: () => JobWorker;
  readonly progress?: JobProgressStore;
  readonly store?: ToastStore;
  // Hands a finished file to the browser. Tests replace it.
  readonly download?: (name: string, bytes: ArrayBuffer, type: string) => void;
}

const FORMAT_LABELS: Readonly<Record<CommentsExportFormat, MessageId>> = {
  xfdf: 'commentsExport.format.xfdf',
  csv: 'commentsExport.format.csv',
  pdf: 'commentsExport.format.pdf',
};

const FORMAT_HINTS: Readonly<Record<CommentsExportFormat, MessageId>> = {
  xfdf: 'commentsExport.format.xfdf.hint',
  csv: 'commentsExport.format.csv.hint',
  pdf: 'commentsExport.format.pdf.hint',
};

// The dialog on the Overlay host. The form is mounted only while the dialog is open, so each open
// starts from the XFDF default.
export function CommentsExportDialog(props: CommentsExportDialogProps) {
  return (
    <Overlay
      isOpen={props.isOpen}
      onClose={props.onClose}
      title={t('commentsExport.title')}
      showCloseButton={false}
    >
      <CommentsExportForm {...props} />
    </Overlay>
  );
}

function CommentsExportForm({
  onClose,
  engine,
  handle,
  name,
  startWorker,
  progress,
  store = toasts,
  download = downloadBytes,
}: CommentsExportDialogProps) {
  const [format, setFormat] = useState<CommentsExportFormat>('xfdf');

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const deps: FileJobDeps = { engine, startWorker, progress };
    // The dialog closes at once; the job bar carries the progress and the Cancel from here on.
    onClose();
    runCommentsExport(deps, handle, format, name).then(
      (files) => {
        for (const file of files) download(downloadName(file), file.data, file.mime);
        store.push('info', t('commentsExport.done'));
      },
      (failure: unknown) => {
        // The user's own Cancel shows nothing and changes nothing.
        if (failure instanceof FileJobCancelled) return;
        if (format === 'pdf' && failure instanceof RpcError && failure.code === 'NOT_SUPPORTED') {
          store.push('error', t('commentsExport.pdfUnavailable'));
          return;
        }
        reportActionError(store, failure, 'commentsExport.failed');
      },
    );
  };

  return (
    <form className="export" onSubmit={submit} noValidate>
      <RadioGroup
        className="export-group"
        value={format}
        onChange={(value) => setFormat(value as CommentsExportFormat)}
      >
        <Label className="export-label">{t('commentsExport.format.label')}</Label>
        {COMMENTS_EXPORT_FORMATS.map((id) => (
          <Radio key={id} value={id} className="export-option">
            <span>
              {t(FORMAT_LABELS[id])}
              <span className="export-hint"> {t(FORMAT_HINTS[id])}</span>
            </span>
          </Radio>
        ))}
      </RadioGroup>

      <p className="export-status" role="status">
        {t('commentsExport.fileName', { file: commentsExportFileName(format, name) })}
      </p>

      <div className="export-actions">
        <button type="submit" className="export-submit">
          {t('commentsExport.export')}
        </button>
        <button type="button" onClick={onClose}>
          {t('commentsExport.cancel')}
        </button>
      </div>
    </form>
  );
}
