import { useState } from 'react';
import { t } from '../i18n/t';
import { BRAND } from './tokens';

// The top bar brand: the 32 px logo from data/branding, copied to public/icons so it is same-origin
// (the CSP allows only 'self', blob: and data: images). If the image fails to load, the wordmark
// text takes its place, so the header always names the app.
const LOGO_SRC = 'icons/elanero-32.png';

export function BrandMark() {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <span className="brand">{BRAND.name}</span>;
  }
  return (
    <img
      className="brand-logo"
      src={LOGO_SRC}
      alt={t('brand.logoAlt')}
      width={32}
      height={32}
      onError={() => setFailed(true)}
    />
  );
}
