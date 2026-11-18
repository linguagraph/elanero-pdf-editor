import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { t } from '../i18n/t';
import { BrandMark } from './BrandMark';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(): { host: HTMLDivElement; unmount: () => void } {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(<BrandMark />);
  });
  return {
    host,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('BrandMark', () => {
  it('shows the logo from a same-origin file, with alt text from the catalogue', () => {
    const { host, unmount } = mount();
    try {
      const img = host.querySelector('img');
      expect(img).not.toBeNull();
      expect(img?.getAttribute('src')).toBe('icons/elanero-32.png');
      expect(img?.getAttribute('alt')).toBe(t('brand.logoAlt'));
      expect(img?.getAttribute('alt')).toBe('Elanero logo');
      expect(host.querySelector('.brand')).toBeNull();
    } finally {
      unmount();
    }
  });

  it('shows the wordmark text when the image fails to load', () => {
    const { host, unmount } = mount();
    try {
      const img = host.querySelector('img');
      if (!img) throw new Error('no logo image');
      act(() => {
        img.dispatchEvent(new Event('error'));
      });
      expect(host.querySelector('img')).toBeNull();
      expect(host.querySelector('.brand')?.textContent).toBe('Elanero');
    } finally {
      unmount();
    }
  });
});
