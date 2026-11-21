// The combine dialog (W6.3, R6, W1.6 section 5): the sources in order, each PDF's Pages box, the
// output name, and the Combine button. The job runs on its own job worker through runCombine; the
// progress bar and Cancel are the app's job bar (JobProgressHost), and the result is offered as a
// download. A Pages box that does not fit is shown on its row, and focus moves to the first one.
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Button } from 'react-aria-components';
import { startJobWorker, type WorkerClient } from '../engine/start';
import { jobWorkerBootOptions } from '../engine/bootOptions';
import { t, tp } from '../i18n/t';
import { jobProgress, type JobProgressStore } from '../feedback/jobRun';
import { downloadBytes } from '../files/downloads';
import { Overlay } from '../layout/Overlay';
import { parsePageRanges, type PageRangeKind } from '../pages/pageRanges';
import { rangeProblems, runCombine, type RangeProblem } from './run';
import {
  ACCEPT,
  addSources,
  DEFAULT_OUTPUT_NAME,
  isImageSourceName,
  moveSource,
  outputFileName,
  removeSource,
  setSourcePages,
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

// What is wrong with one row's Pages box. Kept by the row's id, so a reorder keeps it.
interface RowError {
  readonly kind: PageRangeKind;
  readonly item: string;
  readonly count: number | null;
}

function rangeMessage(error: RowError, name: string): string {
  switch (error.kind) {
    case 'empty':
      return t('combine.error.ranges.empty');
    case 'invalid':
      return t('combine.error.ranges.invalid', { item: error.item });
    case 'out_of_range':
      return tp('combine.error.ranges.outOfRange', error.count ?? 0, {
        item: error.item,
        name,
      });
  }
}

// The errors of the given problems, keyed by the id of the row each one is on.
function errorsFor(
  items: readonly SourceItem[],
  problems: readonly RangeProblem[],
): ReadonlyMap<number, RowError> {
  const errors = new Map<number, RowError>();
  for (const problem of problems) {
    const id = items[problem.index]?.id;
    if (id !== undefined) {
      errors.set(id, { kind: problem.kind, item: problem.item, count: problem.count });
    }
  }
  return errors;
}

// The errors with one row's error set, or cleared when error is null. A new map: React state.
function withError(
  errors: ReadonlyMap<number, RowError>,
  id: number,
  error: RowError | null,
): ReadonlyMap<number, RowError> {
  const next = new Map(errors);
  if (error === null) next.delete(id);
  else next.set(id, error);
  return next;
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
  const [rowErrors, setRowErrors] = useState<ReadonlyMap<number, RowError>>(new Map());
  const nextId = useRef(1);
  const inputRef = useRef<HTMLInputElement>(null);
  const fieldRefs = useRef(new Map<number, HTMLInputElement>());
  const focusId = useRef<number | null>(null);

  // Focus moves after the render that enables the field: a disabled box cannot take it.
  useEffect(() => {
    if (focusId.current === null) return;
    fieldRefs.current.get(focusId.current)?.focus();
    focusId.current = null;
  });

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

  // Shows the problems on their rows, names the summary, and focuses the first bad box.
  const showProblems = (problems: readonly RangeProblem[]): void => {
    const errors = errorsFor(items, problems);
    setRowErrors(errors);
    setMessage(t('combine.error.ranges.summary'));
    const first = items.find((item) => errors.has(item.id));
    focusId.current = first?.id ?? null;
  };

  // The Pages box of one row is checked when it loses focus, not on every key (3-2 on the way
  // to 3-20 must not flash an error).
  const checkField = (id: number, text: string): void => {
    const checked = parsePageRanges(text, null);
    const error = checked.ok ? null : { ...checked.error, count: null };
    setRowErrors((errors) => withError(errors, id, error));
  };

  const combine = async (): Promise<void> => {
    if (phase === 'working') return;
    setMessage(null);
    const problems = rangeProblems(items);
    if (problems.length > 0) {
      showProblems(problems);
      return;
    }
    setPhase('working');
    const outcome = await runCombine(items, { store, startWorker });
    if (outcome.status === 'done') {
      setResult({ name: outcome.name, bytes: outcome.bytes });
      setPhase('done');
      return;
    }
    if (outcome.status === 'rangeError') showProblems([outcome.problem]);
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
        <p className="combine-hint">{t('combine.pages.hint')}</p>
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
            {items.map((item, index) => {
              const error = rowErrors.get(item.id);
              const errorId = `combine-pages-error-${item.id}`;
              return (
                <li
                  key={item.id}
                  className={error === undefined ? 'combine-row' : 'combine-row combine-row--error'}
                >
                  <span className="combine-name">{item.name}</span>
                  {isImageSourceName(item.name) ? (
                    <span className="combine-pages-image">{t('combine.image')}</span>
                  ) : (
                    <label className="combine-pages">
                      <span>{t('combine.pages.label')}</span>
                      <input
                        type="text"
                        value={item.pages}
                        maxLength={2000}
                        inputMode="text"
                        spellCheck={false}
                        placeholder={t('combine.pages.placeholder')}
                        aria-label={t('combine.pages.labelFor', { name: item.name })}
                        aria-invalid={error === undefined ? undefined : true}
                        aria-describedby={error === undefined ? undefined : errorId}
                        disabled={phase === 'working'}
                        ref={(element) => {
                          if (element) fieldRefs.current.set(item.id, element);
                          else fieldRefs.current.delete(item.id);
                        }}
                        onChange={(event) => {
                          setItems(setSourcePages(items, item.id, event.currentTarget.value));
                          if (error !== undefined) {
                            setRowErrors((errors) => withError(errors, item.id, null));
                          }
                        }}
                        onBlur={(event) => checkField(item.id, event.currentTarget.value)}
                      />
                    </label>
                  )}
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
                  {error === undefined ? null : (
                    <p id={errorId} className="combine-pages-error">
                      {rangeMessage(error, item.name)}
                    </p>
                  )}
                </li>
              );
            })}
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
