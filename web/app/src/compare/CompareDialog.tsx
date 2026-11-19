// The compare dialog (A11, W7.8, W1.5 section 10): the open document is the older one, and the
// newer one is chosen from a file input. Compare runs the compare job (compareJob.ts); its report
// lists the changed pages, each linked to its page in the open view, and can be saved as a text
// file. Nothing in the open document changes.
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import { t } from '../i18n/t';
import { Overlay } from '../layout/Overlay';
import type { JobProgressStore } from '../feedback/jobRun';
import { downloadBytes } from '../files/downloads';
import { MAX_FILE_BYTES } from '../documents/openFile';
import type { JobWorker } from '../split/splitJob';
import { CompareCancelled, runCompare, type CompareEngine, type CompareReport } from './compareJob';
import { comparedPageCount, groupChanges, kindLabel, reportText } from './compareReport';
import './compare.css';

// Hands the saved report to the browser. The default is the app's download helper.
export type ReportDownload = (name: string, bytes: ArrayBuffer, type: string) => void;

export interface CompareDialogProps {
  isOpen: boolean;
  onClose: () => void;
  engine: CompareEngine;
  handle: string;
  // The open document's name: the older document in the report.
  currentName: string;
  startWorker: () => JobWorker;
  // Scrolls the open view to a page (0-based). The app passes the view's scroll handle.
  onGoToPage: (index: number) => void;
  progress?: JobProgressStore;
  download?: ReportDownload;
}

// The compare dialog on the Overlay host. Its form is mounted only while the dialog is open, so
// each open starts from the defaults.
export function CompareDialog(props: CompareDialogProps) {
  return (
    <Overlay
      isOpen={props.isOpen}
      onClose={props.onClose}
      title={t('compare.title')}
      showCloseButton={false}
    >
      <CompareForm {...props} />
    </Overlay>
  );
}

interface Finished {
  readonly report: CompareReport;
  readonly newer: string;
}

function CompareForm({
  onClose,
  engine,
  handle,
  currentName,
  startWorker,
  onGoToPage,
  progress,
  download = downloadBytes,
}: CompareDialogProps) {
  const ids = useId();
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [text, setText] = useState(true);
  const [visual, setVisual] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState<Finished | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const pages = useMemo(
    () => (finished === null ? [] : groupChanges(finished.report.changes)),
    [finished],
  );

  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0] ?? null;
    setFinished(null);
    setError(null);
    if (picked !== null && picked.size > MAX_FILE_BYTES) {
      setFile(null);
      setFileError(t('compare.error.tooLarge'));
      return;
    }
    setFileError(null);
    setFile(picked);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (running) return;
    if (file === null) {
      setError(t('compare.error.noFile'));
      return;
    }
    setError(null);
    setFinished(null);
    setRunning(true);
    const newer = file.name;
    file
      .arrayBuffer()
      .then((bytes) =>
        runCompare({ engine, startWorker, progress }, handle, bytes, { text, visual }),
      )
      .then(
        (report) => {
          if (!mounted.current) return;
          setRunning(false);
          setFinished({ report, newer });
        },
        (failure: unknown) => {
          if (!mounted.current) return;
          setRunning(false);
          // A cancel is the user's own choice. A failure the job bar already reported as a toast
          // is not repeated here; this line says the comparison did not finish.
          if (!(failure instanceof CompareCancelled)) setError(t('compare.failed'));
        },
      );
  };

  const save = () => {
    if (finished === null) return;
    const body = reportText(finished.report, currentName, finished.newer);
    download(t('compare.report.fileName'), new TextEncoder().encode(body).buffer, 'text/plain');
  };

  return (
    <form className="compare" onSubmit={submit} noValidate>
      <p className="compare-hint">{t('compare.current', { name: currentName })}</p>

      <label className="compare-field" htmlFor={`${ids}-newer`}>
        <span className="compare-label">{t('compare.newer.label')}</span>
        <input
          id={`${ids}-newer`}
          className="compare-input"
          type="file"
          accept="application/pdf,.pdf"
          onChange={choose}
          disabled={running}
        />
        <span className="compare-hint">{t('compare.newer.hint')}</span>
      </label>
      {fileError !== null ? (
        <p className="compare-error" role="alert">
          {fileError}
        </p>
      ) : null}

      <label className="compare-option">
        <input
          type="checkbox"
          checked={text}
          onChange={(event) => setText(event.target.checked)}
          disabled={running}
        />
        {t('compare.options.text')}
      </label>
      <label className="compare-option">
        <input
          type="checkbox"
          checked={visual}
          onChange={(event) => setVisual(event.target.checked)}
          disabled={running}
        />
        {t('compare.options.visual')}
      </label>

      {error !== null ? (
        <p className="compare-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="compare-actions">
        <button type="submit" className="compare-submit" disabled={running}>
          {t('compare.submit')}
        </button>
        <button type="button" onClick={onClose}>
          {t('compare.close')}
        </button>
      </div>

      {running ? <p className="compare-status">{t('compare.running')}</p> : null}

      {finished !== null ? (
        <section className="compare-report" aria-labelledby={`${ids}-report`}>
          <h3 id={`${ids}-report`} className="compare-heading">
            {t('compare.report.heading')}
          </h3>
          <p className="compare-hint">
            {t('compare.report.summary', {
              compared: comparedPageCount(finished.report),
              changed: pages.length,
            })}
          </p>
          {pages.length === 0 ? <p>{t('compare.report.identical')}</p> : null}
          <ul className="compare-pages">
            {pages.map((page) => (
              <li key={`${page.pageA ?? 'n'}-${page.pageB ?? 'o'}`} className="compare-page">
                {page.pageA !== null ? (
                  <button
                    type="button"
                    className="compare-page-link"
                    onClick={() => {
                      onGoToPage(page.pageA as number);
                      onClose();
                    }}
                  >
                    {t('compare.report.page', { page: (page.pageA as number) + 1 })}
                  </button>
                ) : (
                  <span className="compare-page-label">
                    {t('compare.report.pageNewOnly', { page: (page.pageB ?? 0) + 1 })}
                  </span>
                )}
                <ul className="compare-changes">
                  {page.changes.map((change, index) => (
                    <li key={index}>
                      <span className="compare-kind">{kindLabel(change.kind)}</span>
                      {change.summary !== '' ? `: ${change.summary}` : null}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <div className="compare-actions">
            <button type="button" onClick={save}>
              {t('compare.report.save')}
            </button>
          </div>
        </section>
      ) : null}
    </form>
  );
}
