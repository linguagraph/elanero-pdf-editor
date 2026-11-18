// A running job's progress and its Cancel button (W1.6 section 10). It only displays: the caller
// owns the job and passes the label, the percentage and the cancel handler. A missing percentage
// means the length is unknown, so the bar is indeterminate.
import { t } from '../i18n/t';
import './feedback.css';

export interface JobProgressProps {
  // The job's name, already translated by the caller.
  label: string;
  // 0 to 100. Omit it when the job cannot say how far it has got.
  percent?: number;
  onCancel: () => void;
}

export function JobProgress({ label, percent, onCancel }: JobProgressProps) {
  const determinate = percent !== undefined && Number.isFinite(percent);
  const value = determinate ? Math.min(100, Math.max(0, Math.round(percent))) : undefined;
  return (
    <div className="job-progress">
      <span className="job-label">{label}</span>
      <progress className="job-bar" aria-label={label} value={value} max={100} />
      <span className="job-status">
        {value === undefined ? t('job.working') : t('job.percent', { percent: value })}
      </span>
      <button type="button" className="job-cancel" onClick={onCancel}>
        {t('job.cancel')}
      </button>
    </div>
  );
}
