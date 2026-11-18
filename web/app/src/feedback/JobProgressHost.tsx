// Mounts the job progress bar from the app's job store (W4.4b). With no job running it renders
// nothing, so the bar stays hidden until a job flow begins one.
import { JobProgress } from './JobProgress';
import { jobProgress, type JobProgressStore, useJobProgress } from './jobRun';

export function JobProgressHost({ store = jobProgress }: { store?: JobProgressStore }) {
  const { job } = useJobProgress(store);
  if (job === undefined) return null;
  return (
    <JobProgress
      label={job.label}
      percent={job.percent}
      onCancel={() => {
        void store.cancel();
      }}
    />
  );
}
