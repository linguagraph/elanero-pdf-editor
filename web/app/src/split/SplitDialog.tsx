// The split dialog (W6.2, W1.5 section 10): four modes, each with its own input, a preview of the
// files the split makes, then Split. The split runs through the job protocol (splitJob.ts); its
// files are offered as downloads, as separate files or as one ZIP.
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Label, Radio, RadioGroup } from 'react-aria-components';
import { t, tp } from '../i18n/t';
import type { MessageId } from '../i18n/en';
import { Overlay } from '../layout/Overlay';
import type { JobProgressStore } from '../feedback/jobRun';
import { downloadLinks, revokeLinks } from '../files/downloads';
import { RpcError } from '../rpc/client';
import { parseMegabytes, parsePagesPerFile, parseRanges, rangeErrorMessage } from './ranges';
import {
  planSplit,
  runSplit,
  SplitCancelled,
  type JobWorker,
  type SplitChoice,
  type SplitEngine,
  type SplitFile,
  type SplitPart,
} from './splitJob';
import './split.css';

export type SplitMode = 'pages' | 'ranges' | 'bookmarks' | 'size';

type OutputKind = 'files' | 'zip';

const MODE_LABELS: Readonly<Record<SplitMode, MessageId>> = {
  pages: 'split.mode.pages',
  ranges: 'split.mode.ranges',
  bookmarks: 'split.mode.bookmarks',
  size: 'split.mode.size',
};

// Above this many files the ZIP is the default: many separate downloads make the browser ask
// permission for each one (W6.2 section 6).
const ZIP_DEFAULT_ABOVE = 10;
// The preview lists at most this many files; the rest is a count.
const PREVIEW_ROWS = 100;
// The dialog waits this long after the last change before it asks for the preview.
const PREVIEW_DELAY_MS = 200;
// The job's output cap, limits.MAX_SPLIT_BYTES in webapi/limits.py, as the message shows it.
const OUTPUT_LIMIT_LABEL = '512 MB';

export interface SplitDialogProps {
  isOpen: boolean;
  onClose: () => void;
  engine: SplitEngine;
  handle: string;
  pageCount: number;
  // The document's display name: the stem of the part file names.
  name: string;
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
  name,
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
  // The output the user picked; null until they pick one, when it follows the preview's count.
  const [picked, setPicked] = useState<OutputKind | null>(null);
  // The last preview and the choice it was made for. It counts only while the choice is unchanged.
  const [preview, setPreview] = useState<{
    choice: SplitChoice;
    parts: readonly SplitPart[];
  } | null>(null);
  const previewSeq = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The valid choice for the current inputs, or null. Its identity changes only with the inputs,
  // so the preview effect below runs only when they change.
  const choice = useMemo<SplitChoice | null>(() => {
    const checked = choiceFrom(mode, { pages, ranges, size }, pageCount);
    return checked.ok ? checked.choice : null;
  }, [mode, pages, ranges, size, pageCount]);

  // The preview: the files the split would make. A reply for an older choice is dropped, and a
  // failed call hides the preview; it never blocks Split. Nothing is asked while a split runs.
  useEffect(() => {
    const seq = ++previewSeq.current;
    if (choice === null || choice.mode === 'size' || running) return;
    const timer = window.setTimeout(() => {
      planSplit(engine, handle, choice, name).then(
        (result) => {
          if (seq === previewSeq.current) setPreview({ choice, parts: result });
        },
        () => {
          if (seq === previewSeq.current) setPreview(null);
        },
      );
    }, PREVIEW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [choice, engine, handle, name, running]);

  const parts = preview !== null && preview.choice === choice && !running ? preview.parts : null;

  const output: OutputKind = picked ?? ((parts?.length ?? 0) > ZIP_DEFAULT_ABOVE ? 'zip' : 'files');

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
    runSplit({ engine, startWorker, progress }, handle, checked.choice, {
      name,
      zip: output === 'zip',
    }).then(
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
        if (failure instanceof SplitCancelled) return;
        const tooLarge = failure instanceof RpcError && failure.code === 'FILE_TOO_LARGE';
        setError(
          tooLarge ? t('split.error.tooLarge', { size: OUTPUT_LIMIT_LABEL }) : t('split.failed'),
        );
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

      {mode === 'size' ? <p className="split-hint">{t('split.preview.size')}</p> : null}

      {mode !== 'size' && parts !== null && parts.length > 0 ? (
        <section className="split-preview" aria-labelledby={`${ids}-preview`}>
          <p id={`${ids}-preview`} className="split-preview-summary" aria-live="polite">
            {tp('split.preview.heading', parts.length)}
          </p>
          <ul className="split-preview-list">
            {parts.slice(0, PREVIEW_ROWS).map((part) => (
              <li key={part.name}>
                {tp('split.preview.part', part.page_count, {
                  name: part.name,
                  first: part.first_page + 1,
                })}
              </li>
            ))}
          </ul>
          {parts.length > PREVIEW_ROWS ? (
            <p className="split-hint">
              {t('split.preview.more', { count: parts.length - PREVIEW_ROWS })}
            </p>
          ) : null}
        </section>
      ) : null}

      <RadioGroup
        className="split-modes"
        value={output}
        onChange={(value) => setPicked(value as OutputKind)}
        isDisabled={running}
      >
        <Label className="split-label">{t('split.output.label')}</Label>
        <Radio value="files" className="split-mode">
          {t('split.output.files')}
        </Radio>
        <Radio value="zip" className="split-mode">
          {t('split.output.zip')}
        </Radio>
      </RadioGroup>

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
        </section>
      ) : null}
    </form>
  );
}
