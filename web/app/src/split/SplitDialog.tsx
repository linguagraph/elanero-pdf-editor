// The split dialog (W6.2, W1.5 section 10): four modes, each with its own input, then Split. The
// split runs through the job protocol (splitJob.ts); its files are offered as downloads. A split
// into several files is offered as separate downloads: a ZIP is not built yet.
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Label, Radio, RadioGroup } from 'react-aria-components';
import { t } from '../i18n/t';
import type { MessageId } from '../i18n/en';
import { Overlay } from '../layout/Overlay';
import type { JobProgressStore } from '../feedback/jobRun';
import { downloadLinks, revokeLinks } from '../files/downloads';
import { parseMegabytes, parsePagesPerFile, parseRanges, rangeErrorMessage } from './ranges';
import {
  runSplit,
  SplitCancelled,
  type JobWorker,
  type SplitChoice,
  type SplitEngine,
  type SplitFile,
} from './splitJob';
import './split.css';

export type SplitMode = 'pages' | 'ranges' | 'bookmarks' | 'size';

const MODE_LABELS: Readonly<Record<SplitMode, MessageId>> = {
  pages: 'split.mode.pages',
  ranges: 'split.mode.ranges',
  bookmarks: 'split.mode.bookmarks',
  size: 'split.mode.size',
};

export interface SplitDialogProps {
  isOpen: boolean;
  onClose: () => void;
  engine: SplitEngine;
  handle: string;
  pageCount: number;
  startWorker: () => JobWorker;
  progress?: JobProgressStore;
}

// The split dialog on the Overlay host. Its form is mounted only while the dialog is open, so each
// open starts from the defaults.
export function SplitDialog(props: SplitDialogProps) {
  return (
    <Overlay
      isOpen={props.isOpen}
      onClose={props.onClose}
      title={t('split.title')}
      showCloseButton={false}
    >
      <SplitForm {...props} />
    </Overlay>
  );
}

// Builds the job's choice from the form, or the message to show when a value is refused. Nothing
// starts until this returns a choice.
function choiceFrom(
  mode: SplitMode,
  values: { pages: string; ranges: string; size: string },
  pageCount: number,
): { ok: true; choice: SplitChoice } | { ok: false; message: string } {
  switch (mode) {
    case 'pages': {
      const pagesPerFile = parsePagesPerFile(values.pages, pageCount);
      if (pagesPerFile === null) {
        return { ok: false, message: t('split.error.pagesPerFile', { count: pageCount }) };
      }
      return { ok: true, choice: { mode, pagesPerFile } };
    }
    case 'ranges': {
      const parsed = parseRanges(values.ranges, pageCount);
      if (!parsed.ok) return { ok: false, message: rangeErrorMessage(parsed.error) };
      return { ok: true, choice: { mode, parts: parsed.parts } };
    }
    case 'bookmarks':
      return { ok: true, choice: { mode } };
    case 'size': {
      const maxBytes = parseMegabytes(values.size);
      if (maxBytes === null) return { ok: false, message: t('split.error.size') };
      return { ok: true, choice: { mode, maxBytes } };
    }
  }
}

function SplitForm({
  onClose,
  engine,
  handle,
  pageCount,
  startWorker,
  progress,
}: SplitDialogProps) {
  const ids = useId();
  const [mode, setMode] = useState<SplitMode>('pages');
  const [pages, setPages] = useState('1');
  const [ranges, setRanges] = useState('');
  const [size, setSize] = useState('10');
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [files, setFiles] = useState<readonly SplitFile[] | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // One object URL per result file, freed when the result changes or the form closes.
  const links = useMemo(() => downloadLinks(files ?? []), [files]);
  useEffect(() => {
    return () => revokeLinks(links);
  }, [links]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (running) return;
    const checked = choiceFrom(mode, { pages, ranges, size }, pageCount);
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    setError(null);
    setFiles(null);
    setRunning(true);
    runSplit({ engine, startWorker, progress }, handle, checked.choice).then(
      (result) => {
        if (!mounted.current) return;
        setRunning(false);
        setFiles(result);
      },
      (failure: unknown) => {
        if (!mounted.current) return;
        setRunning(false);
        // A cancel is the user's own choice. A failure the job bar already reported as a toast
        // is not repeated here; this line says the split did not finish.
        if (!(failure instanceof SplitCancelled)) setError(t('split.failed'));
      },
    );
  };

  return (
    <form className="split" onSubmit={submit} noValidate>
      <RadioGroup
        className="split-modes"
        value={mode}
        onChange={(value) => {
          setMode(value as SplitMode);
          setError(null);
        }}
        isDisabled={running}
      >
        <Label className="split-label">{t('split.mode.label')}</Label>
        {(Object.keys(MODE_LABELS) as SplitMode[]).map((id) => (
          <Radio key={id} value={id} className="split-mode">
            {t(MODE_LABELS[id])}
          </Radio>
        ))}
      </RadioGroup>

      {mode === 'pages' ? (
        <label className="split-field" htmlFor={`${ids}-pages`}>
          <span className="split-label">{t('split.pagesPerFile.label')}</span>
          <input
            id={`${ids}-pages`}
            className="split-input"
            type="number"
            inputMode="numeric"
            min={1}
            max={pageCount}
            value={pages}
            onChange={(event) => setPages(event.target.value)}
            disabled={running}
          />
        </label>
      ) : null}

      {mode === 'ranges' ? (
        <label className="split-field" htmlFor={`${ids}-ranges`}>
          <span className="split-label">{t('split.ranges.label')}</span>
          <input
            id={`${ids}-ranges`}
            className="split-input"
            type="text"
            value={ranges}
            placeholder={t('split.ranges.placeholder')}
            aria-describedby={`${ids}-ranges-hint`}
            onChange={(event) => setRanges(event.target.value)}
            disabled={running}
          />
          <span id={`${ids}-ranges-hint`} className="split-hint">
            {t('split.ranges.hint')}
          </span>
        </label>
      ) : null}

      {mode === 'bookmarks' ? <p className="split-hint">{t('split.bookmarks.hint')}</p> : null}

      {mode === 'size' ? (
        <label className="split-field" htmlFor={`${ids}-size`}>
          <span className="split-label">{t('split.size.label')}</span>
          <input
            id={`${ids}-size`}
            className="split-input"
            type="text"
            inputMode="decimal"
            value={size}
            onChange={(event) => setSize(event.target.value)}
            disabled={running}
          />
          <span className="split-hint">{t('split.size.hint')}</span>
        </label>
      ) : null}

      {error !== null ? (
        <p className="split-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="split-actions">
        <button type="submit" className="split-submit" disabled={running}>
          {t('split.submit')}
        </button>
        <button type="button" onClick={onClose}>
          {t('split.close')}
        </button>
      </div>

      {running ? <p className="split-status">{t('split.running')}</p> : null}

      {files !== null ? (
        <section className="split-results" aria-labelledby={`${ids}-results`}>
          <h3 id={`${ids}-results`} className="split-heading">
            {t('split.results.heading', { count: files.length })}
          </h3>
          <ul className="split-files">
            {links.map((link) => (
              <li key={link.href}>
                <a href={link.href} download={link.name} className="split-download">
                  {t('split.download', { name: link.name })}
                </a>
              </li>
            ))}
          </ul>
          <p className="split-hint">{t('split.zipPending')}</p>
        </section>
      ) : null}
    </form>
  );
}
