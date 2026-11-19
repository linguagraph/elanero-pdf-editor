// The search highlights over one page (W5.4): a rectangle per hit quad, the selected hit in the
// stronger colour. Placed in the page element's CSS pixels, so they follow the zoom with the page.
import type { CSSProperties } from 'react';
import type { HitRect } from './search';
import './search.css';

export interface PageMarksProps {
  readonly rects: readonly HitRect[];
}

export function PageMarks({ rects }: PageMarksProps) {
  return (
    <>
      {rects.map((rect, index) => {
        const style: CSSProperties = {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        };
        return (
          <div
            // The rectangles of a page are drawn as a whole, so their index is a stable key.
            key={index}
            className={rect.current ? 'search-mark search-mark--current' : 'search-mark'}
            style={style}
          />
        );
      })}
    </>
  );
}
