// The export dialog (W7.7, W1.5 section 10, W1.4 section 11): a format, the pages and, for images,
// the resolution, then Export. The export runs through the job flow (exportJob.ts), so the job bar
// shows its progress and Cancel. Its files are offered as downloads; several pages come back as one
// ZIP, since the engine channel carries one file per reply.
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Label, Radio, RadioGroup } from 'react-aria-components';
import { downloadLinks, type ResultFile, revokeLinks } from '../files/downloads';
import { FileJobCancelled, type FileJobEngine, type JobWorker } from '../files/fileJob';
import type { JobProgressStore } from '../feedback/jobRun';
import type { MessageId } from '../i18n/en';
import { t } from '../i18n/t';
import { Overlay } from '../layout/Overlay';
import {
  checkExport,
  EXPORT_DPI,
  EXPORT_FORMATS,
  type ExportFormat,
  type ExportValues,
  IMAGE_FORMATS,
  type PageMode,
} from './exportChoice';
import { runExport } from './exportJob';
import './export.css';

export interface ExportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  engine: FileJobEngine;
  handle: string;
  pageCount: number;
  // The page the viewer shows, 1-based: the "current page" choice exports it.
  currentPage: number;
  startWorker: () => JobWorker;
  progress?: JobProgressStore;
}

const FORMAT_LABELS: Readonly<Record<ExportFormat, MessageId>> = {
  txt: 'export.format.txt',
  md: 'export.format.md',
  html: 'export.format.html',
  docx: 'export.format.docx',
  png: 'export.format.png',
  jpeg: 'export.format.jpeg',
  tiff: 'export.format.tiff',
};

const PAGE_LABELS: Readonly<Record<PageMode, MessageId>> = {
  all: 'export.pages.all',
  current: 'export.pages.current',
  range: 'export.pages.range',
};

// The export dialog on the Overlay host. Its form is mounted only while the dialog is open, so each
// open starts from the defaults.
export function ExportDialog(props: ExportDialogProps) {
  return (
    <Overlay
      isOpen={props.isOpen}
      onClose={props.onClose}
      title={t('export.title')}
      showCloseButton={false}
    >
      <ExportForm {...props} />
    </Overlay>
  );
}

function ExportForm({
  onClose,
  engine,
  handle,
  pageCount,
  currentPage,
  startWorker,
  progress,
}: ExportDialogProps) {
  const ids = useId();
  const [format, setFormat] = useState<ExportFormat>('txt');
  const [pageMode, setPageMode] = useState<PageMode>('all');
  const [range, setRange] = useState('');
  const [dpi, setDpi] = useState(150);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [files, setFiles] = useState<readonly ResultFile[] | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const links = useMemo(() => downloadLinks(files ?? []), [files]);
  useEffect(() => {
    return () => revokeLinks(links);
  }, [links]);

  const isImage = IMAGE_FORMATS.includes(format);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (running) return;
    const values: ExportValues = { format, pageMode, range, dpi };
    const checked = checkExport(values, pageCount, currentPage);
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    setError(null);
    setFiles(null);
    setRunning(true);
    runExport({ engine, startWorker, progress }, handle, checked.choice).then(
      (result) => {
        if (!mounted.current) return;
        setRunning(false);
        setFiles(result);
      },
      (failure: unknown) => {
        if (!mounted.current) return;
        setRunning(false);
        // A cancel is the user's own choice. A failure the job bar already reported as a toast is
        // not repeated here; this line says the export did not finish.
        if (!(failure instanceof FileJobCancelled)) setError(t('export.failed'));
      },
    );
  };

  return (
    <form className="export" onSubmit={submit} noValidate>
      <RadioGroup
        className="export-group"
        value={format}
        onChange={(value) => {
          setFormat(value as ExportFormat);
          setError(null);
        }}
        isDisabled={running}
      >
        <Label className="export-label">{t('export.format.label')}</Label>
        {EXPORT_FORMATS.map((id) => (
          <Radio key={id} value={id} className="export-option">
            {t(FORMAT_LABELS[id])}
          </Radio>
        ))}
      </RadioGroup>

      <RadioGroup
        className="export-group"
        value={pageMode}
        onChange={(value) => {
          setPageMode(value as PageMode);
          setError(null);
        }}
        isDisabled={running}
      >
        <Label className="export-label">{t('export.pages.label')}</Label>
        {(Object.keys(PAGE_LABELS) as PageMode[]).map((id) => (
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

      {isImage ? (
        <RadioGroup
          className="export-group"
          value={String(dpi)}
          onChange={(value) => setDpi(Number(value))}
          isDisabled={running}
        >
          <Label className="export-label">{t('export.dpi.label')}</Label>
          {EXPORT_DPI.map((option) => (
            <Radio key={option} value={String(option)} className="export-option">
              {t('export.dpi.option', { dpi: option })}
            </Radio>
          ))}
        </RadioGroup>
      ) : null}

      {isImage ? <p className="export-hint">{t('export.images.hint')}</p> : null}

      {error !== null ? (
        <p className="export-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="export-actions">
        <button type="submit" className="export-submit" disabled={running}>
          {t('export.submit')}
        </button>
        <button type="button" onClick={onClose}>
          {t('export.close')}
        </button>
      </div>

      {running ? <p className="export-status">{t('export.running')}</p> : null}

      {files !== null ? (
        <section className="export-results" aria-labelledby={`${ids}-results`}>
          <h3 id={`${ids}-results`} className="export-heading">
            {t('export.results.heading', { count: files.length })}
          </h3>
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
