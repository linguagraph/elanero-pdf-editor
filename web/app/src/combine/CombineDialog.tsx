// The combine dialog (W6.3, R6, W1.6 section 5): the sources in order, the output name, and the
// Combine button. The job runs on its own job worker through runCombine; the progress bar and
// Cancel are the app's job bar (JobProgressHost), and the result is offered as a download.
import { useRef, useState, type DragEvent } from 'react';
import { Button } from 'react-aria-components';
import { startJobWorker, type WorkerClient } from '../engine/start';
import { jobWorkerBootOptions } from '../engine/bootOptions';
import { t } from '../i18n/t';
import { jobProgress, type JobProgressStore } from '../feedback/jobRun';
import { Overlay } from '../layout/Overlay';
import { runCombine } from './run';
import {
  ACCEPT,
  addSources,
  DEFAULT_OUTPUT_NAME,
  moveSource,
  outputFileName,
  removeSource,
  type SourceItem,
} from './sources';
import './combine.css';

export interface CombineDialogProps {
  isOpen: boolean;
  onClose: () => void;
  // The app's job store. Tests pass their own.
  store?: JobProgressStore;
  // A new job worker per run. The default starts the built job worker.
  startWorker?: () => WorkerClient;
  // Offers the merged bytes as a file. The default makes a download link.
  download?: (name: string, bytes: ArrayBuffer) => void;
}

type Phase = 'editing' | 'working' | 'done';

interface Result {
  readonly name: string;
  readonly bytes: ArrayBuffer;
}

// Hands the bytes to the browser as a file. The object URL is released after the click has
// started the download.
export function downloadBytes(name: string, bytes: ArrayBuffer, type = 'application/pdf'): void {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function CombineDialog({
  isOpen,
  onClose,
  store = jobProgress,
  startWorker = () => startJobWorker(jobWorkerBootOptions()),
  download = downloadBytes,
}: CombineDialogProps) {
  const [items, setItems] = useState<readonly SourceItem[]>([]);
  const [outputName, setOutputName] = useState(DEFAULT_OUTPUT_NAME);
  const [message, setMessage] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('editing');
  const [result, setResult] = useState<Result | null>(null);
  const nextId = useRef(1);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = (files: readonly File[]): void => {
    if (files.length === 0) return;
    const added = addSources(items, files, nextId.current);
    nextId.current += files.length;
    setItems(added.items);
    setMessage(
      added.rejected.length > 0
        ? t('combine.unsupported', { name: added.rejected.join(', ') })
        : null,
    );
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    if (phase === 'working') return;
    addFiles(Array.from(event.dataTransfer.files));
  };

  const combine = async (): Promise<void> => {
    if (phase === 'working') return;
    setMessage(null);
    setPhase('working');
    const outcome = await runCombine(items, { store, startWorker });
    if (outcome.status === 'done') {
      setResult({ name: outcome.name, bytes: outcome.bytes });
      setPhase('done');
      return;
    }
    if (outcome.status === 'refused') setMessage(outcome.message);
    setPhase('editing');
  };

  // A job that is running keeps the dialog open: its result is shown here, so closing would lose it.
  const requestClose = (): void => {
    if (phase !== 'working') onClose();
  };

  return (
    <Overlay isOpen={isOpen} onClose={requestClose} title={t('combine.title')}>
      <div className="combine" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
        <p className="combine-hint">{t('combine.dropHint')}</p>
        <div>
          <Button
            className="combine-button"
            isDisabled={phase === 'working'}
            onPress={() => inputRef.current?.click()}
          >
            {t('combine.addFiles')}
          </Button>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          aria-label={t('combine.addFiles')}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = '';
            addFiles(files);
          }}
        />
        {items.length === 0 ? (
          <p className="combine-empty">{t('combine.empty')}</p>
        ) : (
          <ol className="combine-list">
            {items.map((item, index) => (
              <li key={item.id} className="combine-row">
                <span className="combine-name">{item.name}</span>
                <Button
                  className="combine-button"
                  isDisabled={index === 0 || phase === 'working'}
                  onPress={() => setItems(moveSource(items, index, -1))}
                >
                  {t('combine.moveUp')}
                </Button>
                <Button
                  className="combine-button"
                  isDisabled={index === items.length - 1 || phase === 'working'}
                  onPress={() => setItems(moveSource(items, index, 1))}
                >
                  {t('combine.moveDown')}
                </Button>
                <Button
                  className="combine-button"
                  isDisabled={phase === 'working'}
                  onPress={() => setItems(removeSource(items, index))}
                >
                  {t('combine.remove')}
                </Button>
              </li>
            ))}
          </ol>
        )}
        <label className="combine-output">
          <span>{t('combine.outputName')}</span>
          <input
            type="text"
            value={outputName}
            disabled={phase === 'working'}
            onChange={(event) => setOutputName(event.currentTarget.value)}
          />
        </label>
        {message === null ? null : (
          <p className="combine-message" role="alert">
            {message}
          </p>
        )}
        {phase === 'done' && result !== null ? (
          <div className="combine-done" role="status">
            <p>{t('combine.done')}</p>
            <Button
              className="combine-button"
              onPress={() => download(outputFileName(outputName), result.bytes)}
            >
              {t('combine.download', { name: outputFileName(outputName) })}
            </Button>
          </div>
        ) : null}
        <div className="combine-actions">
          <Button
            className="combine-button combine-primary"
            isDisabled={phase === 'working'}
            onPress={() => {
              void combine();
            }}
          >
            {t('combine.button')}
          </Button>
        </div>
      </div>
    </Overlay>
  );
}
