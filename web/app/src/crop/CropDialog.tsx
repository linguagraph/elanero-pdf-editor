// The crop dialog (W4.11 S3, W1.5 section 9): four margins, a unit, and the pages to crop. Crop
// reads the page sizes when the dialog opens, checks the form (cropChoice.ts), then runs
// `pages.crop_margins` through runCrop. A refusal shows its message inside the dialog, which stays
// open so the margins can be changed. A signed document is allowed, with a note.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { PageRpc } from '../engine/engineConnection';
import { type ToastStore } from '../feedback/toasts';
import type { MessageId } from '../i18n/en';
import { t } from '../i18n/t';
import { Overlay } from '../layout/Overlay';
import { RpcError } from '../rpc/client';
import { mapRpcError } from '../rpc/errors';
import type { ChangedDto, PageSize } from '../rpc/generated';
import {
  checkCrop,
  withDrawnBox,
  type CropScope,
  type CropUnit,
  type CropValues,
  type DrawnCrop,
} from './cropChoice';
import { runCrop } from './runCrop';
import './crop.css';

export interface CropDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly pageCount: number;
  // One-based, as the view reports it.
  readonly currentPage: number;
  readonly signed: boolean;
  // Redraws the pages a crop or its Undo changed.
  readonly onChanged?: (changed: ChangedDto | null) => void;
  readonly store?: ToastStore;
  // The form as the user left it, so a dialog reopened after a drawn box or Esc keeps its values.
  readonly initialValues?: CropValues;
  readonly onValuesChange?: (values: CropValues) => void;
  // A box drawn on a page (W4.11 S5): the form opens with its margins on that page.
  readonly drawn?: DrawnCrop | null;
  // Shows "Draw on page", which closes the dialog for the caller to start the crop box tool.
  readonly onDrawOnPage?: () => void;
}

const DEFAULT_VALUES: CropValues = {
  left: '0',
  top: '0',
  right: '0',
  bottom: '0',
  unit: 'pt',
  scope: 'all',
  range: '',
};

const UNITS: readonly CropUnit[] = ['pt', 'mm', 'in'];
const UNIT_LABELS: Readonly<Record<CropUnit, MessageId>> = {
  pt: 'crop.unit.pt',
  mm: 'crop.unit.mm',
  in: 'crop.unit.in',
};

export function CropDialog(props: CropDialogProps) {
  return (
    <Overlay
      isOpen={props.isOpen}
      onClose={props.onClose}
      title={t('crop.title')}
      showCloseButton={false}
    >
      <CropForm {...props} />
    </Overlay>
  );
}

// Mounted only while the dialog is open, so each open starts from the kept values (or the defaults)
// and reads the page sizes again (the document may have changed since the last one).
function CropForm({
  onClose,
  rpc,
  handle,
  pageCount,
  currentPage,
  signed,
  onChanged,
  store,
  initialValues,
  onValuesChange,
  drawn,
  onDrawOnPage,
}: CropDialogProps) {
  const ids = useId();
  const [values, setValues] = useState<CropValues>(() => {
    const kept = initialValues ?? DEFAULT_VALUES;
    return drawn ? withDrawnBox(kept, drawn) : kept;
  });
  const [sizes, setSizes] = useState<readonly PageSize[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let live = true;
    rpc.call('session.pages', { handle }).then(
      (reply) => {
        if (live) setSizes(reply.pages);
      },
      () => {
        if (live) setLoadFailed(true);
      },
    );
    return () => {
      live = false;
      mounted.current = false;
    };
  }, [rpc, handle]);

  const set = (patch: Partial<CropValues>) => {
    const next = { ...values, ...patch };
    setValues(next);
    setError(null);
    onValuesChange?.(next);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (running || sizes === null) return;
    const checked = checkCrop(values, sizes, currentPage);
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    setError(null);
    setRunning(true);
    runCrop({ rpc, handle, onChanged, store }, checked.args).then(
      () => {
        // Done, or nothing to do (no toast in that case): the dialog closes either way.
        if (mounted.current) onClose();
      },
      (failure: unknown) => {
        if (!mounted.current) return;
        setRunning(false);
        if (failure instanceof RpcError) {
          const presented = mapRpcError(failure);
          setError(t(presented.messageId, presented.params));
        } else {
          setError(t('crop.failed'));
        }
      },
    );
  };

  const marginField = (name: 'left' | 'top' | 'right' | 'bottom', label: MessageId) => (
    <label className="crop-field" htmlFor={`${ids}-${name}`}>
      <span>{t(label)}</span>
      <input
        id={`${ids}-${name}`}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={values[name]}
        onChange={(event) => set({ [name]: event.target.value })}
      />
    </label>
  );

  return (
    <form className="crop-form" onSubmit={submit} noValidate>
      <p className="crop-description">{t('crop.description')}</p>
      {signed ? <p className="crop-note">{t('crop.signedNote')}</p> : null}
      <fieldset className="crop-margins">
        <legend>{t('crop.margins')}</legend>
        {marginField('left', 'crop.left')}
        {marginField('top', 'crop.top')}
        {marginField('right', 'crop.right')}
        {marginField('bottom', 'crop.bottom')}
        <label className="crop-field" htmlFor={`${ids}-unit`}>
          <span>{t('crop.unit')}</span>
          <select
            id={`${ids}-unit`}
            value={values.unit}
            onChange={(event) => set({ unit: event.target.value as CropUnit })}
          >
            {UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {t(UNIT_LABELS[unit])}
              </option>
            ))}
          </select>
        </label>
      </fieldset>
      <fieldset className="crop-scope">
        <legend>{t('crop.pages')}</legend>
        <ScopeOption
          name={`${ids}-scope`}
          value="all"
          checked={values.scope === 'all'}
          label={t('crop.pages.all', { count: pageCount })}
          onSelect={() => set({ scope: 'all' })}
        />
        <ScopeOption
          name={`${ids}-scope`}
          value="current"
          checked={values.scope === 'current'}
          label={t('crop.pages.current', { page: currentPage })}
          onSelect={() => set({ scope: 'current' })}
        />
        <label className="crop-scope-option">
          <input
            type="radio"
            name={`${ids}-scope`}
            value="range"
            checked={values.scope === 'range'}
            onChange={() => set({ scope: 'range' })}
          />
          {t('crop.pages.range')}
          <input
            type="text"
            className="crop-range"
            aria-label={t('crop.pages.range')}
            value={values.range}
            onChange={(event) => set({ range: event.target.value, scope: 'range' })}
          />
        </label>
      </fieldset>
      {loadFailed ? (
        <p role="alert" className="crop-error">
          {t('crop.failed')}
        </p>
      ) : null}
      {error !== null ? (
        <p role="alert" className="crop-error">
          {error}
        </p>
      ) : null}
      <div className="crop-actions">
        <button type="submit" disabled={running || sizes === null}>
          {t('crop.apply')}
        </button>
        {onDrawOnPage ? (
          <button type="button" onClick={onDrawOnPage} disabled={running}>
            {t('crop.draw')}
          </button>
        ) : null}
        <button type="button" onClick={onClose} disabled={running}>
          {t('crop.cancel')}
        </button>
      </div>
    </form>
  );
}

interface ScopeOptionProps {
  readonly name: string;
  readonly value: CropScope;
  readonly checked: boolean;
  readonly label: string;
  readonly onSelect: () => void;
}

function ScopeOption({ name, value, checked, label, onSelect }: ScopeOptionProps) {
  return (
    <label className="crop-scope-option">
      <input type="radio" name={name} value={value} checked={checked} onChange={onSelect} />
      {label}
    </label>
  );
}
