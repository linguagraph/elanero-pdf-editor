// The Advanced tab of the document properties (W7.6): the file facts that session.info already
// carries. Every row is read-only text. The PDF version is not an input: no engine call sets it,
// and a save keeps the version the file reported (test_webapi_properties.py).
import type { DocInfo } from '../rpc/generated';
import { t } from '../i18n/t';
import { shownValue, yesNo } from './facts';

export interface AdvancedPanelProps {
  info: DocInfo;
}

export function AdvancedPanel({ info }: AdvancedPanelProps) {
  return (
    <dl className="properties-readonly">
      <dt>{t('properties.version')}</dt>
      <dd>{shownValue(info.pdf_version)}</dd>
      <dt>{t('properties.pages')}</dt>
      <dd>{String(info.page_count)}</dd>
      <dt>{t('properties.tagged')}</dt>
      <dd>{yesNo(info.is_tagged)}</dd>
      <dt>{t('properties.forms')}</dt>
      <dd>{yesNo(info.has_forms)}</dd>
      <dt>{t('properties.signed')}</dt>
      <dd>{yesNo(info.has_signatures)}</dd>
      <dt>{t('properties.javascript')}</dt>
      <dd>{yesNo(info.has_javascript)}</dd>
      <dt>{t('properties.repaired')}</dt>
      <dd>{yesNo(info.is_repaired)}</dd>
      <dt>{t('properties.xmp')}</dt>
      <dd>{yesNo(info.has_xmp)}</dd>
    </dl>
  );
}
