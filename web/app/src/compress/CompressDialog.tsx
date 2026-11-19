// The compress dialog (W6.4, R5, W1.5 section 10): a preset, then Compress. The compress runs
// through the job flow (compressJob.ts), so the job bar and the dialog's own progress show how far
// it has got. The result shows the two sizes and a download of the reduced copy; when the copy is
// not smaller, it says so and offers no download, only keeping the original.
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Label, Radio, RadioGroup } from 'react-aria-components';
import { downloadLinks, type ResultFile, revokeLinks } from '../files/downloads';
import { FileJobCancelled, type FileJobEngine, type JobWorker } from '../files/fileJob';
import { type JobProgressStore, jobProgress, useJobProgress } from '../feedback/jobRun';
import type { MessageId } from '../i18n/en';
import { t } from '../i18n/t';
import { Overlay } from '../layout/Overlay';
import {
  COMPRESS_PRESETS,
  type CompressPreset,
  isSmaller,
  runCompress,
  savedPercent,
} from './compressJob';
import './compress.css';

export interface CompressDialogProps {
  isOpen: boolean;
  onClose: () => void;
  engine: FileJobEngine;
  handle: string;
  startWorker: () => JobWorker;
  progress?: JobProgressStore;
}

const PRESET_LABELS: Readonly<Record<CompressPreset, MessageId>> = {
  screen: 'compress.preset.screen',
  ebook: 'compress.preset.ebook',
  print: 'compress.preset.print',
  lossless: 'compress.preset.lossless',
};

// What each preset does, in the words of the desktop's presets (services/optimize.py).
const PRESET_HINTS: Readonly<Record<CompressPreset, MessageId>> = {
  screen: 'compress.hint.screen',
  ebook: 'compress.hint.ebook',
  print: 'compress.hint.print',
  lossless: 'compress.hint.lossless',
};

// The outcome of a finished compress, as the dialog shows it.
interface Outcome {
  readonly before: number;
  readonly after: number;
  readonly file: ResultFile | undefined;
}

// A byte count for people: bytes below 1 KB, then KB, MB and GB to one decimal place.
export function formatSize(bytes: number): string {
  if (bytes < 1024) return t('compress.size.bytes', { count: bytes });
  const kb = bytes / 1024;
  if (kb < 1024) return t('compress.size.kb', { value: kb.toFixed(1) });
  const mb = kb / 1024;
  if (mb < 1024) return t('compress.size.mb', { value: mb.toFixed(1) });
  return t('compress.size.gb', { value: (mb / 1024).toFixed(1) });
}

// The compress dialog on the Overlay host. Its form is mounted only while the dialog is open, so
// each open starts from the defaults.
export function CompressDialog(props: CompressDialogProps) {
  // Lifted here so the Overlay's Escape or tap-outside can see whether a job is running.
  const [running, setRunning] = useState(false);
  return (
    <Overlay
      isOpen={props.isOpen}
      // A running compress is not closed unseen: Cancel is the way out while it runs.
      onClose={() => {
        if (!running) props.onClose();
      }}
      title={t('compress.title')}
      showCloseButton={false}
    >
      <CompressForm {...props} running={running} setRunning={setRunning} />
    </Overlay>
  );
}

interface CompressFormProps extends CompressDialogProps {
  readonly running: boolean;
  readonly setRunning: (running: boolean) => void;
}

function CompressForm({
  onClose,
  engine,
  handle,
  startWorker,
  progress,
  running,
  setRunning,
}: CompressFormProps) {
  const ids = useId();
  const store = progress ?? jobProgress;
  const runningJob = useJobProgress(store).job;
  const [preset, setPreset] = useState<CompressPreset>('ebook');
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Only a smaller copy is offered as a download; the links are freed with the result.
  const offered =
    outcome !== null && isSmaller(outcome.before, outcome.after) ? outcome.file : undefined;
  const links = useMemo(() => downloadLinks(offered !== undefined ? [offered] : []), [offered]);
  useEffect(() => {
    return () => revokeLinks(links);
  }, [links]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (running) return;
    setError(null);
    setOutcome(null);
    setRunning(true);
    runCompress({ engine, startWorker, progress: store }, handle, preset).then(
      (result) => {
        if (!mounted.current) return;
        setRunning(false);
        setOutcome({ before: result.before, after: result.after, file: result.file });
      },
      (failure: unknown) => {
        if (!mounted.current) return;
        setRunning(false);
        // A cancel is the user's own choice. A failure the job bar already reported as a toast is
        // not repeated here; this line says the compress did not finish.
        if (!(failure instanceof FileJobCancelled)) setError(t('compress.failed'));
      },
    );
  };

  const percent = runningJob?.percent;

  return (
    <form className="compress" onSubmit={submit} noValidate>
      <p className="compress-intro">{t('compress.intro')}</p>

      <RadioGroup
        className="compress-group"
        value={preset}
        onChange={(value) => setPreset(value as CompressPreset)}
        isDisabled={running}
      >
        <Label className="compress-label">{t('compress.preset.label')}</Label>
        {COMPRESS_PRESETS.map((id) => (
          <Radio key={id} value={id} className="compress-option">
            {t(PRESET_LABELS[id])}
          </Radio>
        ))}
      </RadioGroup>
      <p className="compress-hint">{t(PRESET_HINTS[preset])}</p>

      {error !== null ? (
        <p className="compress-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="compress-actions">
        <button type="submit" className="compress-submit" disabled={running}>
          {t('compress.submit')}
        </button>
        {running ? (
          <button type="button" onClick={() => void store.cancel()}>
            {t('compress.cancel')}
          </button>
        ) : (
          <button type="button" onClick={onClose}>
            {t('compress.close')}
          </button>
        )}
      </div>

      {running ? (
        <div className="compress-status">
          <p id={`${ids}-running`}>{t('compress.running')}</p>
          <progress
            className="compress-progress"
            max={100}
            value={percent}
            aria-labelledby={`${ids}-running`}
            aria-valuetext={
              percent === undefined
                ? t('compress.progress.unknown')
                : t('compress.progress.percent', { percent: Math.round(percent) })
            }
          />
          <span className="compress-hint" aria-hidden="true">
            {percent === undefined
              ? t('compress.progress.unknown')
              : t('compress.progress.percent', { percent: Math.round(percent) })}
          </span>
        </div>
      ) : null}

      {outcome !== null ? (
        <section className="compress-result" aria-labelledby={`${ids}-result`}>
          <h3 id={`${ids}-result`} className="compress-heading">
            {t('compress.result.heading')}
          </h3>
          {isSmaller(outcome.before, outcome.after) ? (
            <>
              <p role="status">
                {t('compress.result.sizes', {
                  before: formatSize(outcome.before),
                  after: formatSize(outcome.after),
                  percent: savedPercent(outcome.before, outcome.after),
                })}
              </p>
              <ul className="compress-files">
                {links.map((link) => (
                  <li key={link.href}>
                    <a href={link.href} download={link.name} className="compress-download">
                      {t('compress.download', { name: link.name })}
                    </a>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <p role="status">
                {t('compress.notSmaller', {
                  before: formatSize(outcome.before),
                  after: formatSize(outcome.after),
                })}
              </p>
              <button type="button" onClick={onClose}>
                {t('compress.keep')}
              </button>
            </>
          )}
        </section>
      ) : null}
    </form>
  );
}
