// The Replace pages dialog (Organize, issue 772 slice R2). The ribbon's Replace opens it from the
// panel; its own Choose file button gives the file chooser the press it needs. pages.replace swaps
// the selected pages in one undo step, and a refusal stays in the dialog so the range can be fixed.
import { useRef, useState, type FormEvent } from 'react';
import { PROBE_MAX_BYTES } from '../combine/probe';
import { passwordPrompt, type PasswordPrompt } from '../documents/passwordRequest';
import { PasswordGaveUp, withPassword } from '../documents/withPassword';
import type { PageRpc } from '../engine/engineConnection';
import { t, tp } from '../i18n/t';
import { Overlay } from '../layout/Overlay';
import { RpcError } from '../rpc/client';
import { mapRpcError } from '../rpc/errors';
import { defaultRange, describePages, sourceRange } from './replaceRange';
import './replacePages.css';

export interface ReplacePagesDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly picked: readonly number[];
  readonly total: number;
  readonly onReplaced: (count: number, history: number) => void;
  readonly prompt?: PasswordPrompt;
}

export function ReplacePagesDialog(props: ReplacePagesDialogProps) {
  // Lifted out of the form so Escape and an outside click can be refused while a replace runs.
  const [running, setRunning] = useState(false);
  return (
    <Overlay
      isOpen={props.isOpen}
      onClose={() => {
        if (!running) props.onClose();
      }}
      title={t('replace.title')}
      showCloseButton={false}
    >
      <ReplaceForm {...props} running={running} setRunning={setRunning} />
    </Overlay>
  );
}

function failureMessage(failure: unknown): string {
  if (failure instanceof PasswordGaveUp) return t('replace.passwordGaveUp');
  if (failure instanceof RpcError) {
    const presented = mapRpcError(failure);
    return t(presented.messageId, presented.params);
  }
  return t('replace.failed');
}

interface ReplaceFormProps extends ReplacePagesDialogProps {
  readonly running: boolean;
  readonly setRunning: (running: boolean) => void;
}

// Mounted only while open, so each open starts with no file and no password.
function ReplaceForm({
  rpc,
  handle,
  picked,
  total,
  onClose,
  onReplaced,
  prompt = passwordPrompt,
  running,
  setRunning,
}: ReplaceFormProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  // The page count, or null for a file too large to count here.
  const [pages, setPages] = useState<number | null>(null);
  // The password that opened the counted file. It stays until a replace succeeds or the dialog
  // closes, so a refused run does not ask for it again.
  const [password, setPassword] = useState<string | null>(null);
  const [range, setRange] = useState('');
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A file over the probe limit is not counted. A cancelled password or unreadable file clears it.
  const chooseFile = async (chosen: File) => {
    setError(null);
    setPages(null);
    setPassword(null);
    setFile(chosen);
    if (chosen.size > PROBE_MAX_BYTES) {
      setRange(defaultRange(null, picked.length));
      return;
    }
    setProbing(true);
    try {
      const won = await withPassword(
        chosen.name,
        async (pw) =>
          rpc.call('combine.probe', {
            name: chosen.name,
            data: await chosen.arrayBuffer(),
            password: pw,
          }),
        prompt,
      );
      if (won === null) {
        setFile(null);
        return;
      }
      setPages(won.value.page_count);
      setPassword(won.password);
      setRange(defaultRange(won.value.page_count, picked.length));
    } catch (failure) {
      setFile(null);
      setError(failureMessage(failure));
    } finally {
      setProbing(false);
    }
  };

  const check = file === null ? null : sourceRange(range, pages);
  const source = check !== null && 'pages' in check ? check.pages : null;
  const canRun = source !== null && !probing && !running;
  const problem = check !== null && 'message' in check ? t(check.message, check.params) : error;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canRun || file === null || source === null) return;
    setRunning(true);
    setError(null);
    withPassword(
      file.name,
      async (pw) =>
        rpc.call('actions.run', {
          handle,
          name: 'pages.replace',
          args: {
            pages: [...picked],
            data: await file.arrayBuffer(),
            source_pages: [...source],
            password: pw,
          },
        }),
      prompt,
      password,
    ).then(
      (won) => {
        if (won?.value.executed) {
          setPassword(null);
          setRunning(false);
          onReplaced(source.length, won.value.state.history);
          return;
        }
        // A refusal keeps the dialog and the password for the next try; a password typed into
        // the prompt during this run replaces it.
        if (won !== null) setPassword(won.password);
        setRunning(false);
      },
      (failure: unknown) => {
        setRunning(false);
        setError(failureMessage(failure));
      },
    );
  };

  return (
    <form className="replace-form" onSubmit={submit} noValidate>
      <p>{t('replace.description')}</p>
      <p>{t('replace.pagesLine', { pages: describePages(picked), total })}</p>
      <div className="replace-file">
        <button
          type="button"
          disabled={probing || running}
          onClick={() => fileInput.current?.click()}
        >
          {t('replace.chooseFile')}
        </button>
        <span aria-live="polite">
          {file === null
            ? t('replace.noFile')
            : `${file.name}${pages === null ? '' : `, ${tp('replace.count', pages)}`}`}
        </span>
      </div>
      {file !== null && pages === null && !probing ? <p>{t('replace.countUnknown')}</p> : null}
      <input
        ref={fileInput}
        type="file"
        accept=".pdf,application/pdf"
        hidden
        aria-label={t('replace.chooseFileLabel')}
        onChange={(event) => {
          const chosen = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (chosen !== undefined) void chooseFile(chosen);
        }}
      />
      <label className="replace-range">
        <span>{t('replace.sourcePages')}</span>
        <input
          type="text"
          autoComplete="off"
          value={range}
          disabled={file === null || running}
          onChange={(event) => setRange(event.target.value)}
        />
      </label>
      {problem !== null ? (
        <p role="alert" className="replace-error">
          {problem}
        </p>
      ) : null}
      {source !== null ? (
        <p role="status">
          {t('replace.summary', {
            target: tp('replace.count', picked.length),
            source: tp('replace.count', source.length),
          })}
        </p>
      ) : null}
      <div className="replace-actions">
        <button type="button" onClick={onClose} disabled={running}>
          {t('organizer.cancel')}
        </button>
        <button type="submit" disabled={!canRun}>
          {t('replace.submit')}
        </button>
      </div>
    </form>
  );
}
