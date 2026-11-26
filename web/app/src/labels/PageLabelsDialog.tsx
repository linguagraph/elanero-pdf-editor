// The Page labels dialog (Organize, slice 1): one row per label range (from page, style, prefix,
// start at). It loads the document's rules on open, checks the rows (labelRules.ts) and runs
// `pages.set_labels`. A refusal shows inside the dialog, which stays open so the rows can be fixed.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { PageRpc } from '../engine/engineConnection';
import type { MessageId } from '../i18n/en';
import { t } from '../i18n/t';
import { Overlay } from '../layout/Overlay';
import { RpcError } from '../rpc/client';
import { mapRpcError } from '../rpc/errors';
import type { ChangedDto } from '../rpc/generated';
import {
  checkLabelRows,
  LABEL_STYLE_CODES,
  newLabelRow,
  rowsFromRules,
  type LabelRow,
  type LabelStyleCode,
} from './labelRules';
import './labels.css';

export interface PageLabelsDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly pageCount: number;
  // Redraws the pages, thumbnails and navigator the labels changed (the app remounts the view).
  readonly onChanged?: (changed: ChangedDto | null) => void;
}

const STYLE_LABELS: Readonly<Record<LabelStyleCode, MessageId>> = {
  D: 'labels.style.decimal',
  r: 'labels.style.romanLower',
  R: 'labels.style.romanUpper',
  a: 'labels.style.alphaLower',
  A: 'labels.style.alphaUpper',
  '': 'labels.style.none',
};

export function PageLabelsDialog(props: PageLabelsDialogProps) {
  return (
    <Overlay
      isOpen={props.isOpen}
      onClose={props.onClose}
      title={t('labels.title')}
      showCloseButton={false}
    >
      <LabelsForm {...props} />
    </Overlay>
  );
}

// Mounted only while the dialog is open, so each open loads the rules again.
function LabelsForm({ onClose, rpc, handle, pageCount, onChanged }: PageLabelsDialogProps) {
  const [rows, setRows] = useState<LabelRow[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // The row the user last worked in; Remove takes that one out.
  const [selected, setSelected] = useState<number | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    rpc.call('session.label_rules', { handle }).then(
      (reply) => {
        if (mounted.current) setRows(rowsFromRules(reply.rules));
      },
      () => {
        if (mounted.current) setLoadFailed(true);
      },
    );
    return () => {
      mounted.current = false;
    };
  }, [rpc, handle]);

  const edit = (index: number, patch: Partial<LabelRow>) => {
    setRows(
      (current) => current?.map((row, at) => (at === index ? { ...row, ...patch } : row)) ?? null,
    );
    setError(null);
  };

  const addRange = () => {
    setRows((current) => [...(current ?? []), newLabelRow()]);
    setError(null);
  };

  const removeSelected = () => {
    if (selected === null || rows === null) return;
    setRows(rows.filter((_, at) => at !== selected));
    setSelected(null);
    setError(null);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (running || rows === null) return;
    const checked = checkLabelRows(rows, pageCount);
    if (!checked.ok) {
      setError(
        checked.problem === 'fromPage'
          ? t('labels.problem.fromPage', { count: pageCount })
          : t('labels.problem.startAt'),
      );
      return;
    }
    setError(null);
    setRunning(true);
    rpc
      .call('actions.run', { handle, name: 'pages.set_labels', args: { rules: checked.rules } })
      .then(
        (reply) => {
          if (reply.executed) onChanged?.(reply.changed);
          if (mounted.current) onClose();
        },
        (failure: unknown) => {
          if (!mounted.current) return;
          setRunning(false);
          const presented = failure instanceof RpcError ? mapRpcError(failure) : null;
          setError(presented ? t(presented.messageId, presented.params) : t('labels.failed'));
        },
      );
  };

  // A text field of a row: the row becomes the selected one when the field takes focus.
  const field = (
    index: number,
    label: MessageId,
    value: string,
    key: 'from' | 'prefix' | 'first',
  ) => (
    <td>
      <input
        type="text"
        autoComplete="off"
        inputMode={key === 'prefix' ? undefined : 'numeric'}
        aria-label={t(label)}
        value={value}
        onFocus={() => setSelected(index)}
        onChange={(event) => edit(index, { [key]: event.target.value })}
      />
    </td>
  );

  return (
    <form className="labels-form" onSubmit={submit} noValidate>
      <p className="labels-description">{t('labels.description')}</p>
      {loadFailed ? (
        <p role="alert" className="labels-error">
          {t('labels.loadFailed')}
        </p>
      ) : null}
      {rows !== null ? (
        <table className="labels-table">
          <thead>
            <tr>
              <th scope="col">{t('labels.column.from')}</th>
              <th scope="col">{t('labels.column.style')}</th>
              <th scope="col">{t('labels.column.prefix')}</th>
              <th scope="col">{t('labels.column.first')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {field(index, 'labels.column.from', row.from, 'from')}
                <td>
                  <select
                    aria-label={t('labels.column.style')}
                    value={row.style}
                    onFocus={() => setSelected(index)}
                    onChange={(event) =>
                      edit(index, { style: event.target.value as LabelStyleCode })
                    }
                  >
                    {LABEL_STYLE_CODES.map((code) => (
                      <option key={code} value={code}>
                        {t(STYLE_LABELS[code])}
                      </option>
                    ))}
                  </select>
                </td>
                {field(index, 'labels.column.prefix', row.prefix, 'prefix')}
                {field(index, 'labels.column.first', row.first, 'first')}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <div className="labels-actions">
        <button type="button" onClick={addRange} disabled={running || rows === null}>
          {t('labels.add')}
        </button>
        <button
          type="button"
          onClick={removeSelected}
          disabled={running || rows === null || selected === null}
        >
          {t('labels.remove')}
        </button>
      </div>
      {error !== null ? (
        <p role="alert" className="labels-error">
          {error}
        </p>
      ) : null}
      <div className="labels-actions">
        <button type="submit" disabled={running || rows === null}>
          {t('labels.ok')}
        </button>
        <button type="button" onClick={onClose} disabled={running}>
          {t('labels.cancel')}
        </button>
      </div>
    </form>
  );
}
