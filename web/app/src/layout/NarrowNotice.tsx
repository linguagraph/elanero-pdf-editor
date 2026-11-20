import { useState } from 'react';
import { t } from '../i18n/t';
import { useLayoutRegions } from './LayoutContext';

// Kept for the session only: a user who dismissed the notice is not shown it again on reload.
const DISMISSED_KEY = 'elanero.layout.narrowNoticeDismissed';

// Storage can be blocked or full, so every access is guarded; without it the notice is still shown
// for the page view and can still be dismissed for that view.
function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    sessionStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    // The dismissal still holds for this view; a reload may show the notice again.
  }
}

// The notice under the top bar on a phone-width window (W1.6 section 8). It says the layout is made
// for a wider screen and can be dismissed. It must be rendered inside the layout frame.
export function NarrowNotice() {
  const { tier } = useLayoutRegions();
  const [dismissed, setDismissed] = useState(readDismissed);
  if (tier !== 'phone' || dismissed) return null;
  return (
    <div className="narrow-notice" role="status">
      <p className="narrow-notice-text">{t('layout.narrowNotice')}</p>
      <button
        type="button"
        className="narrow-notice-dismiss"
        onClick={() => {
          writeDismissed();
          setDismissed(true);
        }}
      >
        {t('layout.narrowNotice.dismiss')}
      </button>
    </div>
  );
}
