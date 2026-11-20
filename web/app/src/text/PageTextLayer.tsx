// The transparent text layer over one page (W5.4, W1.4 section 10). Each line is a positioned span
// in the page element, so the browser selects and copies the text natively. The spans are not hidden
// from assistive technology: a screen reader reads the page's text from them.
import { useEffect, useMemo, useState } from 'react';
import { type TextLayerCache } from './textLayerCache';
import { placeLines, type TextLine } from './textLayer';
import { SelectionMarks } from './SelectionMarks';
import type { TextSelection } from './textSelection';
import './textLayer.css';

export interface PageTextLayerProps {
  readonly cache: TextLayerCache;
  readonly page: number;
  // The page revision the layer is asked for; a new revision asks the engine again.
  readonly revision: number;
  readonly zoom: number;
  // True while a gesture tool (a comment tool) is on: the layer then lets the pointer through to
  // the tool's layer beneath it and starts no text selection from a drag.
  readonly passive?: boolean;
  // The text selection the model holds, drawn over the page (W5.4 S3). Given (even null), the model
  // is in charge of the page's selection, so the browser's own selection stays off the spans.
  readonly selection?: TextSelection | null;
}

export function PageTextLayer({
  cache,
  page,
  revision,
  zoom,
  passive = false,
  selection,
}: PageTextLayerProps) {
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
  // The page's index arrives with its lines, so the marks are read once the lines are in state.
  const index = selection === undefined ? undefined : cache.readyIndex(page, revision);
  const classes = ['page-text-layer'];
  if (passive) classes.push('page-text-layer--passive');
  if (selection !== undefined) classes.push('page-text-layer--model');
  return (
    <div className={classes.join(' ')}>
      {selection ? (
        <SelectionMarks selection={selection} index={index} page={page} zoom={zoom} />
      ) : null}
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
