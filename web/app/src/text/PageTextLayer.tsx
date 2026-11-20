// The transparent text layer over one page (W5.4, W1.4 section 10). Each line is a positioned span
// in the page element, so the browser selects and copies the text natively. The spans are not hidden
// from assistive technology: a screen reader reads the page's text from them.
import { useEffect, useMemo, useState } from 'react';
import { type TextLayerCache } from './textLayerCache';
import { placeLines, type TextLine } from './textLayer';
import './textLayer.css';

export interface PageTextLayerProps {
  readonly cache: TextLayerCache;
  readonly page: number;
  // The page revision the layer is asked for; a new revision asks the engine again.
  readonly revision: number;
  readonly zoom: number;
}

export function PageTextLayer({ cache, page, revision, zoom }: PageTextLayerProps) {
  const [lines, setLines] = useState<readonly TextLine[]>([]);

  useEffect(() => {
    let active = true;
    cache.get(page, revision).then(
      (next) => {
        if (active) setLines(next);
      },
      () => {
        // No text for this page: the page image still shows, and nothing is selectable.
      },
    );
    return () => {
      active = false;
    };
  }, [cache, page, revision]);

  const placed = useMemo(() => placeLines(lines, zoom), [lines, zoom]);
  return (
    <div className="page-text-layer">
      {placed.map((line, index) => (
        <div
          // The lines of one page never reorder: the key is the line's position.
          key={index}
          data-line={index}
          className="page-text-line"
          style={{
            left: line.left,
            top: line.top,
            width: line.width,
            height: line.height,
            fontSize: line.height,
          }}
        >
          {line.text}
        </div>
      ))}
    </div>
  );
}
