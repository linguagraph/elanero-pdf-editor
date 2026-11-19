// The document properties dialog (W7.6): title, author, subject and keywords to edit, and the
// dates, application and producer read-only. The values come from session.info when the dialog
// opens; Apply runs one document.set_metadata with the changed fields (apply.ts).
import { useEffect, useState } from 'react';
import { Button } from 'react-aria-components';
import type { PageRpc } from '../engine/engineConnection';
import type { MessageId } from '../i18n/en';
import { t } from '../i18n/t';
import { toasts, type ToastStore } from '../feedback/toasts';
import { Overlay } from '../layout/Overlay';
import type { DocInfo } from '../rpc/generated';
import { applyProperties, loadProperties } from './apply';
import {
  EDITABLE_FIELDS,
  type EditableField,
  type EditableValues,
  editableValues,
  MAX_FIELD_LENGTH,
  overLongFields,
} from './metadata';
import './properties.css';

const FIELD_LABEL: Record<EditableField, MessageId> = {
  title: 'properties.field.title',
  author: 'properties.field.author',
  subject: 'properties.field.subject',
  keywords: 'properties.field.keywords',
};

export interface PropertiesDialogProps {
  isOpen: boolean;
  onClose: () => void;
  rpc: PageRpc;
  handle: string;
  // The toast store for the info toast and failures. The app's store by default.
  store?: ToastStore;
}

export function PropertiesDialog({
  isOpen,
  onClose,
  rpc,
  handle,
  store = toasts,
}: PropertiesDialogProps) {
  return (
    <Overlay
      isOpen={isOpen}
      onClose={onClose}
      title={t('properties.title')}
      showCloseButton={false}
    >
      <PropertiesBody rpc={rpc} handle={handle} store={store} onDone={onClose} />
    </Overlay>
  );
}

interface BodyProps {
  rpc: PageRpc;
  handle: string;
  store: ToastStore;
  onDone: () => void;
}

// Mounted each time the dialog opens (the overlay drops its content on close), so the values are
// read afresh every time.
function PropertiesBody({ rpc, handle, store, onDone }: BodyProps) {
  const [info, setInfo] = useState<DocInfo | null>(null);
  const [values, setValues] = useState<EditableValues | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void loadProperties({ rpc, handle, store }).then((next) => {
      if (!live) return;
      if (next === undefined) setLoadFailed(true);
      else {
        setInfo(next);
        setValues(editableValues(next));
      }
    });
    return () => {
      live = false;
    };
  }, [rpc, handle, store]);

  const setField = (field: EditableField, value: string): void => {
    setValues((previous) => (previous === null ? previous : { ...previous, [field]: value }));
  };

  const apply = async (): Promise<void> => {
    if (info === null || values === null || busy) return;
    const tooLong = overLongFields(values);
    if (tooLong.length > 0) {
      const fields = tooLong.map((field) => t(FIELD_LABEL[field])).join(', ');
      setMessage(t('properties.tooLong', { max: MAX_FIELD_LENGTH, fields }));
      return;
    }
    setMessage(null);
    setBusy(true);
    const outcome = await applyProperties({ rpc, handle, store }, info, values);
    if (outcome.status === 'applied' || outcome.status === 'unchanged') {
      onDone();
      return;
    }
    // A failed call has already shown its error toast; the dialog stays open for another try.
    setBusy(false);
  };

  if (loadFailed) {
    return (
      <p className="properties-message" role="alert">
        {t('properties.loadFailed')}
      </p>
    );
  }
  if (info === null || values === null) {
    return (
      <p className="properties-hint" role="status">
        {t('properties.loading')}
      </p>
    );
  }
  const shown = (value: string): string => (value === '' ? t('properties.empty') : value);
  return (
    <div className="properties">
      <div className="properties-fields">
        {EDITABLE_FIELDS.map((field) => (
          <label key={field} className="properties-field">
            <span>{t(FIELD_LABEL[field])}</span>
            <input
              type="text"
              value={values[field]}
              disabled={busy}
              onChange={(event) => setField(field, event.currentTarget.value)}
            />
          </label>
        ))}
      </div>
      <dl className="properties-readonly">
        <dt>{t('properties.created')}</dt>
        <dd>{shown(info.creation_date)}</dd>
        <dt>{t('properties.modified')}</dt>
        <dd>{shown(info.mod_date)}</dd>
        <dt>{t('properties.application')}</dt>
        <dd>{shown(info.creator)}</dd>
        <dt>{t('properties.producer')}</dt>
        <dd>{shown(info.producer)}</dd>
      </dl>
      {message === null ? null : (
        <p className="properties-message" role="alert">
          {message}
        </p>
      )}
      <div className="properties-actions">
        <Button className="properties-button" onPress={onDone}>
          {t('properties.cancel')}
        </Button>
        <Button
          className="properties-button properties-primary"
          isDisabled={busy}
          onPress={() => {
            void apply();
          }}
        >
          {t('properties.apply')}
        </Button>
      </div>
    </div>
  );
}
