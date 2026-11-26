// The Space Usage dialog (issue 737, Tools ribbon): the audit of the open document, run when the
// dialog opens. It shows the total and the space each part takes, largest first, with file overhead
// last, and the share in words. The audit runs through the job flow (spaceUsageJob.ts), so the job
// bar shows its progress; a failure is reported inside the dialog.
import { useEffect, useId, useRef, useState } from 'react';
import { CATEGORY_LABELS } from '../compress/SpaceAuditTable';
import { formatSize } from '../compress/formatSize';
import type { SpaceAudit } from '../compress/compressJob';
import '../compress/compress.css';
import { type JobProgressStore, jobProgress } from '../feedback/jobRun';
import { FileJobCancelled, type FileJobEngine, type JobWorker } from '../files/fileJob';
import { t } from '../i18n/t';
import { Overlay } from '../layout/Overlay';
import { SPACE_CATEGORY_KEYS, type SpaceCategoryKey } from '../rpc/generated';
import { runSpaceUsage } from './spaceUsageJob';

export interface SpaceUsageDialogProps {
  isOpen: boolean;
  onClose: () => void;
  engine: FileJobEngine;
  handle: string;
  startWorker: () => JobWorker;
  progress?: JobProgressStore;
}

interface SpaceRow {
  readonly key: SpaceCategoryKey;
  readonly size: number;
}

// The table's rows: each part summed by key, the parts above zero, the largest first (ties in
// SPACE_CATEGORY_KEYS order). File overhead is what the parts do not account for, so it is last.
function spaceRows(audit: SpaceAudit): SpaceRow[] {
  const sums = new Map<SpaceCategoryKey, number>();
  for (const { key, size } of audit.categories) {
    sums.set(key, (sums.get(key) ?? 0) + size);
  }
  const order = (key: SpaceCategoryKey) => SPACE_CATEGORY_KEYS.indexOf(key);
  return [...sums]
    .filter(([, size]) => size > 0)
    .map(([key, size]) => ({ key, size }))
    .sort((a, b) => {
      if (a.key === 'file_overhead' || b.key === 'file_overhead') {
        return Number(a.key === 'file_overhead') - Number(b.key === 'file_overhead');
      }
      return b.size - a.size || order(a.key) - order(b.key);
    });
}

// The share of the whole, in words. A part that is not a whole percent says so, rather than 0%.
function shareText(size: number, total: number): string {
  const percent = total > 0 ? (size / total) * 100 : 0;
  if (percent < 1) return t('spaceUsage.shareUnder');
  return t('spaceUsage.share', { percent: Math.round(percent) });
}

// The dialog on the Overlay host. Its form is mounted only while the dialog is open, so each open
// runs the audit again. While the audit runs, Escape and tap-outside do not close it; Cancel does.
export function SpaceUsageDialog(props: SpaceUsageDialogProps) {
  // Starts true: the audit starts in an effect, so the first paint must already withhold Close.
  const [running, setRunning] = useState(true);
  return (
    <Overlay
      isOpen={props.isOpen}
      onClose={() => {
        if (!running) props.onClose();
      }}
      title={t('spaceUsage.title')}
      showCloseButton={false}
    >
      <SpaceUsageForm {...props} running={running} setRunning={setRunning} />
    </Overlay>
  );
}

interface SpaceUsageFormProps extends SpaceUsageDialogProps {
  readonly running: boolean;
  readonly setRunning: (running: boolean) => void;
}

function SpaceUsageForm({
  onClose,
  engine,
  handle,
  startWorker,
  progress,
  running,
  setRunning,
}: SpaceUsageFormProps) {
  const ids = useId();
  const store = progress ?? jobProgress;
  const [audit, setAudit] = useState<SpaceAudit | null>(null);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(false);
  const started = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The audit starts once per open. The ref keeps a development double-mount from starting it twice.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    setRunning(true);
    runSpaceUsage({ engine, startWorker, progress: store }, handle).then(
      (result) => {
        if (!mounted.current) return;
        setRunning(false);
        setAudit(result);
      },
      (failure: unknown) => {
        if (!mounted.current) return;
        setRunning(false);
        // A cancel is the user's own choice, not an error to report.
        if (!(failure instanceof FileJobCancelled)) setFailed(true);
      },
    );
  }, [engine, handle, startWorker, store, setRunning]);

  const noteId = `${ids}-note`;
  return (
    <div className="space-usage">
      {running ? <p role="status">{t('spaceUsage.running')}</p> : null}
      {failed ? (
        <p className="compress-error" role="alert">
          {t('spaceUsage.failed')}
        </p>
      ) : null}
      {audit !== null ? (
        <>
          <p>{t('spaceUsage.total', { size: formatSize(audit.total) })}</p>
          {/* The wrapper scrolls the table for large text, and takes focus so a keyboard user can
              scroll it (axe scrollable-region-focusable). */}
          <div className="compress-audit" role="group" tabIndex={0}>
            <table className="compress-audit-table" aria-describedby={noteId}>
              <caption>{t('spaceUsage.table')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('spaceUsage.column.category')}</th>
                  <th scope="col">{t('spaceUsage.column.size')}</th>
                  <th scope="col">{t('spaceUsage.column.share')}</th>
                </tr>
              </thead>
              <tbody>
                {spaceRows(audit).map((row) => (
                  <tr key={row.key}>
                    <th scope="row">{t(CATEGORY_LABELS[row.key])}</th>
                    <td>{formatSize(row.size)}</td>
                    <td>{shareText(row.size, audit.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p id={noteId} className="compress-hint">
            {t('spaceUsage.note')}
          </p>
        </>
      ) : null}
      <div className="compress-actions">
        {running ? (
          <button type="button" onClick={() => void store.cancel()}>
            {t('spaceUsage.cancel')}
          </button>
        ) : (
          <button type="button" onClick={onClose}>
            {t('spaceUsage.close')}
          </button>
        )}
      </div>
    </div>
  );
}
