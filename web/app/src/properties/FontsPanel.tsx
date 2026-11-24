// The Fonts tab of the document properties (W7.6): a read-only table of the fonts the pages use.
// PropertiesDialog holds the state and reads the fonts when the tab is first shown.
import { Button } from 'react-aria-components';
import { t } from '../i18n/t';
import type { FontRow } from '../rpc/generated';
import { embeddingLabel, pageRangeText } from './fontsView';
import type { FontsState } from './fonts';

export interface FontsPanelProps {
  state: FontsState;
  onRetry: () => void;
}

export function FontsPanel({ state, onRetry }: FontsPanelProps) {
  if (state.kind === 'idle' || state.kind === 'loading') {
    return (
      <p className="properties-hint" role="status">
        {t('properties.fonts.loading')}
      </p>
    );
  }
  if (state.kind === 'busy') {
    return (
      <div className="properties-fonts-message">
        <p className="properties-hint" role="status">
          {t('properties.fonts.busy')}
        </p>
        <Button className="properties-button" onPress={onRetry}>
          {t('properties.fonts.retry')}
        </Button>
      </div>
    );
  }
  if (state.kind === 'failed') {
    return (
      <p className="properties-message" role="alert">
        {t('properties.fonts.failed')}
      </p>
    );
  }
  if (state.fonts.length === 0) {
    return <p className="properties-hint">{t('properties.fonts.none')}</p>;
  }
  return <FontsTable fonts={state.fonts} />;
}

function FontsTable({ fonts }: { fonts: readonly FontRow[] }) {
  // The region scrolls the wide table on its own, and takes the keyboard for that.
  return (
    <div
      className="properties-fonts"
      role="region"
      aria-label={t('properties.fonts.caption')}
      tabIndex={0}
    >
      <table>
        <caption>{t('properties.fonts.caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('properties.fonts.col.name')}</th>
            <th scope="col">{t('properties.fonts.col.type')}</th>
            <th scope="col">{t('properties.fonts.col.encoding')}</th>
            <th scope="col">{t('properties.fonts.col.embedding')}</th>
            <th scope="col">{t('properties.fonts.col.pages')}</th>
          </tr>
        </thead>
        <tbody>
          {fonts.map((font, index) => (
            <tr key={index}>
              <td>{font.name}</td>
              <td>{font.type}</td>
              <td>{font.encoding}</td>
              <td>{t(embeddingLabel(font))}</td>
              <td>{pageRangeText(font.pages)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
