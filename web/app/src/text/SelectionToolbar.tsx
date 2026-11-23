// The mini toolbar beside a text selection (W6.6 section 8): Copy and Translate. It shows while a
// selection has text, and hides when there is none, on a scroll or a resize. Its buttons keep the
// selection (mousedown is not moved to them), so Copy and Translate read the text the user chose.
import { useEffect, useState } from 'react';
import { t } from '../i18n/t';
import type { SelectionSnapshot } from '../translate/runTranslation';
import { anchorRect, placeSpot } from './placement';

export interface SelectionToolbarProps {
  // The selection as it is now, or null when there is no text selected.
  readonly read: () => SelectionSnapshot | null;
  readonly onCopy: (text: string) => void;
  readonly onTranslate: (snapshot: SelectionSnapshot) => void;
}

interface Spot extends SelectionSnapshot {
  readonly top: number;
  readonly left: number;
  readonly above: boolean;
}

export function SelectionToolbar({ read, onCopy, onTranslate }: SelectionToolbarProps) {
  const [spot, setSpot] = useState<Spot | null>(null);
  useEffect(() => {
    const update = () => {
      const snapshot = read();
      const rect = snapshot === null ? null : anchorRect(window.getSelection());
      setSpot(snapshot === null || rect === null ? null : { ...snapshot, ...placeSpot(rect, 200) });
    };
    const hide = () => setSpot(null);
    document.addEventListener('selectionchange', update);
    document.addEventListener('pointerup', update);
    document.addEventListener('keyup', update);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      document.removeEventListener('selectionchange', update);
      document.removeEventListener('pointerup', update);
      document.removeEventListener('keyup', update);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [read]);
  if (spot === null) return null;
  const keepSelection = (event: React.MouseEvent) => event.preventDefault();
  return (
    <div
      role="toolbar"
      aria-label={t('translate.toolbar.label')}
      className="selection-toolbar"
      data-above={spot.above ? 'true' : undefined}
      style={{ top: spot.top, left: spot.left }}
    >
      <button type="button" onMouseDown={keepSelection} onClick={() => onCopy(spot.text)}>
        {t('translate.toolbar.copy')}
      </button>
      <button
        type="button"
        onMouseDown={keepSelection}
        onClick={() => onTranslate({ text: spot.text, areas: spot.areas })}
      >
        {t('translate.toolbar.translate')}
      </button>
    </div>
  );
}
