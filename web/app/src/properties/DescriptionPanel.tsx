// The Description tab of the document properties (W7.6): the four editable Info fields and the
// read-only dates, application and producer. The values are held by PropertiesDialog.
import type { DocInfo } from '../rpc/generated';
import { t } from '../i18n/t';
import { FIELD_LABEL, shownValue } from './facts';
import { EDITABLE_FIELDS, type EditableField, type EditableValues } from './metadata';

export interface DescriptionPanelProps {
  info: DocInfo;
  values: EditableValues;
  busy: boolean;
  onField: (field: EditableField, value: string) => void;
}

export function DescriptionPanel({ info, values, busy, onField }: DescriptionPanelProps) {
  return (
    <>
      <div className="properties-fields">
        {EDITABLE_FIELDS.map((field) => (
          <label key={field} className="properties-field">
            <span>{t(FIELD_LABEL[field])}</span>
            <input
              type="text"
              value={values[field]}
              disabled={busy}
              onChange={(event) => onField(field, event.currentTarget.value)}
            />
          </label>
        ))}
      </div>
      <dl className="properties-readonly">
        <dt>{t('properties.created')}</dt>
        <dd>{shownValue(info.creation_date)}</dd>
        <dt>{t('properties.modified')}</dt>
        <dd>{shownValue(info.mod_date)}</dd>
        <dt>{t('properties.application')}</dt>
        <dd>{shownValue(info.creator)}</dd>
        <dt>{t('properties.producer')}</dt>
        <dd>{shownValue(info.producer)}</dd>
      </dl>
    </>
  );
}
