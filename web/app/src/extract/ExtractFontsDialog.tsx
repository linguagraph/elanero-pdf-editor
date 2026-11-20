// The Extract Fonts dialog (W4.16): the fonts embedded in the document, saved as they are. A font
// whose licence forbids saving it is not saved, and the dialog names it. The extraction runs
// through the job flow (extractJob.ts), so the job bar shows its progress and Cancel. Its files are
// offered as downloads; several fonts come back as one ZIP, since the engine channel carries one
// file per reply.
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { downloadLinks, type ResultFile, revokeLinks } from '../files/downloads';
import { FileJobCancelled, type FileJobEngine, type JobWorker } from '../files/fileJob';
import type { JobProgressStore } from '../feedback/jobRun';
import { t, tp } from '../i18n/t';
import { Overlay } from '../layout/Overlay';
import { RpcError } from '../rpc/client';
import { mapRpcError } from '../rpc/errors';
import type { ExtractFontsValue } from './extractChoice';
import { runExtractFonts } from './extractJob';
import '../export/export.css';

export interface ExtractFontsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  engine: FileJobEngine;
  handle: string;
  // The document's display name: the ZIP's stem.
  name: string;
  startWorker: () => JobWorker;
  progress?: JobProgressStore;
}

// The names listed in a line: the first ten, then how many are left out.
const NAMES_SHOWN = 10;

function nameList(names: readonly string[]): string {
  const shown = names.slice(0, NAMES_SHOWN).join(', ');
  const more = names.length - NAMES_SHOWN;
  return more > 0 ? `${shown}, ${t('extract.fonts.more', { count: more })}` : shown;
}

interface Result {
  readonly files: readonly ResultFile[];
  readonly value: ExtractFontsValue;
}

// The line for a failed run. An engine refusal the catalogue names (BUSY: another task runs) shows
// its reason; any other failure keeps the generic text.
function failureText(failure: unknown): string {
  if (!(failure instanceof RpcError)) return t('extract.fonts.failed');
  const presented = mapRpcError(failure);
  return presented.messageId === 'error.UNKNOWN'
    ? t('extract.fonts.failed')
    : t(presented.messageId, presented.params);
}

// The dialog on the Overlay host. Its form is mounted only while the dialog is open, so each open
// starts afresh.
export function ExtractFontsDialog(props: ExtractFontsDialogProps) {
  return (
    <Overlay
      isOpen={props.isOpen}
      onClose={props.onClose}
      title={t('extract.fonts.title')}
      showCloseButton={false}
    >
      <ExtractFontsForm {...props} />
    </Overlay>
  );
}

function ExtractFontsForm({
  onClose,
  engine,
  handle,
  name,
  startWorker,
  progress,
}: ExtractFontsDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const mounted = useRef(true);
  // The abort token of this form's run. Aborting it stops the run whether its job is still being
  // prepared or already on the bar, and touches no other job.
  const runAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The form unmounts when the dialog closes. A run still going is cancelled, since its result has
  // nowhere to go; a finished run has no listener left.
  useEffect(() => {
    return () => runAbort.current?.abort();
  }, []);

  const links = useMemo(() => downloadLinks(result?.files ?? []), [result]);
  useEffect(() => {
    return () => revokeLinks(links);
  }, [links]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (running) return;
    setError(null);
    setResult(null);
    setRunning(true);
    const abort = new AbortController();
    runAbort.current = abort;
    const deps = { engine, startWorker, progress, signal: abort.signal };
    runExtractFonts(deps, handle, name).then(
      (output) => {
        if (!mounted.current) return;
        setRunning(false);
        setResult(output);
      },
      (failure: unknown) => {
        if (!mounted.current) return;
        setRunning(false);
        // A cancel is the user's own choice, so it shows nothing.
        if (!(failure instanceof FileJobCancelled)) setError(failureText(failure));
      },
    );
  };

  const value = result?.value;
  // The heading says how many were saved, or that the document has no embedded fonts. When every
  // font was refused, the refusal line below says so instead of a count of zero.
  const heading =
    value === undefined
      ? null
      : value.saved.length > 0
        ? tp('extract.fonts.saved', value.saved.length)
        : value.refused.length === 0
          ? t('extract.fonts.none')
          : null;

  return (
    <form className="export" onSubmit={submit} noValidate>
      <p className="export-hint">{t('extract.fonts.hint')}</p>

      {error !== null ? (
        <p className="export-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="export-actions">
        <button type="submit" className="export-submit" disabled={running}>
          {t('extract.submit')}
        </button>
        <button type="button" onClick={onClose} disabled={running}>
          {t('extract.close')}
        </button>
      </div>

      {running ? <p className="export-status">{t('extract.running')}</p> : null}

      {result !== null && value !== undefined ? (
        <section className="export-results" aria-label={t('extract.fonts.title')}>
          {heading !== null ? <h3 className="export-heading">{heading}</h3> : null}
          {value.refused.length > 0 ? (
            <p className="export-hint">
              {tp('extract.fonts.refused', value.refused.length, {
                names: nameList(value.refused.map((font) => font.name)),
              })}
            </p>
          ) : null}
          {value.notEmbedded.length > 0 ? (
            <p className="export-hint">
              {tp('extract.fonts.notEmbedded', value.notEmbedded.length, {
                names: nameList(value.notEmbedded),
              })}
            </p>
          ) : null}
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
