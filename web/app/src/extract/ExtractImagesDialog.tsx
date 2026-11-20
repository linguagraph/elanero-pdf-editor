// The Extract Images dialog (W4.15): the pages to look at, then Extract. The images are saved as
// they are stored (the desktop's Extract Images). The extraction runs through the job flow
// (extractJob.ts), so the job bar shows its progress and Cancel. Its files are offered as
// downloads; several images come back as one ZIP, since the engine channel carries one file per
// reply.
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Label, Radio, RadioGroup } from 'react-aria-components';
import { downloadLinks, type ResultFile, revokeLinks } from '../files/downloads';
import { FileJobCancelled, type FileJobEngine, type JobWorker } from '../files/fileJob';
import { jobProgress, type JobProgressStore } from '../feedback/jobRun';
import type { MessageId } from '../i18n/en';
import { t, tp } from '../i18n/t';
import { Overlay } from '../layout/Overlay';
import { RpcError } from '../rpc/client';
import { mapRpcError } from '../rpc/errors';
import { checkExtractPages, type ExtractImagesValue, type ExtractPageMode } from './extractChoice';
import { runExtractImages } from './extractJob';
import '../export/export.css';

export interface ExtractImagesDialogProps {
  isOpen: boolean;
  onClose: () => void;
  engine: FileJobEngine;
  handle: string;
  // The document's display name: the ZIP's stem.
  name: string;
  pageCount: number;
  // The page the viewer shows, 1-based: the "current page" choice takes its images.
  currentPage: number;
  startWorker: () => JobWorker;
  progress?: JobProgressStore;
}

const PAGE_LABELS: Readonly<Record<ExtractPageMode, MessageId>> = {
  all: 'export.pages.all',
  current: 'export.pages.current',
  range: 'export.pages.range',
};

interface Result {
  readonly files: readonly ResultFile[];
  readonly value: ExtractImagesValue;
}

// The line for a failed run. An engine refusal the catalogue names (BUSY: another task runs) shows
// its reason; any other failure keeps the generic text.
function failureText(failure: unknown): string {
  if (!(failure instanceof RpcError)) return t('extract.failed');
  const presented = mapRpcError(failure);
  return presented.messageId === 'error.UNKNOWN'
    ? t('extract.failed')
    : t(presented.messageId, presented.params);
}

// The dialog on the Overlay host. Its form is mounted only while the dialog is open, so each open
// starts from the defaults.
export function ExtractImagesDialog(props: ExtractImagesDialogProps) {
  return (
    <Overlay
      isOpen={props.isOpen}
      onClose={props.onClose}
      title={t('extract.images.title')}
      showCloseButton={false}
    >
      <ExtractImagesForm {...props} />
    </Overlay>
  );
}

function ExtractImagesForm({
  onClose,
  engine,
  handle,
  name,
  pageCount,
  currentPage,
  startWorker,
  progress,
}: ExtractImagesDialogProps) {
  const ids = useId();
  const [pageMode, setPageMode] = useState<ExtractPageMode>('all');
  const [range, setRange] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const mounted = useRef(true);
  const runningRef = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  // The form unmounts when the dialog closes (Escape, a tap outside or the parent). A run still
  // going is cancelled the way the job bar's Cancel cancels it, since its result has nowhere to go.
  useEffect(() => {
    return () => {
      if (runningRef.current) void (progress ?? jobProgress).cancel();
    };
  }, [progress]);

  const links = useMemo(() => downloadLinks(result?.files ?? []), [result]);
  useEffect(() => {
    return () => revokeLinks(links);
  }, [links]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (running) return;
    const checked = checkExtractPages(pageMode, range, pageCount, currentPage);
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    setError(null);
    setResult(null);
    setRunning(true);
    runExtractImages({ engine, startWorker, progress }, handle, checked.choice, name).then(
      (output) => {
        if (!mounted.current) return;
        setRunning(false);
        setResult(output);
      },
      (failure: unknown) => {
        if (!mounted.current) return;
        setRunning(false);
        // A cancel is the user's own choice. This line says the extraction did not finish, and why
        // when the catalogue names the reason; the job bar's toast may say it too.
        if (!(failure instanceof FileJobCancelled)) setError(failureText(failure));
      },
    );
  };

  return (
    <form className="export" onSubmit={submit} noValidate>
      <RadioGroup
        className="export-group"
        value={pageMode}
        onChange={(value) => {
          setPageMode(value as ExtractPageMode);
          setError(null);
        }}
        isDisabled={running}
      >
        <Label className="export-label">{t('export.pages.label')}</Label>
        {(Object.keys(PAGE_LABELS) as ExtractPageMode[]).map((id) => (
          <Radio key={id} value={id} className="export-option">
            {t(PAGE_LABELS[id])}
          </Radio>
        ))}
      </RadioGroup>

      {pageMode === 'range' ? (
        <label className="export-field" htmlFor={`${ids}-range`}>
          <span className="export-label">{t('export.range.label')}</span>
          <input
            id={`${ids}-range`}
            className="export-input"
            type="text"
            value={range}
            placeholder={t('export.range.placeholder')}
            aria-describedby={`${ids}-range-hint`}
            onChange={(event) => setRange(event.target.value)}
            disabled={running}
          />
          <span id={`${ids}-range-hint`} className="export-hint">
            {t('export.range.hint')}
          </span>
        </label>
      ) : null}

      <p className="export-hint">{t('extract.images.hint')}</p>

      {error !== null ? (
        <p className="export-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="export-actions">
        <button type="submit" className="export-submit" disabled={running}>
          {t('extract.submit')}
        </button>
        <button type="button" onClick={onClose} disabled={running}>
          {t('extract.close')}
        </button>
      </div>

      {running ? <p className="export-status">{t('extract.running')}</p> : null}

      {result !== null ? (
        <section className="export-results" aria-labelledby={`${ids}-results`}>
          <h3 id={`${ids}-results`} className="export-heading">
            {result.files.length === 0
              ? t('extract.images.none')
              : tp('extract.images.saved', result.value.count)}
          </h3>
          {result.value.tooLarge > 0 ? (
            <p className="export-hint">{tp('extract.images.tooLarge', result.value.tooLarge)}</p>
          ) : null}
          <ul className="export-files">
            {links.map((link) => (
              <li key={link.href}>
                <a href={link.href} download={link.name} className="export-download">
                  {t('export.download', { name: link.name })}
                </a>
              </li>
            ))}
          </ul>
          {links.some((link) => link.name.endsWith('.zip')) ? (
            <p className="export-hint">{t('export.archive.hint')}</p>
          ) : null}
        </section>
      ) : null}
    </form>
  );
}
